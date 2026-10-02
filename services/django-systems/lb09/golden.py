"""LB-09's golden set: the decisions and actions planted in the scripted meetings, and how each is graded.

The set lives in evals/lb09/golden.yaml and was written before any prompt (docs/PLAYBOOK.md, step 3). It
says, for each meeting in data/seed/lb09, what a careful extractor finds: every decision and action with the
owner and deadline it states, the turns it is said in, and the words that must not show up anywhere. Everything
is graded by rules, never by a model:

- an extracted item is the expected one when its text holds every word of `match` (lb09/textnorm.py);
- an action's owner must be one of the names the golden set accepts, and its deadline must hold the expected
  word; where the golden set says nobody was given the job or no day was named, they must be empty: the
  extractor may not invent either. A speaker nobody names is a label, "Speaker 2", and is a fair owner;
- every extracted item's evidence must be in the transcript, checked again here, apart from the pipeline;
- an item's time span must lie inside the turns it is said in, give or take a second;
- no item may hold what `forbidden` lists, such as a joke or an instruction to the assistant;
- speaker labels: a speaker who says their own name may be called by it and nobody else may be, and the labels
  must put the same speaker's turns together and different speakers' apart.

The schema checks one case; `check_against_scripts` checks the set against the scripts it points at, so the
two cannot drift apart: every turn it names exists and says what the golden set says it does.
"""

from collections import Counter
from pathlib import Path
from typing import Annotated, Self

from django.conf import settings
from pydantic import Field, StringConstraints, field_validator, model_validator

from core.data_files import Key, StrictEntry, read_data_file
from lb09.scripts import Script
from lb09.textnorm import fold, has_all_words

# A word an extracted item's text must hold: one lowercase word, such as `colombian`.
MatchWord = Annotated[str, StringConstraints(pattern=r"^[a-z0-9]+$", max_length=24)]
# A person's name, or a word of a deadline, as the golden set writes it: compared without case.
Short = Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=30)]
# A sentence a careful extractor would quote.
Quote = Annotated[str, StringConstraints(strip_whitespace=True, min_length=10, max_length=300)]
# What a case covers, as a short tag such as `no_actions`.
Tag = Annotated[str, StringConstraints(pattern=r"^[a-z0-9_]+$", max_length=40)]
# An item worded as an extractor would write it.
Summary = Annotated[str, StringConstraints(strip_whitespace=True, min_length=5, max_length=120)]
# A reason in words, for a person reading the file.
Reason = Annotated[str, StringConstraints(strip_whitespace=True, min_length=10, max_length=300)]


class ExpectedItem(StrictEntry):
    """A decision or action the meeting holds: its turns, a quotable sentence and the key words that find it."""

    id: Key
    summary: Summary
    said_in: list[int] = Field(min_length=1, max_length=4)
    quote: Quote
    match: list[MatchWord] = Field(min_length=1, max_length=4)

    @model_validator(mode="after")
    def _check_turns(self) -> Self:
        """Refuse a turn listed twice, or a negative one."""
        if len(set(self.said_in)) != len(self.said_in) or min(self.said_in) < 0:
            raise ValueError("said_in lists each turn once, counting from 0")
        return self


class ExpectedAction(ExpectedItem):
    """An action: also who does it, and by when. Null for either says the meeting named nobody and no day.

    The owner is one name, or a list of names that are each right: a person who is only addressed by name
    can be called that or by the label the labelling gives their voice.
    """

    owner: list[Short] | None
    deadline: Short | None

    @field_validator("owner", mode="before")
    @classmethod
    def _owner_may_be_one_name(cls, owner: object) -> object:
        """Let the file write a single name without brackets."""
        return [owner] if isinstance(owner, str) else owner


class Forbidden(StrictEntry):
    """Text no extracted item may hold: all of `contains`, unless it also holds any of `unless`."""

    id: Key
    contains: list[MatchWord] = Field(min_length=1, max_length=4)
    unless: list[MatchWord] = Field(default_factory=list, max_length=4)
    why: Reason


