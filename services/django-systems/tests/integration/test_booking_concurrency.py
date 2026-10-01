"""Concurrency tests for LB-02's booking rules: real transactions on real connections, racing for one slot.

Each racer runs in a thread of its own, so it has its own database connection and its own
transaction, and a barrier lets them go at the same moment. Whatever order Postgres picks,
exactly one of them may win a slot, and the losers must be told so rather than fail.

These tests commit for real (`transaction=True`), because a racer can't see rows another
connection hasn't committed. The database is emptied after each of them.
"""

import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor

import pytest
from django.db import IntegrityError, connections, transaction

from lb02.booking import BookingError, BookingService, ConfirmResult, HoldResult, Refusal, is_exclusion_violation
from lb02.models import Conversation, Offering, Reservation, Slot
from tests.lb02_support import (
    FakeClock,
    make_conversation,
    make_offering,
    make_room,
    make_slot,
    raw_reservation,
    tomorrow_at,
)

pytestmark = [pytest.mark.integration, pytest.mark.django_db(databases=["lb02"], transaction=True)]

RACERS = 8
# How long a test waits for its threads before giving up, so a deadlock fails the test instead of hanging it.
PATIENCE_SECONDS = 20


def race[Outcome](jobs: list[Callable[[], Outcome]]) -> list[Outcome | Exception]:
    """Run every job in its own thread, all released at once, and return each job's result or the error it raised."""
    barrier = threading.Barrier(len(jobs))

    def run(job: Callable[[], Outcome]) -> Outcome | Exception:
        """Wait for the others, run the job on this thread's own connection, and close it afterwards."""
        try:
            barrier.wait(timeout=PATIENCE_SECONDS)
            return job()
        except Exception as error:  # noqa: BLE001 - the test reads each racer's error as its result
            return error
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        futures = [pool.submit(run, job) for job in jobs]
        return [future.result(timeout=PATIENCE_SECONDS) for future in futures]


@pytest.fixture
def clock() -> FakeClock:
    """Return a clock that starts on a Thursday morning and moves only when a test moves it."""
    return FakeClock()


@pytest.fixture
def service(clock: FakeClock) -> BookingService:
    """Build the booking rules on the test clock, which every racer shares."""
    return BookingService(clock=clock)


@pytest.fixture
def slot(clock: FakeClock) -> Slot:
    """Tomorrow at 14:00, Prague time, in a room of its own."""
    return make_slot(make_offering(make_room(), key="tasting"), tomorrow_at(clock, 14))


def visitors(offering: Offering, count: int = RACERS) -> list[int]:
    """Create a conversation for each racer, with every detail collected, and return their IDs."""
    return [make_conversation(offering, session=f"session-of-racing-visitor-{n:02d}").pk for n in range(count)]


def hold_job(service: BookingService, conversation_id: int, slot_id: int) -> Callable[[], HoldResult]:
    """Make the job a racer runs: look the rows up on its own connection, then try to hold the slot."""

    def job() -> HoldResult:
        """Hold the slot as the conversation."""
        conversation = Conversation.objects.get(pk=conversation_id)
        slot = Slot.objects.select_related("offering").get(pk=slot_id)
        return service.place_hold(conversation, slot)

    return job


def test_eight_conversations_racing_for_one_slot_produce_exactly_one_hold(service: BookingService, slot: Slot) -> None:
    """One wins; the other seven are told the slot is taken; the table holds one active reservation."""
    outcomes = race([hold_job(service, conversation, slot.pk) for conversation in visitors(slot.offering)])

    winners = [outcome for outcome in outcomes if isinstance(outcome, HoldResult)]
    losers = [outcome for outcome in outcomes if isinstance(outcome, BookingError)]
    assert len(winners) == 1
    assert len(losers) == RACERS - 1
    assert {loser.code for loser in losers} == {Refusal.SLOT_UNAVAILABLE}
    assert Reservation.objects.filter(status=Reservation.Status.HELD).count() == 1
    assert Reservation.objects.get().pk == winners[0].reservation.pk


def test_racing_for_a_slot_whose_old_hold_ran_out_still_produces_exactly_one_hold(
    service: BookingService, slot: Slot, clock: FakeClock
) -> None:
    """A stale hold the sweep never cleared neither blocks the new holders nor lets two of them through."""
    stale_holder = make_conversation(slot.offering, session="session-of-the-forgetful-visitor")
    service.place_hold(stale_holder, slot)
    clock.advance(6)

    outcomes = race([hold_job(service, conversation, slot.pk) for conversation in visitors(slot.offering)])

    winners = [outcome for outcome in outcomes if isinstance(outcome, HoldResult)]
    assert len(winners) == 1
    assert {outcome.code for outcome in outcomes if isinstance(outcome, BookingError)} == {Refusal.SLOT_UNAVAILABLE}
    assert Reservation.objects.get(conversation=stale_holder).status == Reservation.Status.EXPIRED
    assert Reservation.objects.filter(status=Reservation.Status.HELD).count() == 1


