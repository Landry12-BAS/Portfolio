"""LB-02's HTTP API, which the site calls for a visitor: the offerings, the calendar, and their own conversations.

The conversation itself happens over the WebSocket (lb02/consumers.py). These routes are what a
page needs around it: the offerings to show, a snapshot of the calendar to draw before the live
changes arrive, and a visitor's own conversations afterwards, with the transcript, the booking,
the confirmation that was recorded and never sent, and the handoff a person would receive.

Every route needs a visitor token for lb-02 (core/visitors.py), and a visitor sees only their own
session's conversations: anyone else's is simply not found. The calendar is the same for every
visitor, except that it tells each of them which slot is theirs.
"""

from datetime import date, datetime, timedelta
from typing import Annotated, Literal

from django.db.models import QuerySet
from django.http import HttpRequest
from ninja import Query, Router, Schema, Status
from ninja.errors import AuthenticationError
from pydantic import Field

from core.visitors import Visitor, VisitorBearer
from lb02.booking import BookingService, SlotState, SlotStatus, bookable_days, day_start
from lb02.conversations import messages_left
from lb02.limits import CALENDAR_DAYS_AHEAD
from lb02.models import Confirmation, Conversation, Handoff, Message, Offering, Slot
from lb02.snapshot import BookingView, HoldView, OptionView, snapshot_of

# How many of a visitor's conversations the list shows, newest first.
LIST_LENGTH = 20

router = Router(auth=VisitorBearer("lb-02"), tags=["LB-02 Booking Concierge"])


class ErrorDetail(Schema):
    """What went wrong, as a stable code and a sentence for people."""

    code: str
    message: str


class ErrorOut(Schema):
    """The error shape the whole platform answers with."""

    error: ErrorDetail


class LocalizedOut(Schema):
    """A text in each of the site's two languages."""

    en: str
    cs: str


class OfferingOut(Schema):
    """Something a visitor can book: what it is, how long it takes, how many it takes, and what it costs."""

    key: str
    title: LocalizedOut
    summary: LocalizedOut
    room: LocalizedOut
    duration_minutes: int
    capacity: int
    price_czk: int


class SlotOut(Schema):
    """One slot of the calendar, as one visitor sees it; `mine` is true for the slot their conversation holds or has."""

    id: int
    offering: str
    starts_at: datetime
    ends_at: datetime
    status: SlotStatus
    mine: bool
    # When a hold runs out, for a held slot.
    until: datetime | None


class CalendarOut(Schema):
    """A snapshot of the calendar. `as_of` is the server's time, for ordering it against live changes."""

    as_of: datetime
    first_day: date
    last_day: date
    slots: list[SlotOut]


class CalendarQuery(Schema):
    """Which days of the calendar to show, and which conversation's point of view to show them from."""

    # `from` is a Python keyword, so the field has another name and the address says `from`.
    first_day: Annotated[date | None, Field(alias="from")] = None
    days: Annotated[int, Field(ge=1, le=CALENDAR_DAYS_AHEAD)] = CALENDAR_DAYS_AHEAD
    conversation: str | None = None


class LineOut(Schema):
    """One line of a transcript."""

    position: int
    role: Literal["visitor", "concierge", "action"]
    text: str
    at: datetime


class OptionOut(Schema):
    """A slot the concierge has on offer, by the number it holds it with."""

    number: int
    slot: int
    offering: str
    starts_at: datetime
    ends_at: datetime


class HoldOut(Schema):
    """The slot a conversation holds, and when the hold runs out."""

    slot: int
    offering: str
    starts_at: datetime
    ends_at: datetime
    expires_at: datetime


class BookingOut(Schema):
    """A conversation's booking, and the address its mock confirmation was made out to."""

    code: str
    slot: int
    offering: str
    starts_at: datetime
    ends_at: datetime
    party_size: int
    to: str


class ConfirmationOut(Schema):
    """The confirmation email as it would have been sent. `delivery` is always `mock`: nothing is ever sent."""

    to: str
    subject: str
    body: str
    language: str
    delivery: Literal["mock"]
    recorded_at: datetime