class Expectation(StrictEntry):
    """What a careful extractor finds in one meeting."""

    introduced: list[Key]
    decisions: list[ExpectedItem]
    actions: list[ExpectedAction]
    forbidden: list[Forbidden] = Field(default_factory=list)


class GoldenCase(StrictEntry):
    """One scripted meeting, and what it should yield."""

    id: Key
    meeting: Key
    # Curated samples open the live demo, and their recorded runs are replayed.
    sample: bool = False
    covers: list[Tag] = Field(min_length=1)
    # False where a stretch of speech has more than one voice in it, so one label cannot be right.
    grade_labels: bool = True
    note: Reason
    expect: Expectation

    def items(self) -> list[ExpectedItem]:
        """Return every expected decision and action."""
        return [*self.expect.decisions, *self.expect.actions]


class Gate(StrictEntry):
    """The share of each check the live pipeline must reach: targets chosen before any run, not measurements."""

    recall: float = Field(gt=0.0, le=1.0)
    precision: float = Field(gt=0.0, le=1.0)
    owner: float = Field(gt=0.0, le=1.0)
    deadline: float = Field(gt=0.0, le=1.0)
    span: float = Field(gt=0.0, le=1.0)
    labels: float = Field(gt=0.0, le=1.0)


class GoldenSet(StrictEntry):
    """The whole of golden.yaml: the gate, and between 6 and 50 cases."""

    gate: Gate
    cases: list[GoldenCase] = Field(min_length=6, max_length=50)

    @model_validator(mode="after")
    def _check_cases(self) -> Self:
        """Refuse a case ID or a meeting used twice, and require samples."""
        for what, values in (
            ("case ID", [case.id for case in self.cases]),
            ("meeting", [case.meeting for case in self.cases]),
        ):
            repeated = sorted(value for value, count in Counter(values).items() if count > 1)
            if repeated:
                raise ValueError(f"a {what} is used more than once: {', '.join(repeated)}")
        if not any(case.sample for case in self.cases):
            raise ValueError("at least one case is a curated sample")
        return self

    def samples(self) -> list[GoldenCase]:
        """Return the curated samples the live demo opens on."""
        return [case for case in self.cases if case.sample]

    def case(self, case_id: str) -> GoldenCase:
        """Return the case with this ID."""
        for case in self.cases:
            if case.id == case_id:
                return case
        raise KeyError(case_id)


def read_golden_set(path: Path | None = None) -> GoldenSet:
    """Read and check the golden set, by default evals/lb09/golden.yaml."""
    return read_data_file(path or settings.EVALS_DIR / "lb09" / "golden.yaml", GoldenSet)


# How a speaker says their own name: the phrases a label may be inferred from. Used by the labelling step too.
INTRODUCTIONS = ("this is", "i am", "i m", "my name is", "call me", "name s")


def introduces_themselves(text: str, name: str) -> bool:
    """Tell whether a turn is a speaker giving their own name: "this is Hannah", "I'm David", "Peter here"."""
    folded, who = fold(text), fold(name)
    spoken = f" {folded} "
    if any(f" {phrase} {who} " in spoken for phrase in INTRODUCTIONS):
        return True
    return any(f" {who} {tail} " in spoken for tail in ("here", "speaking"))


def expected_labels(case: GoldenCase, script: Script) -> dict[str, str]:
    """Return the label each speaker should get: their name if they say it, else "Speaker N" by order of first word.

    The speakers who stay unnamed are numbered from 1 in the order they first speak, whatever the named ones do.
    """
    introduced = set(case.expect.introduced)
    labels: dict[str, str] = {}
    unnamed = 0
    for turn in script.turns:
        if turn.speaker in labels:
            continue
        if turn.speaker in introduced:
            labels[turn.speaker] = script.speaker(turn.speaker).name
        else:
            unnamed += 1
            labels[turn.speaker] = f"Speaker {unnamed}"
    return labels


