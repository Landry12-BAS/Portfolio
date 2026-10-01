"""Grading LB-02's concierge on the golden set, by rules alone.

Each golden case is a scripted conversation. It is played turn by turn through the real concierge as
synthetic data, on a clock this module holds, so a hold can be made to run out without anyone waiting.
Before the turns the script names, other visitors hold or book slots, which is how the double-booking
cases are set up.

After every turn the result is graded against what evals/lb02/golden.yaml expects: the tools that ran,
in order, and the arguments that matter; the tools the state machine refused; the step; the slots on
offer and the slot held; the receipt, when the reply is one the code writes; the language of the reply;
and text it must never contain. After the last turn the end is graded: the step, exactly which bookings
the conversation made, the hold, the handoff and the transcript it carries, whether the other visitors'
reservations were left alone, and the gateway calls spent.

Every case is rolled back afterwards, so an eval leaves no data behind. A live eval costs about eight
gateway calls a case (a full run at most 247, the sum of the cases' own ceilings), so run it when
prompts or routes change, not on every commit.
"""

from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Literal, Protocol

from django.db import transaction

from lb02.booking import DATABASE, local_day
from lb02.concierge import Concierge, TurnResult
from lb02.conversations import current_step, start_conversation
from lb02.golden import GoldenCase, GoldenSet, SlotRef, ToolArguments, TurnExpectation, WorldEvent
from lb02.languages import detect
from lb02.messages import NO_BREAK_SPACE
from lb02.models import ROASTERY_TIME_ZONE, Conversation, Handoff, Message, Reservation, Slot
from lb02.states import Tool

# The session every eval conversation is started under, followed by the case's ID: one per case, so no case
# runs into a visitor's limit of ten conversations a day.
EVAL_SESSION = "golden-set-eval-"
# The session of an eval's other visitors.
OTHER_SESSION = "golden-set-other-visitor-"
# What an other visitor's reservation is called in a failure message.
NOUNS = {"holds": "hold", "books": "booking"}


class MovableClock(Protocol):
    """A clock the eval can move forward: the concierge reads it, and a turn that waits advances it."""

    def __call__(self) -> datetime:
        """Return the clock's current moment."""
        ...

    def advance(self, minutes: float) -> None:
        """Move the clock forward."""
        ...


class EvalClock:
    """The clock an eval holds: it stands still until the script says time passes, which makes a hold run out."""

    def __init__(self, start: datetime) -> None:
        """Start at `start`, which is a timezone-aware moment."""
        self.now = start

    def __call__(self) -> datetime:
        """Return the clock's current moment."""
        return self.now

    def advance(self, minutes: float) -> None:
        """Move the clock forward."""
        self.now += timedelta(minutes=minutes)


class EvalSetupError(Exception):
    """A case names something the calendar doesn't have, such as a slot: `just seed` lays the calendar out."""


@dataclass(frozen=True)
class CaseGrade:
    """One golden case's grade: every expectation it missed, and what the conversation cost."""

    case_id: str
    failures: list[str]
    calls: int
    booked: bool

    @property
    def passed(self) -> bool:
        """Tell whether the case met every expectation."""
        return not self.failures


@dataclass(frozen=True)
class EvalReport:
    """The grades of one eval run."""

    grades: list[CaseGrade]

    def pass_rate(self) -> float:
        """Return the share of cases that met every expectation."""
        return sum(grade.passed for grade in self.grades) / len(self.grades) if self.grades else 0.0

    def failures_by_check(self) -> Counter[str]:
        """Count the failures by the check that failed, such as `tools` or `receipt`."""
        return Counter(failure.split(":", 1)[0] for grade in self.grades for failure in grade.failures)

    def total_calls(self) -> int:
        """Return the gateway calls the whole run spent."""
        return sum(grade.calls for grade in self.grades)

    def calls_per_booking(self) -> tuple[int, int, float] | None:
        """Return the fewest, the most and the average gateway calls of the conversations that made a booking.

        These are what the datasheet's "model calls per booking" is measured from; it stays an estimate until a
        live run has produced them. None when no conversation booked.
        """
        costs = [grade.calls for grade in self.grades if grade.booked]
        return (min(costs), max(costs), sum(costs) / len(costs)) if costs else None


