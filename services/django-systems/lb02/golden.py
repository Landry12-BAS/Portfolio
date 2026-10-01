"""LB-02's golden set: scripted conversations, with what a careful concierge does in each.

The set lives in evals/lb02/golden.yaml and was written before any prompt
(docs/PLAYBOOK.md, step 3). Everything in it is graded by rules, never by a model:

- each turn says what the visitor writes, how long they waited first, and what must follow:
  the tools that ran, in order, and the arguments that matter; the tools the state machine
  refused; the step the conversation is in afterwards; the slots on offer and the slot held;
  the receipt, when the reply is one the code writes itself; the language of the reply; and
  text it must never contain;
- the end of the case says where the conversation finished, exactly which bookings it made,
  whether another visitor's hold or booking was left alone, and the most gateway calls it
  may have spent (the datasheet's 6 to 10 for a booking, with room for a changed mind);
- slots are named the way the seed names them: an offering, the day (1 is tomorrow, up to 14)
  and the start time on the roastery's clock, so they stay right as the calendar moves on.

A case can start with other visitors' doing: another visitor who holds or books a slot just
before a turn, which is how the double-booking and "someone else holds it" cases are set up.

The schema checks that each case is consistent with itself: a booking means the conversation
is done, a handoff means it is handed over, and a hold means it is holding.
"""

from pathlib import Path
from typing import Annotated, Literal, Self

from django.conf import settings
from pydantic import Field, StringConstraints, model_validator

from core.data_files import Key, StrictEntry, Text, read_data_file
from lb02.limits import CALENDAR_DAYS_AHEAD, MAX_MESSAGE_LENGTH, MAX_MODEL_CALLS_PER_CONVERSATION, MAX_PARTY_SIZE
from lb02.messages import Receipt
from lb02.models import Conversation, Handoff
from lb02.states import Step, Tool

# A start time on the roastery's clock, such as 14:30.
ClockTime = Annotated[str, StringConstraints(pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")]
# A language as its two-letter ISO 639 code.
Language = Annotated[str, StringConstraints(pattern=r"^[a-z]{2}$")]
# What the visitor types: trimmed, never empty, never longer than the concierge accepts.
VisitorText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_MESSAGE_LENGTH)]
# Text a reply must never contain.
Forbidden = Annotated[str, StringConstraints(min_length=2, max_length=80)]
# The steps a conversation can end a turn in: one, or several when more than one is a right answer.
Steps = Step | Annotated[list[Step], Field(min_length=2)]

# What a case is about. The offline test checks that the set covers every one of them.
type Scenario = Literal[
    "happy_path",
    "gradual_details",
    "missing_details",
    "real_email",
    "capacity",
    "double_booking",
    "shared_room",
    "someone_else_holds",
    "hold_expires",
    "changed_mind",
    "injection",
    "prompt_leak",
    "out_of_scope",
    "handoff",
    "language_switch",
    "no_hold_no_confirm",
]


class SlotRef(StrictEntry):
    """A slot as the seed lays it out: an offering, the day (1 is tomorrow) and the start time in Prague."""

    offering: Key
    day: int = Field(ge=1, le=CALENDAR_DAYS_AHEAD)
    time: ClockTime


class ToolArguments(StrictEntry):
    """The arguments a tool call must have carried. Only the ones listed are checked."""

    offering: Key | None = None
    party_size: int | None = Field(default=None, ge=1, le=MAX_PARTY_SIZE)
    # Part of the name the model recorded, without regard to case: the visitor's first name will do.
    name_contains: str | None = Field(default=None, min_length=2, max_length=60)
    # The search window as days after today, 1 being tomorrow.
    from_day: int | None = Field(default=None, ge=0, le=CALENDAR_DAYS_AHEAD)
    to_day: int | None = Field(default=None, ge=0, le=CALENDAR_DAYS_AHEAD)
    part_of_day: Conversation.PartOfDay | None = None
    reason: Handoff.Reason | None = None


class WorldEvent(StrictEntry):
    """Another visitor, who holds or books a slot just before one of the script's turns."""

    before_turn: int = Field(ge=1)
    other_visitor: Literal["holds", "books"]
    slot: SlotRef
    party_size: int = Field(default=2, ge=1, le=MAX_PARTY_SIZE)


class TurnExpectation(StrictEntry):
    """What must be true after one turn. Leaving `tools` out means any tools may run."""

    # The tools that ran, in order. An empty list means none ran; leaving it out doesn't grade it.
    tools: list[Tool] | None = None
    # The tools the model asked for that the state machine refused. A turn that refuses nothing says nothing.
    refused: list[Tool] = Field(default_factory=list)
    args: dict[Tool, ToolArguments] = Field(default_factory=dict)
    step: Steps
    # The kind of message the concierge's code wrote, when the reply is one of those.
    receipt: Receipt | None = None
    offers: list[SlotRef] = Field(default_factory=list)
    not_offered: list[SlotRef] = Field(default_factory=list)
    # The slot the conversation holds afterwards, or "none". Leaving it out doesn't grade it.
    hold: SlotRef | Literal["none"] | None = None
    reply_language: Language | None = None
    never: list[Forbidden] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_consistent(self) -> Self:
        """Require arguments only for tools that ran, and a held slot only in a step that holds one."""
        ran = set(self.tools or [])
        for tool in self.args:
            if self.tools is not None and tool not in ran:
                raise ValueError(f"arguments are checked for {tool}, which doesn't run in this turn")
        steps = self.step if isinstance(self.step, list) else [self.step]
        if isinstance(self.hold, SlotRef) and steps != [Step.HOLD]:
            raise ValueError("a slot can only be held in the hold step")
        if self.hold == "none" and Step.HOLD in steps and len(steps) == 1:
            raise ValueError("the hold step holds a slot")
        return self


