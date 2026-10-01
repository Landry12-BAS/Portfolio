"""Integration tests for LB-02's booking rules on a real Postgres: holds, confirms, expiry and the exclusion constraint.

The clock is a fake that the tests move, so a hold runs out in a line of code instead of five
minutes. Nothing here runs the sweep unless the test is about the sweep: every rule has to
hold without it.
"""

from collections.abc import Callable
from contextlib import AbstractContextManager
from datetime import datetime, timedelta

import pytest
from django.db import IntegrityError, transaction
from django.db.backends.postgresql.psycopg_any import DateTimeTZRange

from lb02.booking import (
    BookingError,
    BookingService,
    Refusal,
    is_exclusion_violation,
)
from lb02.limits import CALENDAR_DAYS_AHEAD, HOLD_DURATION
from lb02.models import Offering, Reservation, Resource, Slot
from tests.lb02_support import (
    FakeClock,
    RecordingNotifier,
    make_conversation,
    make_offering,
    make_room,
    make_slot,
    raw_reservation,
    tomorrow_at,
)

pytestmark = [pytest.mark.integration, pytest.mark.django_db(databases=["lb02"])]

type CaptureCommits = Callable[..., AbstractContextManager[list[Callable[[], None]]]]


@pytest.fixture
def clock() -> FakeClock:
    """Return a clock that starts on a Thursday morning and moves only when a test moves it."""
    return FakeClock()


@pytest.fixture
def notifier() -> RecordingNotifier:
    """Remember what the live calendar is told."""
    return RecordingNotifier()


@pytest.fixture
def service(clock: FakeClock, notifier: RecordingNotifier) -> BookingService:
    """Build the booking rules on the test clock."""
    return BookingService(clock=clock, notifier=notifier)


@pytest.fixture
def room() -> Resource:
    """Create the Tasting Room."""
    return make_room()


@pytest.fixture
def tasting(room: Resource) -> Offering:
    """Create a one-hour offering that takes six guests."""
    return make_offering(room, key="tasting", minutes=60, capacity=6)


@pytest.fixture
def slot(tasting: Offering, clock: FakeClock) -> Slot:
    """Tomorrow at 14:00, Prague time."""
    return make_slot(tasting, tomorrow_at(clock, 14))


# Searching the calendar


def test_a_search_offers_the_soonest_free_slots_of_an_offering(
    service: BookingService, tasting: Offering, clock: FakeClock
) -> None:
    """Slots come back in time order, only those of the offering, only inside the days asked for."""
    other_room = make_room("roastery-floor")
    workshop = make_offering(other_room, key="workshop", minutes=120)
    later = make_slot(tasting, tomorrow_at(clock, 16))
    sooner = make_slot(tasting, tomorrow_at(clock, 10))
    make_slot(tasting, tomorrow_at(clock, 10, days=5))
    make_slot(workshop, tomorrow_at(clock, 12))
    first_day = tomorrow_at(clock, 0).date()

    found = service.free_slots(tasting, first_day, first_day, party_size=2, part_of_day="any", limit=6)

    assert [slot.pk for slot in found] == [sooner.pk, later.pk]


def test_a_search_skips_slots_in_the_past_and_slots_for_a_party_that_is_too_large(
    service: BookingService, tasting: Offering, clock: FakeClock
) -> None:
    """A slot that already started isn't offered, and neither is any slot to more guests than the room takes."""
    past = make_slot(tasting, tomorrow_at(clock, 8, days=0))
    future = make_slot(tasting, tomorrow_at(clock, 14))
    today = tomorrow_at(clock, 0, days=0).date()
    tomorrow = tomorrow_at(clock, 0).date()

    assert past.pk not in {s.pk for s in service.free_slots(tasting, today, tomorrow, 2, "any", 6)}
    assert [s.pk for s in service.free_slots(tasting, today, tomorrow, 2, "any", 6)] == [future.pk]
    assert service.free_slots(tasting, today, tomorrow, tasting.capacity + 1, "any", 6) == []


