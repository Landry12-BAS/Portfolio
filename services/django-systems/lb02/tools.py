"""LB-02's tools: what the concierge's model can ask the service to do, with every request checked first.

A model's tool call is a name and a string it wrote. Nothing in it is trusted:

1. The name must be a tool this step of the conversation accepts (lb02/states.py). A call to
   anything else, `confirm_booking` before a slot is held for one, is refused and recorded as
   refused, and changes nothing.
2. The arguments must parse and validate against the tool's Pydantic schema, which forbids
   fields it doesn't define. A malformed call earns an error naming the fields, never a guess.
3. The tool then works only from the conversation's own facts. `hold_slot` takes an option
   number from the conversation's latest list of slots on offer, not a slot ID, so it can hold
   nothing that wasn't offered; `confirm_booking` takes no arguments, so it confirms the hold
   this conversation has, and nobody else's. The database refuses the rest (lb02/booking.py).

Each tool answers with a small JSON object for the model to read: what it did, or an error
code and what the model can do instead. Some answers carry a receipt, the kind of message
the code writes itself (lb02/messages.py), so a hold or a booking is stated from the
database's facts and costs no further model call.
"""

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Annotated, Any, Final, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError, model_validator

from core.tool_chat import ToolCall
from lb02.booking import BookingError, BookingService, Clock, Refusal, bookable_days
from lb02.confirmation import record_confirmation
from lb02.conversations import record, sync_step
from lb02.handoff import hand_over
from lb02.limits import MAX_OPTIONS, MAX_PARTY_SIZE
from lb02.messages import Receipt, guests, when_text
from lb02.models import Conversation, Handoff, Offering, Reservation, Slot
from lb02.states import Tool, tool_accepted
from lb_common.tracing import Tracer

# A visitor's name on a booking: letters of any language, joined by single spaces, apostrophes, hyphens or dots.
NAME: Final = r"^[^\W\d_][^\W\d_ '.’-]*(?:[ '.’-]+[^\W\d_][^\W\d_ '.’-]*)*[.]?$"  # noqa: RUF001 - the typographic apostrophe of a name
# The most a tool call's arguments may be, in characters, before they are even parsed.
MAX_ARGUMENT_CHARS: Final = 2_000
# The nearest slots offered when nothing is free in the days a visitor asked for.
NEAREST_OPTIONS: Final = 3
# How many days a search covers when the visitor named only where it starts, or nothing.
DEFAULT_SEARCH_DAYS: Final = 7
# The fields of a conversation whose change makes the hold and the slots on offer stale.
INVALIDATING: Final = frozenset({"offering", "party_size", "search_from", "search_to", "search_part_of_day"})

