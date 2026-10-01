"""A conversation as a client sees it: where it stands, what is on offer, what is held and what is booked.

The concierge returns one with every reply, the WebSocket sends one when a connection opens
or resumes, and the HTTP API describes a conversation with the same parts. Everything in it
is read from the database at the booking service's clock, so a hold that has run out is
already gone from it, whether or not the sweep has tidied the row.
"""

from dataclasses import dataclass
from datetime import datetime

from lb02.booking import BookingService
from lb02.conversations import current_step, language_of, messages_left
from lb02.models import Conversation, Slot
from lb02.states import Step


@dataclass(frozen=True)
class OptionView:
    """A slot on offer, as a client shows it."""

    number: int
    slot_id: int
    offering: str
    starts_at: datetime
    ends_at: datetime


@dataclass(frozen=True)
class HoldView:
    """The slot a conversation holds, and when the hold runs out."""

    slot_id: int
    offering: str
    starts_at: datetime
    ends_at: datetime
    expires_at: datetime


@dataclass(frozen=True)
class BookingView:
    """A conversation's booking: its code, its slot, and where the mock confirmation was addressed."""

    code: str
    slot_id: int
    offering: str
    starts_at: datetime
    ends_at: datetime
    party_size: int
    to: str


@dataclass(frozen=True)
class Snapshot:
    """Where a conversation stands: step, language, slots on offer, any hold or booking, and the messages left."""

    step: str
    language: str
    options: list[OptionView]
    hold: HoldView | None
    booking: BookingView | None
    messages_left: int
    closed: bool


def options_of(conversation: Conversation) -> list[OptionView]:
    """List the slots on offer, in the order they were numbered."""
    slots = Slot.objects.select_related("offering").in_bulk(conversation.offered_slots)
    return [
        OptionView(number, slot.pk, slot.offering.key, slot.starts_at, slot.ends_at)
        for number, slot_id in enumerate(conversation.offered_slots, start=1)
        if (slot := slots.get(slot_id)) is not None
    ]


def hold_of(conversation: Conversation, bookings: BookingService) -> HoldView | None:
    """Describe the slot the conversation holds, if it holds one."""
    hold = bookings.current_hold(conversation)
    if hold is None:
        return None
    slot = Slot.objects.select_related("offering").get(pk=hold.slot_id)
    return HoldView(slot.pk, slot.offering.key, slot.starts_at, slot.ends_at, hold.hold_expires_at)


def booking_of(conversation: Conversation, bookings: BookingService) -> BookingView | None:
    """Describe the conversation's booking, if it has one."""
    booking = bookings.current_booking(conversation)
    if booking is None:
        return None
    slot = Slot.objects.select_related("offering").get(pk=booking.slot_id)
    return BookingView(
        booking.code,
        slot.pk,
        slot.offering.key,
        slot.starts_at,
        slot.ends_at,
        booking.party_size,
        conversation.guest_email,
    )


def snapshot_of(conversation: Conversation, bookings: BookingService) -> Snapshot:
    """Describe where a conversation stands now, from the facts. It only reads: the stored step is left as it is."""
    step = current_step(conversation, bookings)
    return Snapshot(
        step=step,
        language=language_of(conversation),
        options=options_of(conversation) if step == Step.AVAILABILITY else [],
        hold=hold_of(conversation, bookings),
        booking=booking_of(conversation, bookings),
        messages_left=messages_left(conversation),
        closed=step == Step.HANDOFF,
    )