@pytest.mark.parametrize(
    ("part_of_day", "expected_hours"),
    [("morning", [10]), ("afternoon", [12, 16]), ("evening", [18]), ("any", [10, 12, 16, 18])],
)
def test_a_search_can_ask_for_a_part_of_the_day(
    service: BookingService, tasting: Offering, clock: FakeClock, part_of_day: str, expected_hours: list[int]
) -> None:
    """Morning is before 12:00, afternoon 12:00 to 17:00, evening from 17:00: by the roastery's clock."""
    for hour in (10, 12, 16, 18):
        make_slot(tasting, tomorrow_at(clock, hour))
    day = tomorrow_at(clock, 0).date()

    found = service.free_slots(tasting, day, day, 2, part_of_day, 10)

    assert [s.starts_at.astimezone(tomorrow_at(clock, 0).tzinfo).hour for s in found] == expected_hours


def test_a_search_stops_at_the_limit(service: BookingService, tasting: Offering, clock: FakeClock) -> None:
    """No more slots come back than were asked for, soonest first."""
    slots = [make_slot(tasting, tomorrow_at(clock, hour)) for hour in (10, 12, 14, 16)]
    day = tomorrow_at(clock, 0).date()

    assert [s.pk for s in service.free_slots(tasting, day, day, 2, "any", 2)] == [slots[0].pk, slots[1].pk]


def test_a_booking_in_a_shared_room_takes_every_overlapping_slot_with_it(
    service: BookingService, room: Resource, tasting: Offering, clock: FakeClock
) -> None:
    """A cupping that overlaps a tasting in the same room becomes unavailable when the tasting is booked."""
    cupping = make_offering(room, key="cupping", minutes=60, position=2)
    tasting_slot = make_slot(tasting, tomorrow_at(clock, 12))
    overlapping_cupping = make_slot(cupping, tomorrow_at(clock, 12, 30))
    free_cupping = make_slot(cupping, tomorrow_at(clock, 15))
    day = tomorrow_at(clock, 0).date()
    conversation = make_conversation(tasting)
    service.place_hold(conversation, tasting_slot)

    found = service.free_slots(cupping, day, day, 2, "any", 6)

    assert [s.pk for s in found] == [free_cupping.pk]
    assert service.states_of([overlapping_cupping])[overlapping_cupping.pk].status == "held"


def test_the_states_of_slots_say_who_holds_them_and_until_when(
    service: BookingService, slot: Slot, clock: FakeClock
) -> None:
    """A slot is free, then held with its owner and expiry, then booked."""
    conversation = make_conversation(slot.offering)

    assert service.states_of([slot])[slot.pk].status == "free"
    service.place_hold(conversation, slot)
    held = service.states_of([slot])[slot.pk]
    assert (held.status, held.owner, held.until) == ("held", conversation.pk, clock() + HOLD_DURATION)
    service.confirm_hold(conversation, "key-1")
    booked = service.states_of([slot])[slot.pk]
    assert (booked.status, booked.owner) == ("booked", conversation.pk)


# Holding a slot


def test_a_hold_lasts_five_minutes_and_a_confirm_turns_it_into_a_booking(
    service: BookingService, slot: Slot, clock: FakeClock
) -> None:
    """The hold records the visitor's details and its expiry; confirming it books the same reservation."""
    conversation = make_conversation(slot.offering)

    hold = service.place_hold(conversation, slot)

    assert hold.replayed is False
    assert hold.reservation.status == Reservation.Status.HELD
    assert hold.reservation.hold_expires_at == clock() + timedelta(minutes=5)
    assert (hold.reservation.party_size, hold.reservation.guest_name) == (2, "Jana Novak")
    assert hold.reservation.during == slot.during
    clock.advance(4)

    booking = service.confirm_hold(conversation, "key-1")

    assert booking.reservation.pk == hold.reservation.pk
    assert booking.reservation.status == Reservation.Status.BOOKED
    assert booking.reservation.confirmed_at == clock()
    assert service.current_booking(conversation) is not None
    assert service.current_hold(conversation) is None


def test_a_slot_that_another_conversation_holds_cannot_be_held(service: BookingService, slot: Slot) -> None:
    """The second visitor is refused, and the first visitor's hold is untouched."""
    first = make_conversation(slot.offering, session="session-of-the-first-visitor")
    second = make_conversation(slot.offering, session="session-of-the-second-visitor")
    service.place_hold(first, slot)

    with pytest.raises(BookingError) as refusal:
        service.place_hold(second, slot)

    assert refusal.value.code == Refusal.SLOT_UNAVAILABLE
    assert service.current_hold(first) is not None
    assert service.current_hold(second) is None
    assert Reservation.objects.filter(slot=slot).count() == 1


