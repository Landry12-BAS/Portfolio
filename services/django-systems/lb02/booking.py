"""The booking rules of LB-02: which slots are free, holding one, and confirming the hold.

The database has the last word. Two active reservations of one room can't overlap, because
the exclusion constraint on `lb02_reservation` refuses the second whoever asks and however
often. This module is the polite layer above that: it looks before it leaps, turns the
database's refusal into an answer, and keeps the visitor's own holds tidy.

Expiry never waits for the sweep. A hold is a reservation with an expiry time, and every
check here reads that time against the clock it is given:

- A search offers a slot whose only reservation is a hold that has run out.
- Placing a hold first marks the stale holds on its own room and range expired, in the
  same transaction as the insert, so a stale row can't be what refuses a new booking.
- Confirming a hold that ran out is refused, with no regard for its status column.

The Celery sweep (lb02/tasks.py) then only tidies the rows and tells the live calendar.

Confirming is idempotent. The key names one confirm request: repeating it returns the
booking it made, and the database refuses a second booking for one conversation.

Every method takes its time from the clock the service was built with, so the tests and
the golden-set eval can move it by six minutes instead of waiting.
"""

from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from enum import StrEnum
from typing import Literal, Protocol

from django.db import IntegrityError, transaction
from django.db.backends.postgresql.psycopg_any import DateTimeTZRange
from django.db.models import Exists, OuterRef, Q
from django.utils import timezone
from psycopg.errors import ExclusionViolation

from lb02.limits import CALENDAR_DAYS_AHEAD, HOLD_DURATION
from lb02.models import ROASTERY_TIME_ZONE, Conversation, Offering, Reservation, Slot

# Every reservation, slot and conversation lives on LB-02's own connection (core.databases).
DATABASE = "lb02"

type Clock = Callable[[], datetime]
type SlotStatus = Literal["free", "held", "booked"]
# The parts of the day a visitor can ask for: the hour a session starts in decides which.
PART_OF_DAY_HOURS: dict[str, range] = {"morning": range(12), "afternoon": range(12, 17), "evening": range(17, 24)}


class Refusal(StrEnum):
    """Why a booking step was refused: stable codes, which the concierge's tools report to the model."""

    SLOT_UNAVAILABLE = "slot_unavailable"
    SLOT_NOT_BOOKABLE = "slot_not_bookable"
    PARTY_TOO_LARGE = "party_too_large"
    DETAILS_MISSING = "details_missing"
    NO_HOLD = "no_hold"
    HOLD_EXPIRED = "hold_expired"
    ALREADY_BOOKED = "already_booked"


class BookingError(Exception):
    """A booking step the rules refuse. The code says why; nothing was changed."""

    def __init__(self, code: Refusal, message: str) -> None:
        """Record the refusal's stable code and a sentence for logs and tests."""
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class SlotState:
    """Whether a slot is free, held or booked, who has it (a conversation's ID) and until when a hold lasts."""

    status: SlotStatus
    owner: int | None = None
    until: datetime | None = None


@dataclass(frozen=True)
class SlotChange:
    """One slot and its new state, as the live calendar is told about it."""

    slot_id: int
    offering: str
    starts_at: datetime
    ends_at: datetime
    state: SlotState


class CalendarNotifier(Protocol):
    """Somewhere the calendar's changes go, once the transaction that made them has committed."""

    def slots_changed(self, changes: Sequence[SlotChange]) -> None:
        """Tell the live calendar. Must never raise: a failed announcement can't undo a booking."""
        ...


class SilentNotifier:
    """Tells nobody: for the seed, the golden-set eval and tests that don't watch the calendar."""

    def slots_changed(self, changes: Sequence[SlotChange]) -> None:
        """Ignore the changes."""


@dataclass(frozen=True)
class HoldResult:
    """A hold, and whether this call only repeated one the conversation already had."""

    reservation: Reservation
    replayed: bool


@dataclass(frozen=True)
class ConfirmResult:
    """A booking, and whether this call only repeated a confirm that had already succeeded."""

    reservation: Reservation
    replayed: bool