@dataclass(frozen=True)
class OtherVisitor:
    """A reservation another visitor made before a turn, to check at the end that it was left alone."""

    conversation_id: int
    slot_id: int
    kind: Literal["holds", "books"]


def evaluate(
    golden: GoldenSet, concierge: Concierge, clock: MovableClock, case_ids: Iterable[str] | None = None
) -> EvalReport:
    """Run golden cases through the concierge and grade them, rolling everything back afterwards.

    Runs every case, or only those in `case_ids`. The concierge must have been built on `clock`.
    """
    wanted = set(case_ids) if case_ids is not None else None
    cases = [case for case in golden.cases if wanted is None or case.id in wanted]
    with transaction.atomic(using=DATABASE):
        grades = [run_case(case, concierge, clock) for case in cases]
        transaction.set_rollback(True, using=DATABASE)
    return EvalReport(grades)


def run_case(case: GoldenCase, concierge: Concierge, clock: MovableClock) -> CaseGrade:
    """Play one case inside a savepoint that is rolled back, so no case leaves a slot held for the next."""
    with transaction.atomic(using=DATABASE):
        grade = play(case, concierge, clock)
        transaction.set_rollback(True, using=DATABASE)
    return grade


def play(case: GoldenCase, concierge: Concierge, clock: MovableClock) -> CaseGrade:
    """Play a case's script turn by turn, grading each turn, then grade where the conversation ended."""
    today = local_day(clock())
    conversation = start_conversation(f"{EVAL_SESSION}{case.id}", clock())
    others: list[OtherVisitor] = []
    failures: list[str] = []
    for number, turn in enumerate(case.turns, start=1):
        for event in case.world:
            if event.before_turn == number:
                others.append(lay_in(case, event, len(others), concierge, today))
        clock.advance(turn.wait_minutes)
        result = concierge.take_turn(conversation, turn.say, data_class="synthetic")
        failures += turn_failures(number, turn.expect, result, today)
    failures += end_failures(case, conversation, concierge, others, today)
    conversation.refresh_from_db()
    booked = Reservation.objects.filter(conversation=conversation, status=Reservation.Status.BOOKED).exists()
    return CaseGrade(case_id=case.id, failures=failures, calls=conversation.model_calls, booked=booked)


# The calendar's slots, and the other visitors


def slot_named(ref: SlotRef, today: date) -> Slot:
    """Find the slot a case names: an offering, the day (1 is tomorrow) and the start time on the roastery's clock."""
    day = today + timedelta(days=ref.day)
    hour, minute = (int(part) for part in ref.time.split(":"))
    starts_at = datetime.combine(day, time(hour, minute), tzinfo=ROASTERY_TIME_ZONE)
    slot = (
        Slot.objects.select_related("offering").filter(offering__key=ref.offering, during__startswith=starts_at).first()
    )
    if slot is None:
        raise EvalSetupError(f"The calendar has no {ref.offering} slot on {day} at {ref.time}.")
    return slot


def lay_in(case: GoldenCase, event: WorldEvent, number: int, concierge: Concierge, today: date) -> OtherVisitor:
    """Have another visitor hold, or hold and book, the slot a world event names, as their own conversation."""
    slot = slot_named(event.slot, today)
    session = f"{OTHER_SESSION}{case.id}-{number}"
    other = start_conversation(session, concierge.clock())
    other.offering, other.party_size = slot.offering, event.party_size
    other.guest_name, other.guest_email = "Other Visitor", "other@example.test"
    other.save()
    held = concierge.bookings.place_hold(other, slot)
    if event.other_visitor == "books":
        concierge.bookings.confirm_hold(other, f"confirm-{held.reservation.code}")
    return OtherVisitor(other.pk, slot.pk, event.other_visitor)


# Grading a turn


def turn_failures(number: int, expect: TurnExpectation, result: TurnResult, today: date) -> list[str]:
    """Grade one turn against what the golden set expects of it."""
    return [
        *tool_failures(number, expect, result),
        *argument_failures(number, expect, result, today),
        *state_failures(number, expect, result, today),
        *reply_failures(number, expect, result),
    ]