def check_against_scripts(golden: GoldenSet, scripts: dict[str, Script]) -> list[str]:
    """Return every way the golden set and the scripts disagree, each as a sentence; none means they agree."""
    problems: list[str] = []
    used = {case.meeting for case in golden.cases}
    problems += [f"the script {key} has no case in the golden set" for key in sorted(set(scripts) - used)]
    for case in golden.cases:
        script = scripts.get(case.meeting)
        if script is None:
            problems.append(f"{case.id}: there is no script called {case.meeting}")
            continue
        problems += check_case(case, script)
    return problems


def check_case(case: GoldenCase, script: Script) -> list[str]:
    """Check one case against its script: that what it plants is really said, in the turns it names."""
    problems = check_cast(case, script)
    for item in case.items():
        problems += check_item(case, script, item)
    for action in case.expect.actions:
        problems += check_action(case, script, action)
    for rule in case.expect.forbidden:
        spoken = " ".join(turn.text for turn in script.turns)
        if not has_all_words(spoken, rule.contains):
            problems.append(
                f"{case.id}: no script turn holds {', '.join(rule.contains)}, so {rule.id} guards against nothing"
            )
    return problems


def check_cast(case: GoldenCase, script: Script) -> list[str]:
    """Check who may be called by name: exactly the speakers who say their own name, and they do."""
    problems: list[str] = []
    ids = {speaker.id for speaker in script.speakers}
    unknown = set(case.expect.introduced) - ids
    if unknown:
        problems.append(f"{case.id}: introduced names speakers who are not in the cast: {', '.join(sorted(unknown))}")
    for speaker in script.speakers:
        says_name = any(
            introduces_themselves(turn.text, speaker.name) for turn in script.turns if turn.speaker == speaker.id
        )
        listed = speaker.id in case.expect.introduced
        if says_name and not listed:
            problems.append(f"{case.id}: {speaker.id} says their own name but is not in introduced")
        if listed and not says_name:
            problems.append(f"{case.id}: {speaker.id} is in introduced but never says their own name")
    return problems


def check_item(case: GoldenCase, script: Script, item: ExpectedItem) -> list[str]:
    """Check that an expected item's turns exist, hold its quote and hold its key words."""
    where = f"{case.id}/{item.id}"
    if max(item.said_in) >= len(script.turns):
        return [f"{where}: said_in names a turn the script does not have"]
    said = " ".join(script.turns[turn].text for turn in item.said_in)
    problems: list[str] = []
    if fold(item.quote) not in fold(said):
        problems.append(f"{where}: the quote is not in the turns it is said in")
    if not has_all_words(said, list(item.match)):
        problems.append(f"{where}: the turns it is said in do not hold every match word")
    if not has_all_words(item.summary, list(item.match)):
        problems.append(f"{where}: the summary does not hold every match word")
    return problems


def check_action(case: GoldenCase, script: Script, action: ExpectedAction) -> list[str]:
    """Check that an action's owner and deadline are really in the meeting: said near it, or the label of who speaks."""
    where = f"{case.id}/{action.id}"
    if max(action.said_in) >= len(script.turns):
        return []
    # A deadline or a name may come in the turn before or after the request, so the turns either side count.
    nearby_turns = range(max(0, min(action.said_in) - 1), min(len(script.turns), max(action.said_in) + 2))
    nearby = fold(" ".join(script.turns[turn].text for turn in nearby_turns))
    labels = expected_labels(case, script)
    speakers = {fold(labels[script.turns[turn].speaker]) for turn in nearby_turns}
    problems: list[str] = []
    if action.deadline is not None and fold(action.deadline) not in nearby:
        problems.append(f"{where}: the deadline {action.deadline!r} is not said near the action")
    if action.owner is not None and not any(fold(name) in nearby or fold(name) in speakers for name in action.owner):
        problems.append(f"{where}: none of the owners {action.owner} is named, or speaks, near the action")
    return problems