def is_exclusion_violation(error: IntegrityError) -> bool:
    """Tell whether the database refused a write because two reservations of one room overlap."""
    return isinstance(error.__cause__, ExclusionViolation)


def active_now(now: datetime) -> Q:
    """Match the reservations that keep their room at `now`: bookings, and holds that haven't run out."""
    return Q(status=Reservation.Status.BOOKED) | Q(status=Reservation.Status.HELD, hold_expires_at__gt=now)


def local_day(moment: datetime) -> date:
    """Return the roastery's calendar day at a moment."""
    return moment.astimezone(ROASTERY_TIME_ZONE).date()


def day_start(day: date) -> datetime:
    """Return midnight at the start of a roastery day."""
    return datetime.combine(day, time.min, tzinfo=ROASTERY_TIME_ZONE)


def in_part_of_day(slot: Slot, part_of_day: str) -> bool:
    """Tell whether a slot starts in the part of the day asked for; any time matches everything."""
    hours = PART_OF_DAY_HOURS.get(part_of_day)
    return hours is None or slot.starts_at.astimezone(ROASTERY_TIME_ZONE).hour in hours


def bookable_days(now: datetime) -> tuple[date, date]:
    """Return the first and last day a visitor can book: the calendar opens tomorrow and runs two weeks."""
    today = local_day(now)
    return today + timedelta(days=1), today + timedelta(days=CALENDAR_DAYS_AHEAD)


def span_of(slots: Sequence[Slot]) -> DateTimeTZRange:
    """Return one range covering every slot given, so a single query finds every reservation that could touch them."""
    return DateTimeTZRange(min(slot.starts_at for slot in slots), max(slot.ends_at for slot in slots), "[)")


def overlaps(reservation: Reservation, slot: Slot) -> bool:
    """Tell whether a reservation's half-open range and a slot's share any time, in the same room."""
    return (
        reservation.resource_id == slot.offering.resource_id
        and reservation.during.lower < slot.ends_at
        and slot.starts_at < reservation.during.upper
    )


def state_of(slot: Slot, reservations: Sequence[Reservation]) -> SlotState:
    """Say what the active reservations that overlap a slot make of it: booked beats held, else free."""
    overlapping = [reservation for reservation in reservations if overlaps(reservation, slot)]
    booked = next((r for r in overlapping if r.status == Reservation.Status.BOOKED), None)
    if booked is not None:
        return SlotState("booked", owner=booked.conversation_id)
    held = next((r for r in overlapping if r.status == Reservation.Status.HELD), None)
    if held is not None:
        return SlotState("held", owner=held.conversation_id, until=held.hold_expires_at)
    return SlotState("free")