def tool_failures(number: int, expect: TurnExpectation, result: TurnResult) -> list[str]:
    """Check which tools ran, in order, and which the state machine refused."""
    ran = [outcome.tool for outcome in result.tools if outcome.executed]
    refused = [outcome.tool for outcome in result.tools if not outcome.executed]
    failures: list[str] = []
    if expect.tools is not None and ran != tool_names(expect.tools):
        failures.append(f"tools: turn {number}: expected {tool_names(expect.tools) or 'none'}, ran {ran or 'none'}")
    if refused != tool_names(expect.refused):
        failures.append(
            f"refused: turn {number}: expected {tool_names(expect.refused) or 'none'} to be refused, "
            f"got {refused or 'none'}"
        )
    return failures


def tool_names(tools: Iterable[Tool]) -> list[str]:
    """Write tools as the names the model calls them by."""
    return [tool.value for tool in tools]


def argument_failures(number: int, expect: TurnExpectation, result: TurnResult, today: date) -> list[str]:
    """Check the arguments that matter of each tool the golden set lists them for."""
    failures: list[str] = []
    for tool, wanted in expect.args.items():
        call = next((outcome for outcome in result.tools if outcome.executed and outcome.tool == tool.value), None)
        if call is None:
            failures.append(f"args: turn {number}: {tool.value} didn't run, so its arguments can't be checked")
            continue
        failures += [
            f"args: turn {number}: {tool.value} {problem}" for problem in mismatches(wanted, call.arguments, today)
        ]
    return failures


def mismatches(wanted: ToolArguments, given: dict[str, object], today: date) -> list[str]:
    """Compare the arguments a call carried with those a case wants, and say how each one that differs differs."""
    problems: list[str] = []
    for field in ("offering", "party_size", "part_of_day", "reason"):
        expected = getattr(wanted, field)
        if expected is not None and given.get(field) != expected:
            problems.append(f"{field}: expected {expected}, got {given.get(field)}")
    if (
        wanted.name_contains is not None
        and wanted.name_contains.casefold() not in str(given.get("name", "")).casefold()
    ):
        problems.append(f"name: expected one containing {wanted.name_contains}, got {given.get('name')}")
    for field, key in (("from_day", "date_from"), ("to_day", "date_to")):
        expected_day = getattr(wanted, field)
        if expected_day is not None and days_from(today, given.get(key)) != expected_day:
            problems.append(f"{key}: expected day {expected_day}, got {given.get(key)}")
    return problems


def days_from(today: date, iso_date: object) -> int | None:
    """Count the days from today to an ISO date a call carried, or None when it carried none."""
    return (date.fromisoformat(iso_date) - today).days if isinstance(iso_date, str) else None


def state_failures(number: int, expect: TurnExpectation, result: TurnResult, today: date) -> list[str]:
    """Check the step, the receipt, the slots on offer and the slot held."""
    failures: list[str] = []
    allowed = expect.step if isinstance(expect.step, list) else [expect.step]
    if result.step not in allowed:
        failures.append(f"step: turn {number}: expected {' or '.join(allowed)}, got {result.step}")
    if expect.receipt is not None and result.receipt != expect.receipt:
        failures.append(f"receipt: turn {number}: expected {expect.receipt}, got {result.receipt or 'none'}")
    on_offer = {option.slot_id for option in result.options}
    for ref in expect.offers:
        if slot_named(ref, today).pk not in on_offer:
            failures.append(f"offers: turn {number}: {describe(ref)} wasn't on offer")
    for ref in expect.not_offered:
        if slot_named(ref, today).pk in on_offer:
            failures.append(f"not_offered: turn {number}: {describe(ref)} was on offer")
    failures += hold_failures(f"turn {number}", expect.hold, result, today)
    return failures


def hold_failures(where: str, expected: SlotRef | Literal["none"] | None, result: TurnResult, today: date) -> list[str]:
    """Check the slot the conversation holds: a named one, or none."""
    if expected is None:
        return []
    held = result.hold.slot_id if result.hold else None
    wanted = None if expected == "none" else slot_named(expected, today).pk
    if held != wanted:
        return [f"hold: {where}: expected {'none' if wanted is None else describe(expected)}, got {held or 'none'}"]
    return []


def describe(ref: SlotRef | Literal["none"]) -> str:
    """Write a slot reference the way the golden set does."""
    return "none" if ref == "none" else f"{ref.offering} on day {ref.day} at {ref.time}"