def test_a_model_that_holds_the_same_slot_twice_at_once_still_holds_it_once(
    service: BookingService, slot: Slot
) -> None:
    """Two simultaneous calls from one conversation end with one hold, whichever got there first."""
    [conversation] = visitors(slot.offering, count=1)

    outcomes = race([hold_job(service, conversation, slot.pk), hold_job(service, conversation, slot.pk)])

    assert Reservation.objects.filter(status=Reservation.Status.HELD).count() == 1
    results = [outcome for outcome in outcomes if isinstance(outcome, HoldResult)]
    assert results, f"neither call held the slot: {outcomes}"
    assert {result.reservation.pk for result in results} == {Reservation.objects.get().pk}


def confirm_job(service: BookingService, conversation_id: int, key: str) -> Callable[[], ConfirmResult]:
    """Make the job a racer runs: confirm the conversation's hold with this key."""

    def job() -> ConfirmResult:
        """Confirm as the conversation."""
        return service.confirm_hold(Conversation.objects.get(pk=conversation_id), key)

    return job


def test_two_confirms_with_one_key_make_one_booking(service: BookingService, slot: Slot) -> None:
    """Both calls return the booking; exactly one of them is the call that made it."""
    [conversation_id] = visitors(slot.offering, count=1)
    service.place_hold(Conversation.objects.get(pk=conversation_id), slot)

    outcomes = race(
        [confirm_job(service, conversation_id, "confirm-1"), confirm_job(service, conversation_id, "confirm-1")]
    )

    results = [outcome for outcome in outcomes if isinstance(outcome, ConfirmResult)]
    assert len(results) == 2, f"every call should have got the booking: {outcomes}"
    assert sorted(result.replayed for result in results) == [False, True]
    assert Reservation.objects.filter(status=Reservation.Status.BOOKED).count() == 1


def test_two_confirms_with_different_keys_make_one_booking(service: BookingService, slot: Slot) -> None:
    """The conversation gets one booking; the other request is told it already has one."""
    [conversation_id] = visitors(slot.offering, count=1)
    service.place_hold(Conversation.objects.get(pk=conversation_id), slot)

    outcomes = race(
        [confirm_job(service, conversation_id, "confirm-1"), confirm_job(service, conversation_id, "confirm-2")]
    )

    assert sum(isinstance(outcome, ConfirmResult) for outcome in outcomes) == 1
    refusals = [outcome for outcome in outcomes if isinstance(outcome, BookingError)]
    assert [refusal.code for refusal in refusals] == [Refusal.ALREADY_BOOKED]
    assert Reservation.objects.filter(status=Reservation.Status.BOOKED).count() == 1


def wait_until_a_backend_waits_on_a_lock() -> None:
    """Block until some connection to this database is waiting for a lock another one holds."""
    deadline = time.monotonic() + PATIENCE_SECONDS
    while time.monotonic() < deadline:
        with connections["lb02"].cursor() as cursor:
            cursor.execute(
                "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'"
            )
            row = cursor.fetchone()
        if row is not None and row[0] > 0:
            return
        time.sleep(0.02)
    raise AssertionError("no transaction ever waited for another one's lock")


def two_transactions(slot: Slot, first_ends: str) -> tuple[str, str]:
    """Run two transactions that insert overlapping reservations, the first ending as `first_ends` says.

    The first inserts and then waits, its transaction still open. The test sees the
    second block on it inside Postgres, then lets the first commit or roll back, and
    reports what each transaction ended up doing.
    """
    first_conversation, second_conversation = visitors(slot.offering, count=2)
    first_has_inserted = threading.Event()
    first_may_end = threading.Event()

    def first() -> str:
        """Insert, hold the transaction open, then commit or roll back."""
        try:
            with transaction.atomic(using="lb02"):
                raw_reservation(Conversation.objects.get(pk=first_conversation), slot)
                first_has_inserted.set()
                first_may_end.wait(timeout=PATIENCE_SECONDS)
                if first_ends == "rolls back":
                    transaction.set_rollback(True, using="lb02")
            return first_ends
        finally:
            connections.close_all()

    def second() -> str:
        """Insert an overlapping reservation once the first has, and report whether the database allowed it."""
        try:
            first_has_inserted.wait(timeout=PATIENCE_SECONDS)
            with transaction.atomic(using="lb02"):
                raw_reservation(Conversation.objects.get(pk=second_conversation), slot)
            return "inserted"
        except IntegrityError as error:
            return "refused" if is_exclusion_violation(error) else f"failed: {error}"
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        first_future = pool.submit(first)
        second_future = pool.submit(second)
        first_has_inserted.wait(timeout=PATIENCE_SECONDS)
        wait_until_a_backend_waits_on_a_lock()
        assert not second_future.done(), "the second transaction should be waiting for the first"
        first_may_end.set()
        return first_future.result(timeout=PATIENCE_SECONDS), second_future.result(timeout=PATIENCE_SECONDS)


def test_a_second_transaction_waits_for_the_first_and_is_refused_when_it_commits(slot: Slot) -> None:
    """Postgres makes the second inserter wait for the first, then refuses it: exactly one reservation survives."""
    first, second = two_transactions(slot, first_ends="commits")

    assert (first, second) == ("commits", "refused")
    assert Reservation.objects.count() == 1


def test_a_second_transaction_gets_the_slot_when_the_first_rolls_back(slot: Slot) -> None:
    """If the first transaction gives up, the one that waited for it is let through: still exactly one reservation."""
    first, second = two_transactions(slot, first_ends="rolls back")

    assert (first, second) == ("rolls back", "inserted")
    assert Reservation.objects.count() == 1