class Turn(StrictEntry):
    """One visitor message: how long the visitor waited first, what they wrote, and what must follow."""

    say: VisitorText
    # Minutes that pass before the visitor writes, which is how a hold is made to run out.
    wait_minutes: int = Field(default=0, ge=0, le=60)
    expect: TurnExpectation


class BookingExpectation(StrictEntry):
    """A booking the conversation must have made."""

    slot: SlotRef
    party_size: int = Field(ge=1, le=MAX_PARTY_SIZE)


class EndState(StrictEntry):
    """Where a case must finish."""

    step: Steps
    # Exactly these bookings, and no others, by this conversation.
    bookings: list[BookingExpectation] = Field(default_factory=list, max_length=1)
    hold: SlotRef | Literal["none"] = "none"
    # The reason the conversation was handed over, one or several when more than one is a right answer.
    handoff: Handoff.Reason | list[Handoff.Reason] | None = None
    # Whether the other visitors' holds and bookings are still exactly as the script left them.
    others_intact: bool = True
    # The most gateway calls the whole conversation may have used.
    calls_at_most: int = Field(ge=0, le=MAX_MODEL_CALLS_PER_CONVERSATION)

    @model_validator(mode="after")
    def _check_consistent(self) -> Self:
        """Tie bookings to a finished conversation, a hold to the hold step and a handoff to a handed-over one."""
        steps = self.step if isinstance(self.step, list) else [self.step]
        if self.bookings and steps != [Step.DONE]:
            raise ValueError("a conversation that made a booking ends in the done step")
        if Step.DONE in steps and len(steps) == 1 and not self.bookings:
            raise ValueError("the done step means a booking was made: list it")
        if self.handoff is not None and Step.HANDOFF not in steps:
            raise ValueError("a handoff reason needs the handoff step among the steps the case may end in")
        if Step.HANDOFF in steps and len(steps) == 1 and self.handoff is None:
            raise ValueError("say why the conversation was handed over (handoff)")
        if isinstance(self.hold, SlotRef) and steps != [Step.HOLD]:
            raise ValueError("a conversation that holds a slot ends in the hold step")
        return self


class GoldenCase(StrictEntry):
    """One scripted conversation, and what a careful concierge does in it."""

    id: Key
    covers: list[Scenario] = Field(min_length=1)
    # The language the visitor writes in, which every receipt must then be written in.
    language: Language
    # Curated samples open the live demo, and their recorded runs are replayed.
    sample: bool = False
    # What the case proves, for people reading the file.
    note: Text
    world: list[WorldEvent] = Field(default_factory=list)
    turns: list[Turn] = Field(min_length=1, max_length=30)
    end: EndState

    @model_validator(mode="after")
    def _check_script(self) -> Self:
        """Place every world event inside the script, and end where the last turn ends."""
        for event in self.world:
            if event.before_turn > len(self.turns):
                raise ValueError(
                    f"a world event happens before turn {event.before_turn}, but there are only {len(self.turns)}"
                )
        last = self.turns[-1].expect.step
        last_steps = last if isinstance(last, list) else [last]
        end_steps = self.end.step if isinstance(self.end.step, list) else [self.end.step]
        if not set(end_steps) <= set(last_steps):
            raise ValueError("the case ends in a step its last turn doesn't allow")
        return self


class GoldenSet(StrictEntry):
    """The whole of golden.yaml: between 20 and 50 cases, as the playbook asks."""

    cases: list[GoldenCase] = Field(min_length=20, max_length=50)

    @model_validator(mode="after")
    def _check_cases(self) -> Self:
        """Refuse a repeated case ID, and require curated samples in English and in Czech."""
        seen: set[str] = set()
        for case in self.cases:
            if case.id in seen:
                raise ValueError(f"case {case.id!r} appears more than once")
            seen.add(case.id)
        sample_languages = {case.language for case in self.cases if case.sample}
        if not {"en", "cs"} <= sample_languages:
            raise ValueError("the curated samples must include conversations in English and in Czech")
        return self

    def samples(self) -> list[GoldenCase]:
        """Return the curated samples the live demo opens on."""
        return [case for case in self.cases if case.sample]


def read_golden_set(path: Path | None = None) -> GoldenSet:
    """Read and check the golden set, by default evals/lb02/golden.yaml."""
    return read_data_file(path or settings.EVALS_DIR / "lb02" / "golden.yaml", GoldenSet)