def test_holding_the_same_slot_twice_is_one_hold(service: BookingService, slot: Slot, clock: FakeClock) -> None:
    """A model that calls the tool twice gets the same hold back, with its expiry unchanged."""
    conversation = make_conversation(slot.offering)
    first = service.place_hold(conversation, slot)
    clock.advance(2)

    second = service.place_hold(conversation, slot)

    assert second.replayed is True
    assert second.reservation.pk == first.reservation.pk
    assert second.reservation.hold_expires_at == first.reservation.hold_expires_at
    assert Reservation.objects.count() == 1


def test_holding_another_slot_gives_up_the_first(service: BookingService, slot: Slot, clock: FakeClock) -> None:
    """A visitor who changes their mind holds one slot at a time: the old one is released and free again."""
    other = make_slot(slot.offering, tomorrow_at(clock, 16))
    conversation = make_conversation(slot.offering)
    first = service.place_hold(conversation, slot)

    second = service.place_hold(conversation, other)

    first.reservation.refresh_from_db()
    assert first.reservation.status == Reservation.Status.RELEASED
    assert second.reservation.status == Reservation.Status.HELD
    day = tomorrow_at(clock, 0).date()
    assert slot.pk in {s.pk for s in service.free_slots(slot.offering, day, day, 2, "any", 6)}


def test_losing_the_race_for_another_slot_keeps_the_first_hold(
    service: BookingService, slot: Slot, clock: FakeClock
) -> None:
    """If the slot a visitor switches to is taken, they still hold the one they had."""
    wanted = make_slot(slot.offering, tomorrow_at(clock, 16))
    mine = make_conversation(slot.offering, session="session-of-the-first-visitor")
    theirs = make_conversation(slot.offering, session="session-of-the-second-visitor")
    service.place_hold(mine, slot)
    service.place_hold(theirs, wanted)

    with pytest.raises(BookingError) as refusal:
        service.place_hold(mine, wanted)

    assert refusal.value.code == Refusal.SLOT_UNAVAILABLE
    still_held = service.current_hold(mine)
    assert still_held is not None
    assert still_held.slot_id == slot.pk


def test_a_hold_needs_the_visitors_details_and_a_slot_that_can_be_booked(
    service: BookingService, slot: Slot, tasting: Offering, clock: FakeClock
) -> None:
    """Missing details, a party above capacity, a slot that started and a slot beyond the calendar are all refused."""
    too_late = make_slot(tasting, tomorrow_at(clock, 14, days=CALENDAR_DAYS_AHEAD + 1))
    already_started = make_slot(tasting, tomorrow_at(clock, 8, days=0))
    cases = [
        (make_conversation(tasting, guest_name=""), slot, Refusal.DETAILS_MISSING),
        (make_conversation(tasting, party_size=None), slot, Refusal.DETAILS_MISSING),
        (make_conversation(tasting, party_size=tasting.capacity + 1), slot, Refusal.PARTY_TOO_LARGE),
        (make_conversation(tasting), too_late, Refusal.SLOT_NOT_BOOKABLE),
        (make_conversation(tasting), already_started, Refusal.SLOT_NOT_BOOKABLE),
    ]

    for conversation, wanted, reason in cases:
        with pytest.raises(BookingError) as refusal:
            service.place_hold(conversation, wanted)
        assert refusal.value.code == reason
    assert not Reservation.objects.exists()


# Confirming


def test_confirming_twice_with_one_key_is_one_booking(service: BookingService, slot: Slot) -> None:
    """The second confirm returns the booking the first one made, and nothing else changes."""
    conversation = make_conversation(slot.offering)
    service.place_hold(conversation, slot)

    first = service.confirm_hold(conversation, "confirm-1")
    second = service.confirm_hold(conversation, "confirm-1")

    assert (first.replayed, second.replayed) == (False, True)
    assert second.reservation.pk == first.reservation.pk
    assert second.reservation.code == first.reservation.code
    assert Reservation.objects.filter(status=Reservation.Status.BOOKED).count() == 1


def test_a_second_confirm_with_another_key_is_refused(service: BookingService, slot: Slot) -> None:
    """A different key is a different request: the conversation already has its booking."""
    conversation = make_conversation(slot.offering)
    service.place_hold(conversation, slot)
    booked = service.confirm_hold(conversation, "confirm-1")

    with pytest.raises(BookingError) as refusal:
        service.confirm_hold(conversation, "confirm-2")

    assert refusal.value.code == Refusal.ALREADY_BOOKED
    assert Reservation.objects.get(pk=booked.reservation.pk).idempotency_key == "confirm-1"