type PartOfDay = Literal["morning", "afternoon", "evening", "any"]
GuestName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=60, pattern=NAME)]
OfferingKey = Annotated[str, StringConstraints(pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$", max_length=40)]
# What a tool answers with: plain values, which go to the model as JSON.
type Result = dict[str, Any]


class ToolArguments(BaseModel):
    """The base of every tool's arguments: a field the schema doesn't define is an error, never ignored."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class UpdateDetailsArguments(ToolArguments):
    """What the visitor has told the concierge, in the fields they gave. At least one is needed."""

    offering: OfferingKey | None = None
    party_size: int | None = Field(default=None, ge=1, le=MAX_PARTY_SIZE)
    name: GuestName | None = None
    date_from: date | None = None
    date_to: date | None = None
    part_of_day: PartOfDay | None = None

    @model_validator(mode="after")
    def _check_something_and_a_sensible_window(self) -> Self:
        """Require at least one field with a value, and a last day that isn't before the first."""
        if all(getattr(self, name) is None for name in type(self).model_fields):
            raise ValueError("give at least one field")
        if self.date_from and self.date_to and self.date_to < self.date_from:
            raise ValueError("date_to is before date_from")
        return self


class CheckAvailabilityArguments(ToolArguments):
    """A new search window. Fields left out keep what the conversation searched last."""

    date_from: date | None = None
    date_to: date | None = None
    part_of_day: PartOfDay | None = None

    @model_validator(mode="after")
    def _check_window(self) -> Self:
        """Refuse a last day that is before the first."""
        if self.date_from and self.date_to and self.date_to < self.date_from:
            raise ValueError("date_to is before date_from")
        return self


class HoldSlotArguments(ToolArguments):
    """Which of the slots on offer to hold, by its number in the latest list."""

    option: int = Field(ge=1, le=MAX_OPTIONS)


class NoArguments(ToolArguments):
    """For the tools that take nothing: confirm_booking and release_hold."""


class HandoffArguments(ToolArguments):
    """Why the conversation goes to a person."""

    reason: Literal["asked_for_person", "out_of_scope", "cannot_help"]


ARGUMENT_SCHEMAS: Final[dict[Tool, type[ToolArguments]]] = {
    Tool.UPDATE_DETAILS: UpdateDetailsArguments,
    Tool.CHECK_AVAILABILITY: CheckAvailabilityArguments,
    Tool.HOLD_SLOT: HoldSlotArguments,
    Tool.CONFIRM_BOOKING: NoArguments,
    Tool.RELEASE_HOLD: NoArguments,
    Tool.HANDOFF_TO_PERSON: HandoffArguments,
}
# What each tool's span is called in the Scope: the datasheet's chain.
SPAN_NAMES: Final = {
    Tool.UPDATE_DETAILS: "collect details",
    Tool.CHECK_AVAILABILITY: "check availability",
    Tool.HOLD_SLOT: "hold slot",
    Tool.CONFIRM_BOOKING: "confirm",
    Tool.RELEASE_HOLD: "release hold",
    Tool.HANDOFF_TO_PERSON: "hand off to a person",
}


@dataclass(frozen=True)
class TurnContext:
    """What a tool needs to know about the visitor message it is running for.

    The executor is shared by every conversation, so nothing about one turn lives on it.
    `held_before` is the ID of the hold the conversation had when the visitor's message
    arrived: a hold made during this very turn can't be confirmed in it, because the visitor
    has not yet had the chance to say yes to it.
    """

    language: str
    held_before: int | None = None
    # What the model is told that the database can't show it: a hold that ran out, a refused address.
    notes: tuple[str, ...] = ()


@dataclass
class ToolOutcome:
    """What one tool call came to: whether it ran, what the model is told, and any receipt the code writes itself."""

    tool: str
    # The state machine let it run. A refused call changes nothing.
    executed: bool
    ok: bool
    result: Result
    # The kind of message the code writes for this outcome, and the facts it needs.
    receipt: Receipt | None = None
    facts: dict[str, object] = field(default_factory=dict)
    # A line for the transcript, in English, saying what the tool did.
    note: str = ""
    error: str = ""
    # The arguments the model gave, validated, for the Scope and the golden-set eval.
    arguments: dict[str, object] = field(default_factory=dict)
    # The slot a hold or booking is for, when this outcome made or found one.
    slot_id: int | None = None

    def for_model(self) -> str:
        """Write the outcome as the compact JSON the model reads."""
        return json.dumps(self.result, ensure_ascii=False, separators=(",", ":"), default=str)


@dataclass(frozen=True)
class SearchOutcome:
    """The result of a search: the slots found, whether the window was empty, and what was searched."""

    slots: list[Slot]
    window_empty: bool
    first_day: date
    last_day: date
    part_of_day: str


def parse_tool(name: str) -> Tool | None:
    """Return the tool a name stands for, or None when it names none of ours."""
    try:
        return Tool(name)
    except ValueError:
        return None


def parse_arguments(tool: Tool, text: str) -> ToolArguments:
    """Parse and validate a tool call's arguments, or raise ValueError naming the fields at fault.

    Never echoes a value the model wrote: a message names fields and rules only.
    """
    if len(text) > MAX_ARGUMENT_CHARS:
        raise ValueError("the arguments are too long")
    document = text if text.strip() else "{}"
    try:
        parsed = json.loads(document)
    except json.JSONDecodeError:
        raise ValueError("the arguments aren't valid JSON") from None
    if not isinstance(parsed, dict):
        raise ValueError("the arguments must be a JSON object")
    try:
        # Strict, so a number written as text, or a true where a number belongs, is an error and not a guess.
        return ARGUMENT_SCHEMAS[tool].model_validate_json(document, strict=True)
    except ValidationError as error:
        fields = sorted({".".join(str(part) for part in issue["loc"]) or "arguments" for issue in error.errors()})
        raise ValueError(f"invalid arguments: {', '.join(fields)}") from None


def email_status(conversation: Conversation) -> str:
    """Say whether the visitor's contact address is kept, as the model reads it."""
    return "kept" if conversation.guest_email else "missing"


def failed(tool: Tool, error: str, **detail: object) -> ToolOutcome:
    """Build the outcome of a tool that ran but couldn't do what was asked, with the error code and any detail."""
    return ToolOutcome(
        tool=tool.value, executed=True, ok=False, result={"ok": False, "error": error, **detail}, error=error
    )


def refused(name: str, step: str) -> ToolOutcome:
    """Build the outcome for a call the state machine won't run: nothing changes, and the model is told why."""
    known = parse_tool(name) is not None
    error = "not_available_now" if known else "unknown_tool"
    return ToolOutcome(
        tool=name[:64], executed=False, ok=False, result={"ok": False, "error": error, "step": step}, error=error
    )


def hold_expiry_note(reservation: Reservation) -> str:
    """Write the note the model gets after a hold ran out, naming the slot it was on."""
    return f"The visitor's hold on {when_text(reservation.during.lower, reservation.during.upper, 'en')} ran out."


class ToolExecutor:
    """Runs the concierge's tool calls: gate by step, validate, act on the conversation's own facts, report."""

    def __init__(self, bookings: BookingService, tracer: Tracer, clock: Clock) -> None:
        """Work on the calendar through `bookings`, record spans with `tracer`, and tell the time by `clock`."""
        self.bookings = bookings
        self.tracer = tracer
        self.clock = clock
        self.handlers: dict[Tool, Callable[[Conversation, Any, TurnContext], ToolOutcome]] = {
            Tool.UPDATE_DETAILS: self.update_details,
            Tool.CHECK_AVAILABILITY: self.check_availability,
            Tool.HOLD_SLOT: self.hold_slot,
            Tool.CONFIRM_BOOKING: self.confirm_booking,
            Tool.RELEASE_HOLD: self.release_hold,
            Tool.HANDOFF_TO_PERSON: self.hand_over_to_person,
        }

    def run(self, conversation: Conversation, call: ToolCall, context: TurnContext) -> ToolOutcome:
        """Run one call the model made, in the step the conversation is in right now.

        The step is worked out from the facts before each call, so a second call in the same
        reply sees what the first one did.
        """
        step = sync_step(conversation, self.bookings)
        tool = parse_tool(call.name)
        if tool is None or not tool_accepted(step, tool):
            return refused(call.name, step)
        try:
            arguments = parse_arguments(tool, call.arguments)
        except ValueError as error:
            return failed(tool, "invalid_arguments", detail=str(error))
        with self.tracer.span(SPAN_NAMES[tool], kind="system.tool", tool=tool.value) as span:
            outcome = self.handlers[tool](conversation, arguments, context)
            outcome.arguments = arguments.model_dump(mode="json", exclude_none=True)
            span.set("ok", outcome.ok)
            if outcome.error:
                span.set("error", outcome.error)
        sync_step(conversation, self.bookings)
        return outcome

    # The tools

    def update_details(
        self,
        conversation: Conversation,
        arguments: UpdateDetailsArguments,
        context: TurnContext,  # noqa: ARG002 - every tool takes the same three arguments
    ) -> ToolOutcome:
        """Record the fields the visitor gave, searching for slots once everything needed is in.

        Valid fields are saved and invalid ones reported, so one bad field doesn't lose the
        rest. Changing the offering, the party or the days gives up the hold and the slots on
        offer, since they were for something else.
        """
        saved: list[str] = []
        errors: dict[str, str] = {}
        changes = self.validated_changes(conversation, arguments, saved, errors)
        invalidates = any(
            getattr(conversation, name) != value for name, value in changes.items() if name in INVALIDATING
        )
        for name, value in changes.items():
            setattr(conversation, name, value)
        if invalidates:
            self.bookings.release_hold(conversation)
            conversation.offered_slots = []
        if "guest_name" in changes:
            Reservation.objects.filter(conversation=conversation, status=Reservation.Status.HELD).update(
                guest_name=conversation.guest_name
            )
        if changes or invalidates:
            conversation.save(update_fields=[*changes, "offered_slots", "updated_at"])
        ok = bool(saved) or not errors
        result: Result = {"ok": ok, "saved": saved, "errors": errors}
        result["missing"] = conversation.missing_details()
        result["email"] = email_status(conversation)
        if not conversation.missing_details() and (invalidates or not conversation.offered_slots):
            result.update(self.search_result(conversation))
        return ToolOutcome(
            tool=Tool.UPDATE_DETAILS.value,
            executed=True,
            ok=ok,
            result=result,
            note=f"Recorded {', '.join(saved)}." if saved else "",
            error="" if ok else "invalid_fields",
        )

    def validated_changes(
        self, conversation: Conversation, arguments: UpdateDetailsArguments, saved: list[str], errors: dict[str, str]
    ) -> dict[str, Any]:
        """Check each field the visitor gave against the rooms and the calendar; return the ones that can be saved."""
        changes: dict[str, Any] = {}
        offering = conversation.offering
        if arguments.offering is not None:
            found = Offering.objects.filter(key=arguments.offering).first()
            if found is None:
                errors["offering"] = "unknown_offering"
            else:
                changes["offering"] = offering = found
                saved.append("offering")
        party_size = arguments.party_size if arguments.party_size is not None else conversation.party_size
        if party_size is not None and offering is not None and party_size > offering.capacity:
            errors["party_size"] = f"party_too_large: {offering.key} takes at most {offering.capacity} guests"
            if arguments.party_size is None:
                changes["party_size"] = None
        elif arguments.party_size is not None:
            changes["party_size"] = arguments.party_size
            saved.append("party_size")
        if arguments.name is not None:
            changes["guest_name"] = arguments.name
            saved.append("name")
        for argument, field_name in (("date_from", "search_from"), ("date_to", "search_to")):
            value = getattr(arguments, argument)
            if value is not None:
                changes[field_name] = value
                saved.append(argument)
        if arguments.part_of_day is not None:
            changes["search_part_of_day"] = arguments.part_of_day
            saved.append("part_of_day")
        return changes

    def check_availability(
        self,
        conversation: Conversation,
        arguments: CheckAvailabilityArguments,
        context: TurnContext,  # noqa: ARG002 - every tool takes the same three arguments
    ) -> ToolOutcome:
        """Search again for slots, in a new window, and put what is free on offer."""
        missing = conversation.missing_details()
        if missing:
            return failed(Tool.CHECK_AVAILABILITY, "details_missing", missing=missing)
        changes = {
            name: value
            for name, value in (
                ("search_from", arguments.date_from),
                ("search_to", arguments.date_to),
                ("search_part_of_day", arguments.part_of_day),
            )
            if value is not None
        }
        for name, value in changes.items():
            setattr(conversation, name, value)
        if changes:
            conversation.save(update_fields=[*changes, "updated_at"])
        return ToolOutcome(
            tool=Tool.CHECK_AVAILABILITY.value,
            executed=True,
            ok=True,
            result={"ok": True, **self.search_result(conversation)},
        )

    def hold_slot(self, conversation: Conversation, arguments: HoldSlotArguments, context: TurnContext) -> ToolOutcome:
        """Hold the slot at a number in the latest list for five minutes, and write the receipt from the hold itself."""
        offered = conversation.offered_slots
        slot_id = offered[arguments.option - 1] if arguments.option <= len(offered) else None
        slot = Slot.objects.select_related("offering").filter(pk=slot_id).first() if slot_id is not None else None
        if slot is None:
            return failed(Tool.HOLD_SLOT, "no_such_option", options_on_offer=len(offered))
        try:
            held = self.bookings.place_hold(conversation, slot)
        except BookingError as error:
            return self.hold_refused(conversation, error)
        facts = self.slot_facts(held.reservation, slot, context.language)
        return ToolOutcome(
            tool=Tool.HOLD_SLOT.value,
            executed=True,
            ok=True,
            result={"ok": True, "held": facts["when"], "minutes": facts["minutes"], "already_held": held.replayed},
            receipt=Receipt.HOLD_PLACED,
            facts=facts,
            note=f"Held {slot.offering.key} on {when_text(slot.starts_at, slot.ends_at, 'en')} for 5 minutes.",
            slot_id=slot.pk,
        )

    def hold_refused(self, conversation: Conversation, error: BookingError) -> ToolOutcome:
        """Turn the booking service's refusal into an answer, with fresh slots on offer when the slot was taken."""
        result: Result = {"ok": False, "error": error.code.value}
        receipt: Receipt | None = None
        if error.code == Refusal.SLOT_UNAVAILABLE:
            if not conversation.missing_details():
                result.update(self.search_result(conversation))
            receipt = Receipt.SLOT_TAKEN
        return ToolOutcome(
            tool=Tool.HOLD_SLOT.value, executed=True, ok=False, result=result, receipt=receipt, error=error.code.value
        )

    def confirm_booking(
        self,
        conversation: Conversation,
        arguments: NoArguments,  # noqa: ARG002 - every tool takes the same three arguments
        context: TurnContext,
    ) -> ToolOutcome:
        """Confirm the conversation's own hold, once, and record the mock confirmation.

        The idempotency key is made from the reservation's own code, so confirming twice,
        in one reply or in two, returns the same booking. A hold that ran out is refused.
        """
        reservation = (
            Reservation.objects.filter(
                conversation=conversation, status__in=[Reservation.Status.HELD, Reservation.Status.BOOKED]
            )
            .order_by("-created_at")
            .first()
        )
        language = context.language
        if reservation is None:
            return self.confirm_refused(conversation, BookingError(Refusal.NO_HOLD, "no hold"), language)
        if reservation.status == Reservation.Status.HELD and reservation.pk != context.held_before:
            return failed(
                Tool.CONFIRM_BOOKING, "needs_the_visitors_yes", detail="the visitor hasn't answered the hold yet"
            )
        try:
            confirmed = self.bookings.confirm_hold(conversation, f"confirm-{reservation.code}")
        except BookingError as error:
            return self.confirm_refused(conversation, error, language)
        booking = confirmed.reservation
        slot = Slot.objects.select_related("offering").get(pk=booking.slot_id)
        with self.tracer.span("send confirmation", kind="system.tool", mock=True):
            record_confirmation(conversation, booking, language, self.clock())
        facts = self.slot_facts(booking, slot, language) | {"code": booking.code, "to": conversation.guest_email}
        return ToolOutcome(
            tool=Tool.CONFIRM_BOOKING.value,
            executed=True,
            ok=True,
            result={
                "ok": True,
                "code": booking.code,
                "when": facts["when"],
                "confirmation": "recorded on the page; this demo never sends email",
                "already_booked": confirmed.replayed,
            },
            receipt=Receipt.BOOKING_CONFIRMED,
            facts=facts,
            note=f"Booked {slot.offering.key} on {when_text(slot.starts_at, slot.ends_at, 'en')}, code {booking.code}.",
            slot_id=slot.pk,
        )

    def confirm_refused(self, conversation: Conversation, error: BookingError, language: str) -> ToolOutcome:
        """Turn a refused confirm into an answer: a hold that ran out is reported with a receipt of its own."""
        receipt: Receipt | None = None
        facts: dict[str, object] = {}
        if error.code == Refusal.HOLD_EXPIRED:
            expired = (
                Reservation.objects.filter(
                    conversation=conversation, status__in=[Reservation.Status.HELD, Reservation.Status.EXPIRED]
                )
                .order_by("-created_at")
                .first()
            )
            if expired is not None:
                wording = "cs" if language == "cs" else "en"
                receipt = Receipt.HOLD_EXPIRED
                facts = {"when": when_text(expired.during.lower, expired.during.upper, wording), "minutes": 5}
        return ToolOutcome(
            tool=Tool.CONFIRM_BOOKING.value,
            executed=True,
            ok=False,
            result={"ok": False, "error": error.code.value},
            receipt=receipt,
            facts=facts,
            error=error.code.value,
        )

    def release_hold(
        self,
        conversation: Conversation,
        arguments: NoArguments,  # noqa: ARG002 - every tool takes the same three arguments
        context: TurnContext,  # noqa: ARG002
    ) -> ToolOutcome:
        """Give up the conversation's hold."""
        released = self.bookings.release_hold(conversation)
        return ToolOutcome(
            tool=Tool.RELEASE_HOLD.value,
            executed=True,
            ok=True,
            result={"ok": True, "released": released is not None},
            note="Released the hold." if released is not None else "",
        )

    def hand_over_to_person(
        self,
        conversation: Conversation,
        arguments: HandoffArguments,
        context: TurnContext,  # noqa: ARG002 - every tool takes the same three arguments
    ) -> ToolOutcome:
        """Pass the conversation to a person, who gets the whole transcript, and say so with the code's own wording."""
        handoff = hand_over(conversation, Handoff.Reason(arguments.reason), self.bookings, self.clock())
        record(conversation, "action", f"Handed to a person: {handoff.get_reason_display()}.", self.clock())
        return ToolOutcome(
            tool=Tool.HANDOFF_TO_PERSON.value,
            executed=True,
            ok=True,
            result={"ok": True, "handed_over": True},
            receipt=Receipt.HANDED_OFF,
        )

    # Searching and describing

    def run_search(self, conversation: Conversation) -> SearchOutcome:
        """Search the calendar for the conversation's offering, party and window, and put the slots on offer.

        With nothing free in the window, the nearest free slots of the offering are put on
        offer instead and the outcome says so. The window actually searched is stored.
        """
        offering = conversation.offering
        party_size = conversation.party_size
        if offering is None or party_size is None:
            raise ValueError("a search needs the offering and the party size")
        first_open, last_open = bookable_days(self.clock())
        first = max(conversation.search_from or first_open, first_open)
        last = min(conversation.search_to or first + timedelta(days=DEFAULT_SEARCH_DAYS - 1), last_open)
        part = conversation.search_part_of_day or "any"
        slots = self.bookings.free_slots(offering, first, last, party_size, part, MAX_OPTIONS) if first <= last else []
        window_empty = not slots
        if window_empty:
            slots = self.bookings.free_slots(offering, first_open, last_open, party_size, "any", NEAREST_OPTIONS)
        conversation.search_from, conversation.search_to, conversation.search_part_of_day = first, last, part
        conversation.offered_slots = [slot.pk for slot in slots]
        conversation.save(
            update_fields=["search_from", "search_to", "search_part_of_day", "offered_slots", "updated_at"]
        )
        return SearchOutcome(slots=slots, window_empty=window_empty, first_day=first, last_day=last, part_of_day=part)

    def search_result(self, conversation: Conversation) -> Result:
        """Search, inside a span of its own, and describe what was found for the model."""
        with self.tracer.span("check availability", kind="system.tool", automatic=True) as span:
            found = self.run_search(conversation)
            span.set("found", len(found.slots))
            span.set("window_empty", found.window_empty)
        result: Result = {
            "searched": f"{found.first_day.isoformat()} to {found.last_day.isoformat()}, {found.part_of_day}",
            "options": [
                {"option": number, "offering": slot.offering.key, "when": when_text(slot.starts_at, slot.ends_at, "en")}
                for number, slot in enumerate(found.slots, start=1)
            ],
        }
        if found.window_empty:
            result["window_empty"] = "nothing is free then; these are the nearest slots"
        if not found.slots:
            result["none_free"] = True
        return result

    def slot_facts(self, reservation: Reservation, slot: Slot, language: str) -> dict[str, object]:
        """Gather the facts a receipt needs about a held or booked slot, in the visitor's language."""
        wording = "cs" if language == "cs" else "en"
        return {
            "offering": slot.offering.title(wording),
            "when": when_text(slot.starts_at, slot.ends_at, wording),
            "party": guests(reservation.party_size, wording),
            "minutes": 5,
        }