def reply_failures(number: int, expect: TurnExpectation, result: TurnResult) -> list[str]:
    """Check the language of the reply, and that it holds none of the text it must never contain."""
    failures: list[str] = []
    if expect.reply_language is not None:
        detected = detect(result.reply)
        got = detected.language if detected else None
        if got != expect.reply_language:
            failures.append(
                f"language: turn {number}: expected {expect.reply_language}, the reply reads as {got or 'nothing'}"
            )
    readable = result.reply.replace(NO_BREAK_SPACE, " ").casefold()
    leaked = [text for text in expect.never if text.casefold() in readable]
    if leaked:
        failures.append(f"never: turn {number}: the reply contains {', '.join(leaked)}")
    return failures


# Grading the end


def end_failures(
    case: GoldenCase, conversation: Conversation, concierge: Concierge, others: list[OtherVisitor], today: date
) -> list[str]:
    """Grade where the conversation ended: step, bookings, hold, handoff, the others' reservations and the calls."""
    end = case.end
    conversation.refresh_from_db()
    failures: list[str] = []
    step = current_step(conversation, concierge.bookings)
    allowed = end.step if isinstance(end.step, list) else [end.step]
    if step not in allowed:
        failures.append(f"end: expected the step {' or '.join(allowed)}, got {step}")
    failures += booking_failures(case, conversation, today)
    hold = concierge.bookings.current_hold(conversation)
    wanted_hold = None if end.hold == "none" else slot_named(end.hold, today).pk
    if (hold.slot_id if hold else None) != wanted_hold:
        failures.append(f"hold: end: expected {describe(end.hold)}, got {hold.slot_id if hold else 'none'}")
    failures += handoff_failures(case, conversation)
    if end.others_intact:
        failures += other_failures(others)
    if conversation.model_calls > end.calls_at_most:
        failures.append(f"calls: {conversation.model_calls} gateway calls, at most {end.calls_at_most}")
    return failures


def booking_failures(case: GoldenCase, conversation: Conversation, today: date) -> list[str]:
    """Check that the conversation made exactly the bookings the case lists, and no others."""
    made = sorted(
        (booking.slot_id, booking.party_size)
        for booking in Reservation.objects.filter(conversation=conversation, status=Reservation.Status.BOOKED)
    )
    wanted = sorted((slot_named(booking.slot, today).pk, booking.party_size) for booking in case.end.bookings)
    if made != wanted:
        return [f"bookings: expected {wanted or 'none'}, the conversation made {made or 'none'}"]
    return []


def handoff_failures(case: GoldenCase, conversation: Conversation) -> list[str]:
    """Check a handoff, if there was one: its reason, and that its transcript is every line of the conversation.

    Whether a handoff was right at all is the step's check; this checks that the one that happened was the
    right kind, and complete.
    """
    handoff = Handoff.objects.filter(conversation=conversation).first()
    if handoff is None:
        return []
    failures: list[str] = []
    expected = case.end.handoff
    if expected is not None and handoff.reason not in (expected if isinstance(expected, list) else [expected]):
        failures.append(f"handoff: expected {describe_reasons(expected)}, got {handoff.reason}")
    carried = sorted(line["position"] for line in handoff.transcript)
    said = sorted(Message.objects.filter(conversation=conversation).values_list("position", flat=True))
    if carried != said:
        failures.append(f"handoff: the transcript carries {len(carried)} lines, the conversation has {len(said)}")
    return failures


def describe_reasons(reasons: Handoff.Reason | list[Handoff.Reason]) -> str:
    """Write one handoff reason, or several, for a failure message."""
    return " or ".join(reasons if isinstance(reasons, list) else [reasons])


def other_failures(others: list[OtherVisitor]) -> list[str]:
    """Check that every other visitor's reservation is where the script left it: not released, not moved.

    A hold of theirs that ran out by itself is fine; one that is gone any other way is not.
    """
    failures: list[str] = []
    for other in others:
        reservation = Reservation.objects.filter(conversation_id=other.conversation_id).first()
        allowed = (
            [Reservation.Status.BOOKED]
            if other.kind == "books"
            else [Reservation.Status.HELD, Reservation.Status.EXPIRED]
        )
        if reservation is None or reservation.slot_id != other.slot_id or reservation.status not in allowed:
            status = reservation.status if reservation else "missing"
            failures.append(
                f"others: another visitor's {NOUNS[other.kind]} on slot {other.slot_id} was changed (now {status})"
            )
    return failures
