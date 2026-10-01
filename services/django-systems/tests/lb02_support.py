"""Helpers LB-02's tests share: calendar and conversation builders, a clock to move, a notifier to read."""

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from django.db.backends.postgresql.psycopg_any import DateTimeTZRange

from lb02.booking import SlotChange, local_day
from lb02.models import ROASTERY_TIME_ZONE, Conversation, Offering, Reservation, Resource, Slot

# A fixed morning, so every test counts its days from the same "today" (a Thursday, 11:00 in Prague).
START = datetime(2026, 10, 1, 9, 0, tzinfo=UTC)


class FakeClock:
    """A clock that stands still until it is moved: `advance` makes a hold run out without waiting."""

    def __init__(self, start: datetime = START) -> None:
        """Start at `start`, which is a timezone-aware moment."""
        self.now = start

    def __call__(self) -> datetime:
        """Return the clock's current moment."""
        return self.now

    def advance(self, minutes: float) -> None:
        """Move the clock forward."""
        self.now += timedelta(minutes=minutes)


@dataclass
class RecordingNotifier:
    """Remembers every announcement the booking service makes about the live calendar."""

    announcements: list[Sequence[SlotChange]] = field(default_factory=list)

    def slots_changed(self, changes: Sequence[SlotChange]) -> None:
        """Keep the changes."""
        self.announcements.append(list(changes))

    def changed_ids(self) -> set[int]:
        """Return the IDs of every slot that has been announced."""
        return {change.slot_id for changes in self.announcements for change in changes}


def make_room(key: str = "tasting-room") -> Resource:
    """Create a room."""
    return Resource.objects.create(key=key, name_en=key.title(), name_cs=key.title())


def make_offering(
    room: Resource, key: str = "tasting", minutes: int = 60, capacity: int = 6, position: int = 1
) -> Offering:
    """Create an offering that runs in a room."""
    return Offering.objects.create(
        resource=room,
        key=key,
        position=position,
        title_en=key.title(),
        title_cs=key.title(),
        summary_en="A session.",
        summary_cs="Setkání.",
        duration_minutes=minutes,
        capacity=capacity,
        price_czk=400,
    )


def make_slot(offering: Offering, starts_at: datetime) -> Slot:
    """Create a slot of an offering that starts at a moment and lasts as long as the offering does."""
    ends_at = starts_at + timedelta(minutes=offering.duration_minutes)
    slot = Slot.objects.create(offering=offering, during=DateTimeTZRange(starts_at, ends_at, "[)"))
    slot.offering = offering
    return slot


def make_conversation(
    offering: Offering | None = None,
    session: str = "session-of-jana-visitor-01",
    party_size: int | None = 2,
    guest_name: str = "Jana Novak",
    guest_email: str = "jana@example.test",
) -> Conversation:
    """Create a conversation whose details are all collected, ready to hold a slot."""
    return Conversation.objects.create(
        session_key=session,
        language="en",
        offering=offering,
        party_size=party_size,
        guest_name=guest_name,
        guest_email=guest_email,
    )


def tomorrow_at(clock: FakeClock, hour: int, minute: int = 0, days: int = 1) -> datetime:
    """Return a moment on the roastery's calendar: `days` after the clock's day, at a local hour (Prague time)."""
    day = local_day(clock()) + timedelta(days=days)
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=ROASTERY_TIME_ZONE)


def raw_reservation(conversation: Conversation, slot: Slot, status: str = "held", **fields: object) -> Reservation:
    """Insert a reservation straight into the table, as code that skipped the booking rules would."""
    values: dict[str, object] = {
        "slot": slot,
        "resource_id": slot.offering.resource_id,
        "during": slot.during,
        "conversation": conversation,
        "status": status,
        "party_size": 2,
        "guest_name": "Jana Novak",
        "hold_expires_at": slot.starts_at,
        "created_at": slot.starts_at - timedelta(days=1),
    }
    if status == "booked":
        values |= {"confirmed_at": slot.starts_at - timedelta(days=1), "idempotency_key": "raw"}
    return Reservation.objects.create(**{**values, **fields})