class BookingService:
    """Searches the calendar, holds slots and confirms them, on the clock and the notifier it is given."""

    def __init__(self, clock: Clock = timezone.now, notifier: CalendarNotifier | None = None) -> None:
        """Use `clock` for every decision, and tell `notifier` about changes once they have committed."""
        self.clock = clock
        self.notifier: CalendarNotifier = notifier or SilentNotifier()

    def free_slots(
        self, offering: Offering, first_day: date, last_day: date, party_size: int, part_of_day: str, limit: int
    ) -> list[Slot]:
        """Return the soonest slots of an offering that are free between two days, for a party of this size.

        A slot is free when no booking and no live hold of its room overlaps it, which is
        also what the exclusion constraint would insist on. A hold that has run out
        doesn't count, whether or not the sweep has marked it.
        """
        now = self.clock()
        if party_size > offering.capacity:
            return []
        in_the_way = Reservation.objects.filter(
            resource_id=OuterRef("offering__resource_id"), during__overlap=OuterRef("during")
        ).filter(active_now(now))
        candidates = (
            Slot.objects.filter(
                offering=offering,
                during__startswith__gte=day_start(first_day),
                during__startswith__lt=day_start(last_day + timedelta(days=1)),
            )
            .filter(during__startswith__gt=now)
            .annotate(in_the_way=Exists(in_the_way))
            .filter(in_the_way=False)
            .select_related("offering")
            .order_by("during")
        )
        wanted: list[Slot] = [slot for slot in candidates if in_part_of_day(slot, part_of_day)]
        return wanted[:limit]

    def states_of(self, slots: Sequence[Slot]) -> dict[int, SlotState]:
        """Work out whether each slot is free, held or booked, and by whom, at the clock's time."""
        if not slots:
            return {}
        now = self.clock()
        resource_ids = {slot.offering.resource_id for slot in slots}
        reservations = list(
            Reservation.objects.filter(resource_id__in=resource_ids)
            .filter(active_now(now))
            .filter(during__overlap=span_of(slots))
        )
        return {slot.pk: state_of(slot, reservations) for slot in slots}

    def current_hold(self, conversation: Conversation) -> Reservation | None:
        """Return the conversation's hold if it is still running, or None."""
        return Reservation.objects.filter(
            conversation=conversation, status=Reservation.Status.HELD, hold_expires_at__gt=self.clock()
        ).first()

    def current_booking(self, conversation: Conversation) -> Reservation | None:
        """Return the conversation's booking, or None."""
        return Reservation.objects.filter(conversation=conversation, status=Reservation.Status.BOOKED).first()

    def place_hold(self, conversation: Conversation, slot: Slot) -> HoldResult:
        """Hold a slot for the conversation for five minutes, or refuse with the reason.

        Asking again for the slot the conversation already holds returns that hold
        unchanged, so a model that calls the tool twice holds it once. Asking for another
        slot replaces the old hold, and the old hold is only given up if the new one is
        won. When two conversations race for one slot, the database lets one insert
        through and refuses the other.
        """
        now = self.clock()
        party_size = self.check_can_hold(conversation, slot, now)
        try:
            with transaction.atomic(using=DATABASE):
                result, touched = self.hold_inside_transaction(conversation, slot, party_size, now)
                if touched:
                    self.announce(touched)
        except IntegrityError as error:
            if is_exclusion_violation(error):
                raise BookingError(Refusal.SLOT_UNAVAILABLE, "The slot is taken.") from None
            raise
        return result

    def release_hold(self, conversation: Conversation) -> Reservation | None:
        """Give up the conversation's hold, if it has one, and return it."""
        with transaction.atomic(using=DATABASE):
            hold = (
                Reservation.objects.select_for_update()
                .filter(conversation=conversation, status=Reservation.Status.HELD)
                .first()
            )
            if hold is None:
                return None
            hold.status = Reservation.Status.RELEASED
            hold.save(update_fields=["status"])
            self.announce([hold])
        return hold

    def confirm_hold(self, conversation: Conversation, idempotency_key: str) -> ConfirmResult:
        """Turn the conversation's live hold into a booking, once however often the same key is sent.

        A repeated key returns the booking it made. A hold that has run out is refused
        whatever its status says. Only the conversation that holds a slot can confirm it.
        The conversation's reservations are locked first, so two confirms racing each
        other are decided one after the other, and the second one sees the first's booking.
        """
        now = self.clock()
        with transaction.atomic(using=DATABASE):
            own = list(Reservation.objects.select_for_update().filter(conversation=conversation))
            booked = next((r for r in own if r.status == Reservation.Status.BOOKED), None)
            if booked is not None:
                if booked.idempotency_key == idempotency_key:
                    return ConfirmResult(booked, replayed=True)
                raise BookingError(Refusal.ALREADY_BOOKED, f"The conversation already has booking {booked.code}.")
            hold = next((r for r in own if r.status == Reservation.Status.HELD), None)
            if hold is None:
                raise BookingError(Refusal.NO_HOLD, "The conversation holds no slot.")
            if hold.hold_expires_at <= now:
                raise BookingError(Refusal.HOLD_EXPIRED, "The hold ran out.")
            hold.status = Reservation.Status.BOOKED
            hold.idempotency_key = idempotency_key
            hold.confirmed_at = now
            hold.save(update_fields=["status", "idempotency_key", "confirmed_at"])
            self.announce([hold])
        return ConfirmResult(hold, replayed=False)

    def expire_stale_holds(self) -> int:
        """Mark the holds that ran out as expired, tell the live calendar, and return how many there were.

        Housekeeping only: every check already treats these holds as gone.
        """
        now = self.clock()
        with transaction.atomic(using=DATABASE):
            stale = list(
                Reservation.objects.select_for_update().filter(status=Reservation.Status.HELD, hold_expires_at__lte=now)
            )
            if not stale:
                return 0
            Reservation.objects.filter(pk__in=[reservation.pk for reservation in stale]).update(
                status=Reservation.Status.EXPIRED
            )
            for reservation in stale:
                reservation.status = Reservation.Status.EXPIRED
            self.announce(stale)
        return len(stale)

    def check_can_hold(self, conversation: Conversation, slot: Slot, now: datetime) -> int:
        """Refuse a hold the visitor's details or the slot's day rule out, and return the party size to hold for.

        Nothing here asks the database for a lock: it only looks at what the caller already has.
        """
        offering = slot.offering
        party_size = conversation.party_size
        if party_size is None or not conversation.guest_name:
            raise BookingError(Refusal.DETAILS_MISSING, "A hold needs the party size and the visitor's name.")
        if party_size > offering.capacity:
            raise BookingError(Refusal.PARTY_TOO_LARGE, f"{offering.key} takes at most {offering.capacity} guests.")
        first_day, last_day = bookable_days(now)
        if not first_day <= local_day(slot.starts_at) <= last_day:
            raise BookingError(Refusal.SLOT_NOT_BOOKABLE, "The slot is outside the days that can be booked.")
        return party_size

    def hold_inside_transaction(
        self, conversation: Conversation, slot: Slot, party_size: int, now: datetime
    ) -> tuple[HoldResult, list[Reservation]]:
        """Do the work of a hold in the caller's transaction, and say which reservations changed.

        Reuse the hold the conversation already has on this slot, give up any other hold
        it has, clear the stale holds on this room and range, then insert.
        """
        own_holds = list(
            Reservation.objects.select_for_update().filter(conversation=conversation, status=Reservation.Status.HELD)
        )
        for hold in own_holds:
            if hold.slot_id == slot.pk and hold.hold_expires_at > now:
                return HoldResult(hold, replayed=True), []
        for hold in own_holds:
            hold.status = Reservation.Status.RELEASED if hold.hold_expires_at > now else Reservation.Status.EXPIRED
            hold.save(update_fields=["status"])
        # Holds that ran out on this room and range must not be what refuses the new one.
        Reservation.objects.filter(
            resource_id=slot.offering.resource_id,
            during__overlap=slot.during,
            status=Reservation.Status.HELD,
            hold_expires_at__lte=now,
        ).update(status=Reservation.Status.EXPIRED)
        reservation = Reservation.objects.create(
            slot=slot,
            resource_id=slot.offering.resource_id,
            during=slot.during,
            conversation=conversation,
            status=Reservation.Status.HELD,
            party_size=party_size,
            guest_name=conversation.guest_name,
            hold_expires_at=now + HOLD_DURATION,
            created_at=now,
        )
        return HoldResult(reservation, replayed=False), [*own_holds, reservation]

    def announce(self, reservations: Iterable[Reservation]) -> None:
        """Tell the live calendar about every slot the reservations touch, once the transaction commits.

        One reservation can touch several slots, because slots of different offerings can
        share a room. Their states are worked out now, inside the transaction, so the
        announcement says what was committed.
        """
        changes: dict[int, SlotChange] = {}
        for reservation in reservations:
            affected = list(
                Slot.objects.filter(
                    offering__resource_id=reservation.resource_id, during__overlap=reservation.during
                ).select_related("offering")
            )
            states = self.states_of(affected)
            for slot in affected:
                changes[slot.pk] = SlotChange(
                    slot_id=slot.pk,
                    offering=slot.offering.key,
                    starts_at=slot.starts_at,
                    ends_at=slot.ends_at,
                    state=states[slot.pk],
                )
        if changes:
            announced = list(changes.values())
            transaction.on_commit(lambda: self.notifier.slots_changed(announced), using=DATABASE)