def test_only_the_conversation_that_holds_a_slot_can_confirm_it(service: BookingService, slot: Slot) -> None:
    """Another conversation has no hold to confirm, and the holder's hold is left as it was."""
    holder = make_conversation(slot.offering, session="session-of-the-first-visitor")
    stranger = make_conversation(slot.offering, session="session-of-the-second-visitor")
    service.place_hold(holder, slot)

    with pytest.raises(BookingError) as refusal:
        service.confirm_hold(stranger, "stolen")

    assert refusal.value.code == Refusal.NO_HOLD
    assert service.current_hold(holder) is not None
    assert not Reservation.objects.filter(status=Reservation.Status.BOOKED).exists()


def test_confirming_without_a_hold_is_refused(service: BookingService, tasting: Offering) -> None:
    """There is nothing to confirm until a slot has been held."""
    with pytest.raises(BookingError) as refusal:
        service.confirm_hold(make_conversation(tasting), "key-1")

    assert refusal.value.code == Refusal.NO_HOLD


def test_a_hold_that_ran_out_cannot_be_confirmed(service: BookingService, slot: Slot, clock: FakeClock) -> None:
    """After five minutes the confirm is refused, though no sweep has run and the row still says held."""
    conversation = make_conversation(slot.offering)
    hold = service.place_hold(conversation, slot)
    clock.advance(5)

    with pytest.raises(BookingError) as refusal:
        service.confirm_hold(conversation, "key-1")

    assert refusal.value.code == Refusal.HOLD_EXPIRED
    assert Reservation.objects.get(pk=hold.reservation.pk).status == Reservation.Status.HELD
    assert service.current_hold(conversation) is None


def test_releasing_a_hold_frees_the_slot(service: BookingService, slot: Slot, clock: FakeClock) -> None:
    """A visitor who changes their mind gives the slot back at once, and a booking can't be released."""
    conversation = make_conversation(slot.offering)
    service.place_hold(conversation, slot)

    released = service.release_hold(conversation)

    assert released is not None
    assert released.status == Reservation.Status.RELEASED
    assert service.release_hold(conversation) is None
    day = tomorrow_at(clock, 0).date()
    assert [s.pk for s in service.free_slots(slot.offering, day, day, 2, "any", 6)] == [slot.pk]
    service.place_hold(conversation, slot)
    service.confirm_hold(conversation, "key-1")
    assert service.release_hold(conversation) is None
    assert service.current_booking(conversation) is not None


# Expiry


def test_an_expired_hold_never_blocks_a_booking_and_needs_no_sweep(
    service: BookingService, slot: Slot, clock: FakeClock
) -> None:
    """Five minutes on, the slot is on offer and holdable again, though the old row still says `held`."""
    first = make_conversation(slot.offering, session="session-of-the-first-visitor")
    second = make_conversation(slot.offering, session="session-of-the-second-visitor")
    old = service.place_hold(first, slot)
    clock.advance(5)
    day = tomorrow_at(clock, 0).date()
    assert Reservation.objects.get(pk=old.reservation.pk).status == Reservation.Status.HELD

    assert [s.pk for s in service.free_slots(slot.offering, day, day, 2, "any", 6)] == [slot.pk]
    new = service.place_hold(second, slot)
    booking = service.confirm_hold(second, "key-1")

    assert new.reservation.status == Reservation.Status.HELD
    assert booking.reservation.status == Reservation.Status.BOOKED
    assert Reservation.objects.get(pk=old.reservation.pk).status == Reservation.Status.EXPIRED
    with pytest.raises(BookingError) as refusal:
        service.confirm_hold(first, "too-late")
    assert refusal.value.code == Refusal.NO_HOLD


def test_a_hold_that_is_about_to_run_out_still_blocks(service: BookingService, slot: Slot, clock: FakeClock) -> None:
    """One second before expiry the hold still keeps the slot."""
    first = make_conversation(slot.offering, session="session-of-the-first-visitor")
    second = make_conversation(slot.offering, session="session-of-the-second-visitor")
    service.place_hold(first, slot)
    clock.advance(4.99)

    with pytest.raises(BookingError) as refusal:
        service.place_hold(second, slot)

    assert refusal.value.code == Refusal.SLOT_UNAVAILABLE