class HandoffOut(Schema):
    """A conversation handed to a person: why, what was collected, and every line said."""

    reason: str
    summary: str
    created_at: datetime
    transcript: list[LineOut]


class ConversationSummary(Schema):
    """A conversation as the visitor's list shows it."""

    id: str
    step: str
    language: str
    messages_used: int
    messages_left: int
    closed: bool
    created_at: datetime
    expires_at: datetime


class ConversationOut(ConversationSummary):
    """A conversation in full: the transcript, where the booking stands, and what a person would receive."""

    run_id: str
    model_calls: int
    transcript: list[LineOut]
    options: list[OptionOut]
    hold: HoldOut | None
    booking: BookingOut | None
    confirmation: ConfirmationOut | None
    handoff: HandoffOut | None


def error(code: str, message: str) -> ErrorOut:
    """Build an error answer in the platform's shape."""
    return ErrorOut(error=ErrorDetail(code=code, message=message))


def visitor_of(request: HttpRequest) -> Visitor:
    """Return the visitor the request's token vouched for."""
    visitor = getattr(request, "auth", None)
    if not isinstance(visitor, Visitor):
        raise AuthenticationError
    return visitor


def booking_service() -> BookingService:
    """Return the booking rules the API reads the calendar with: the real clock, and no one to notify."""
    return BookingService()


def own_conversations(visitor: Visitor) -> QuerySet[Conversation]:
    """Return the visitor's own conversations; no other conversation is ever reachable."""
    return Conversation.objects.filter(session_key=visitor.session_key)


@router.get("/offerings", response=list[OfferingOut])
def list_offerings(request: HttpRequest) -> list[OfferingOut]:
    """List what can be booked, in both languages."""
    visitor_of(request)
    return [offering_out(offering) for offering in Offering.objects.select_related("resource").order_by("position")]


@router.get("/calendar", response={200: CalendarOut, 404: ErrorOut})
def calendar(request: HttpRequest, params: Query[CalendarQuery]) -> Status[CalendarOut] | Status[ErrorOut]:
    """Show the slots of some days, each free, held or booked, and which of them the conversation holds or has."""
    visitor = visitor_of(request)
    viewer: Conversation | None = None
    if params.conversation is not None:
        viewer = own_conversations(visitor).filter(public_id=params.conversation).first()
        if viewer is None:
            return Status(404, error("not_found", "There is no such conversation."))
    bookings = booking_service()
    now = bookings.clock()
    first_day = params.first_day or bookable_days(now)[0]
    last_day = first_day + timedelta(days=params.days - 1)
    slots = list(
        Slot.objects.select_related("offering")
        .filter(
            during__startswith__gte=day_start(first_day),
            during__startswith__lt=day_start(last_day + timedelta(days=1)),
        )
        .filter(during__startswith__gt=now)
        .order_by("during", "offering__position")
    )
    states = bookings.states_of(slots)
    shown = [slot_out(slot, states[slot.pk], viewer.pk if viewer else None) for slot in slots]
    return Status(200, CalendarOut(as_of=now, first_day=first_day, last_day=last_day, slots=shown))


@router.get("/conversations", response=list[ConversationSummary])
def list_conversations(request: HttpRequest) -> list[ConversationSummary]:
    """List the visitor's own conversations, newest first."""
    bookings = booking_service()
    conversations = own_conversations(visitor_of(request)).order_by("-created_at")[:LIST_LENGTH]
    return [conversation_summary(conversation, bookings) for conversation in conversations]


@router.get("/conversations/{conversation_id}", response={200: ConversationOut, 404: ErrorOut})
def get_conversation(request: HttpRequest, conversation_id: str) -> Status[ConversationOut] | Status[ErrorOut]:
    """Show one of the visitor's own conversations in full."""
    conversation = own_conversations(visitor_of(request)).filter(public_id=conversation_id).first()
    if conversation is None:
        return Status(404, error("not_found", "There is no such conversation."))
    return Status(200, conversation_out(conversation, booking_service()))