def test_the_sweep_only_tidies_what_every_check_already_treats_as_gone(
    service: BookingService,
    notifier: RecordingNotifier,
    slot: Slot,
    clock: FakeClock,
    django_capture_on_commit_callbacks: CaptureCommits,
) -> None:
    """The sweep marks the holds that ran out, tells the calendar, and leaves holds that are still live."""
    live_slot = make_slot(slot.offering, tomorrow_at(clock, 16))
    expiring = make_conversation(slot.offering, session="session-of-the-first-visitor")
    staying = make_conversation(slot.offering, session="session-of-the-second-visitor")
    service.place_hold(expiring, slot)
    clock.advance(3)
    service.place_hold(staying, live_slot)
    clock.advance(2.5)
    notifier.announcements.clear()

    with django_capture_on_commit_callbacks(execute=True, using="lb02"):
        swept = service.expire_stale_holds()

    assert swept == 1
    assert Reservation.objects.get(conversation=expiring).status == Reservation.Status.EXPIRED
    assert Reservation.objects.get(conversation=staying).status == Reservation.Status.HELD
    assert notifier.changed_ids() == {slot.pk}
    with django_capture_on_commit_callbacks(execute=True, using="lb02"):
        assert service.expire_stale_holds() == 0


# Telling the live calendar


def test_the_calendar_is_told_after_the_commit_and_only_what_changed(
    service: BookingService,
    notifier: RecordingNotifier,
    slot: Slot,
    django_capture_on_commit_callbacks: CaptureCommits,
) -> None:
    """A hold announces its slot as held, with its owner and expiry, once the transaction has committed."""
    conversation = make_conversation(slot.offering)

    with django_capture_on_commit_callbacks(execute=False, using="lb02") as callbacks:
        service.place_hold(conversation, slot)
    assert notifier.announcements == []
    for callback in callbacks:
        callback()

    [announcement] = notifier.announcements
    [change] = announcement
    assert (change.slot_id, change.offering, change.state.status, change.state.owner) == (
        slot.pk,
        "tasting",
        "held",
        conversation.pk,
    )


def test_nothing_is_announced_when_the_hold_fails(
    service: BookingService,
    notifier: RecordingNotifier,
    slot: Slot,
    django_capture_on_commit_callbacks: CaptureCommits,
) -> None:
    """A refused hold changes nothing, so the calendar hears nothing."""
    first = make_conversation(slot.offering, session="session-of-the-first-visitor")
    second = make_conversation(slot.offering, session="session-of-the-second-visitor")
    with django_capture_on_commit_callbacks(execute=True, using="lb02"):
        service.place_hold(first, slot)
    notifier.announcements.clear()

    with django_capture_on_commit_callbacks(execute=True, using="lb02"), pytest.raises(BookingError):
        service.place_hold(second, slot)

    assert notifier.announcements == []


# What the database refuses by itself


def overlapping_range(slot: Slot, minutes: int) -> DateTimeTZRange:
    """Return a range that starts `minutes` after the slot does and lasts as long as the slot."""
    shift = timedelta(minutes=minutes)
    return DateTimeTZRange(slot.starts_at + shift, slot.ends_at + shift, "[)")


def test_the_database_refuses_two_overlapping_reservations_of_a_room_by_itself(slot: Slot) -> None:
    """Code that skips the booking rules, such as a model calling a tool twice, still can't double-book."""
    first = make_conversation(slot.offering, session="session-of-the-first-visitor")
    second = make_conversation(slot.offering, session="session-of-the-second-visitor")
    raw_reservation(first, slot, status="booked")

    with pytest.raises(IntegrityError) as refusal, transaction.atomic(using="lb02"):
        raw_reservation(second, slot, status="held")

    assert is_exclusion_violation(refusal.value)
    assert "lb02_no_double_booking" in str(refusal.value)


@pytest.mark.parametrize("minutes", [-59, -30, 1, 30, 59])
def test_any_overlap_is_refused_but_a_session_that_starts_as_another_ends_is_not(slot: Slot, minutes: int) -> None:
    """Ranges are half open: 15:00 to 16:00 sits next to 14:00 to 15:00, and 14:30 to 15:30 doesn't."""
    first = make_conversation(slot.offering, session="session-of-the-first-visitor")
    second = make_conversation(slot.offering, session="session-of-the-second-visitor")
    raw_reservation(first, slot, status="booked")
    overlapping = make_slot(slot.offering, slot.starts_at + timedelta(minutes=minutes))

    with pytest.raises(IntegrityError) as refusal, transaction.atomic(using="lb02"):
        raw_reservation(second, overlapping, status="held")
    assert is_exclusion_violation(refusal.value)

    adjacent = make_slot(slot.offering, slot.ends_at)
    assert raw_reservation(second, adjacent, status="held").pk
    before = make_slot(slot.offering, slot.starts_at - timedelta(minutes=slot.offering.duration_minutes))
    third = make_conversation(slot.offering, session="session-of-the-third-visitor")
    assert raw_reservation(third, before, status="held").pk


def test_the_constraint_is_scoped_to_the_room(slot: Slot) -> None:
    """The same time in another room is no conflict; the same room under another offering is."""
    other_room = make_offering(make_room("roastery-floor"), key="workshop")
    elsewhere = make_slot(other_room, slot.starts_at)
    cupping = make_offering(slot.offering.resource, key="cupping", position=2)
    same_room = make_slot(cupping, slot.starts_at)
    conversations = [make_conversation(slot.offering, session=f"session-of-visitor-number-{n}") for n in range(3)]
    raw_reservation(conversations[0], slot, status="booked")

    assert raw_reservation(conversations[1], elsewhere, status="booked").pk
    with pytest.raises(IntegrityError) as refusal, transaction.atomic(using="lb02"):
        raw_reservation(conversations[2], same_room, status="held")
    assert is_exclusion_violation(refusal.value)


@pytest.mark.parametrize("status", ["released", "expired"])
def test_released_and_expired_reservations_keep_nothing(slot: Slot, status: str) -> None:
    """Only held and booked reservations hold a room: a given-up one leaves it free for the next."""
    first = make_conversation(slot.offering, session="session-of-the-first-visitor")
    second = make_conversation(slot.offering, session="session-of-the-second-visitor")
    raw_reservation(first, slot, status=status)

    assert raw_reservation(second, slot, status="booked").pk


def test_the_database_refuses_a_second_hold_or_booking_for_one_conversation(slot: Slot, tasting: Offering) -> None:
    """One live hold and one booking per conversation, whatever code asks for more."""
    conversation = make_conversation(tasting)
    other_slot = make_slot(tasting, slot.starts_at + timedelta(hours=3))
    raw_reservation(conversation, slot, status="held")
    with pytest.raises(IntegrityError, match="lb02_one_hold_per_conversation"), transaction.atomic(using="lb02"):
        raw_reservation(conversation, other_slot, status="held")

    booked = make_conversation(tasting, session="session-of-the-second-visitor")
    raw_reservation(booked, slot.__class__.objects.get(pk=other_slot.pk), status="booked")
    third_slot = make_slot(tasting, slot.starts_at + timedelta(hours=6))
    with pytest.raises(IntegrityError, match="lb02_one_booking_per_conversation"), transaction.atomic(using="lb02"):
        raw_reservation(booked, third_slot, status="booked", idempotency_key="another")


def test_a_booking_must_carry_its_confirmation_and_every_range_must_be_bounded(slot: Slot) -> None:
    """The database refuses a booking nobody confirmed, and a reservation of unbounded time."""
    conversation = make_conversation(slot.offering)
    with pytest.raises(IntegrityError, match="lb02_booked_is_confirmed"), transaction.atomic(using="lb02"):
        raw_reservation(conversation, slot, status="booked", confirmed_at=None)
    with pytest.raises(IntegrityError, match="lb02_reservation_range_is_bounded"), transaction.atomic(using="lb02"):
        raw_reservation(conversation, slot, status="held", during=DateTimeTZRange(slot.starts_at, None, "[)"))
    with pytest.raises(IntegrityError, match="lb02_slot_range_is_bounded"), transaction.atomic(using="lb02"):
        Slot.objects.create(offering=slot.offering, during=DateTimeTZRange(None, slot.starts_at, "[)"))


def test_the_clock_the_service_uses_is_the_clock_it_was_given(service: BookingService, clock: FakeClock) -> None:
    """The fake clock really does drive the service, so the expiry tests above mean what they say."""
    assert service.clock() == clock()
    before: datetime = clock()
    clock.advance(10)
    assert service.clock() - before == timedelta(minutes=10)