def offering_out(offering: Offering) -> OfferingOut:
    """Describe an offering in both languages."""
    return OfferingOut(
        key=offering.key,
        title=LocalizedOut(en=offering.title_en, cs=offering.title_cs),
        summary=LocalizedOut(en=offering.summary_en, cs=offering.summary_cs),
        room=LocalizedOut(en=offering.resource.name_en, cs=offering.resource.name_cs),
        duration_minutes=offering.duration_minutes,
        capacity=offering.capacity,
        price_czk=offering.price_czk,
    )


def slot_out(slot: Slot, state: SlotState, viewer: int | None) -> SlotOut:
    """Describe a slot and its state; it is `mine` when the conversation looking at the calendar holds or has it."""
    return SlotOut(
        id=slot.pk,
        offering=slot.offering.key,
        starts_at=slot.starts_at,
        ends_at=slot.ends_at,
        status=state.status,
        mine=state.owner is not None and state.owner == viewer,
        until=state.until,
    )


def line_out(message: Message) -> LineOut:
    """Describe a transcript line."""
    return LineOut.model_validate(
        {"position": message.position, "role": message.role, "text": message.text, "at": message.created_at}
    )


def option_out(view: OptionView) -> OptionOut:
    """Describe an option on offer."""
    return OptionOut(
        number=view.number, slot=view.slot_id, offering=view.offering, starts_at=view.starts_at, ends_at=view.ends_at
    )


def hold_out(view: HoldView) -> HoldOut:
    """Describe a hold."""
    return HoldOut(
        slot=view.slot_id,
        offering=view.offering,
        starts_at=view.starts_at,
        ends_at=view.ends_at,
        expires_at=view.expires_at,
    )


def booking_out(view: BookingView) -> BookingOut:
    """Describe a booking."""
    return BookingOut(
        code=view.code,
        slot=view.slot_id,
        offering=view.offering,
        starts_at=view.starts_at,
        ends_at=view.ends_at,
        party_size=view.party_size,
        to=view.to,
    )


def conversation_summary(conversation: Conversation, bookings: BookingService) -> ConversationSummary:
    """Describe a conversation for the list."""
    where = snapshot_of(conversation, bookings)
    return ConversationSummary(
        id=conversation.public_id,
        step=where.step,
        language=where.language,
        messages_used=conversation.message_count,
        messages_left=messages_left(conversation),
        closed=where.closed,
        created_at=conversation.created_at,
        expires_at=conversation.expires_at,
    )


def conversation_out(conversation: Conversation, bookings: BookingService) -> ConversationOut:
    """Describe a conversation in full, with its confirmation and handoff when it has them."""
    where = snapshot_of(conversation, bookings)
    confirmation = Confirmation.objects.filter(reservation__conversation=conversation).first()
    handoff = Handoff.objects.filter(conversation=conversation).first()
    return ConversationOut(
        **conversation_summary(conversation, bookings).model_dump(),
        run_id=conversation.run_id,
        model_calls=conversation.model_calls,
        transcript=[line_out(message) for message in Message.objects.filter(conversation=conversation)],
        options=[option_out(view) for view in where.options],
        hold=hold_out(where.hold) if where.hold else None,
        booking=booking_out(where.booking) if where.booking else None,
        confirmation=confirmation_out(confirmation) if confirmation else None,
        handoff=handoff_out(handoff) if handoff else None,
    )


def confirmation_out(confirmation: Confirmation) -> ConfirmationOut:
    """Describe the recorded confirmation."""
    return ConfirmationOut(
        to=confirmation.to_address,
        subject=confirmation.subject,
        body=confirmation.body,
        language=confirmation.language,
        delivery="mock",
        recorded_at=confirmation.recorded_at,
    )


def handoff_out(handoff: Handoff) -> HandoffOut:
    """Describe a handoff, with the transcript it carries."""
    lines = [LineOut.model_validate(item) for item in handoff.transcript]
    return HandoffOut(reason=handoff.reason, summary=handoff.summary, created_at=handoff.created_at, transcript=lines)
