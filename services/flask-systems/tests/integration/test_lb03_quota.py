"""Tests for LB-03's daily document count (lb03/quota.py) on a real Postgres.

The ledger's promise is atomicity: ten documents a day and two at a time, even when uploads arrive together. A fake
database would only imitate that, so these tests run the real statements, and the races on real threads.
"""

import threading
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import Engine, insert, select

from lb03 import limits
from lb03.models import QuotaUsage
from lb03.quota import PostgresLedger, midnight_after

pytestmark = pytest.mark.integration

SAM = "session-of-sam-visitor-0001"
ALEX = "session-of-alex-visitor-0002"
NOON = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)


class Clock:
    """A clock a test sets, so a day can end in the middle of a test."""

    def __init__(self, now: datetime = NOON) -> None:
        """Start at `now`."""
        self.now = now

    def __call__(self) -> datetime:
        """Return the time the test has set."""
        return self.now


def make_ledger(engine: Engine, clock: Clock | None = None, **settings: int) -> PostgresLedger:
    """Make a ledger on the test schema, with the real limits unless a test sets its own."""
    return PostgresLedger(engine, clock or Clock(), **settings)


def row_of(engine: Engine, session_key: str, clock: Clock | None = None) -> tuple[int, int, int]:
    """Read a visitor's (used, active, refunds) of the clock's day straight from the table."""
    day = (clock or Clock()).now.date()
    with engine.connect() as connection:
        row = connection.execute(
            select(QuotaUsage.used, QuotaUsage.active, QuotaUsage.refunds).where(
                QuotaUsage.session_key == session_key, QuotaUsage.day == day
            )
        ).one()
    return (row.used, row.active, row.refunds)


def run_together(count: int, work: Callable[[], object]) -> list[object]:
    """Run `work` on `count` threads that all start at the same moment, and return what each returned."""
    barrier = threading.Barrier(count)
    results: list[object] = [None] * count

    def worker(index: int) -> None:
        """Wait for the others, then do the work."""
        barrier.wait()
        results[index] = work()

    threads = [threading.Thread(target=worker, args=(index,)) for index in range(count)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return results


def test_the_real_limits_are_ten_a_day_and_two_at_a_time() -> None:
    """The ledger's defaults are the datasheet's promise."""
    assert limits.DOCUMENTS_PER_DAY == 10
    assert limits.MAX_ACTIVE_PER_VISITOR == 2


def test_a_visitor_is_admitted_until_the_limit_and_then_told_when_it_starts_again(lb03_engine: Engine) -> None:
    """Three documents a day and the fourth is refused with `daily_limit`; another visitor is not affected."""
    ledger = make_ledger(lb03_engine, limit=3, max_active=20)

    for expected in (1, 2, 3):
        admission = ledger.admit(SAM)
        assert (admission.allowed, admission.reason, admission.used) == (True, "ok", expected)
        ledger.release(SAM, admission.day, refund=False)
    refused = ledger.admit(SAM)

    assert (refused.allowed, refused.reason, refused.used, refused.remaining) == (False, "daily_limit", 3, 0)
    assert ledger.admit(ALEX).allowed
    usage = ledger.usage(SAM)
    assert (usage.used, usage.limit, usage.remaining) == (3, 3, 0)
    assert usage.resets_at == datetime(2026, 10, 2, tzinfo=UTC)


def test_only_two_documents_are_read_at_a_time_and_a_finished_one_makes_room(lb03_engine: Engine) -> None:
    """The third upload while two are being read is `busy`, which is not the daily limit and passes with the work."""
    ledger = make_ledger(lb03_engine)
    first = ledger.admit(SAM)
    assert ledger.admit(SAM).allowed

    busy = ledger.admit(SAM)

    assert (busy.allowed, busy.reason, busy.used) == (False, "busy", 2)
    ledger.release(SAM, first.day, refund=False)
    assert ledger.admit(SAM).allowed
    assert row_of(lb03_engine, SAM) == (3, 2, 0)


def test_uploads_arriving_together_cannot_take_more_places_than_there_are(lb03_engine: Engine) -> None:
    """Thirty uploads at the same moment against ten places: exactly ten are admitted, none twice."""
    ledger = make_ledger(lb03_engine, max_active=20)

    results = run_together(30, lambda: ledger.admit(SAM))

    allowed = [result for result in results if getattr(result, "allowed", False)]
    assert len(allowed) == limits.DOCUMENTS_PER_DAY
    assert sorted(getattr(result, "used", 0) for result in allowed) == list(range(1, 11))
    assert row_of(lb03_engine, SAM) == (10, 10, 0)


def test_uploads_arriving_together_cannot_hold_more_than_two_worker_slots(lb03_engine: Engine) -> None:
    """Ten uploads at the same moment by one visitor: two get in, eight are told the workers are busy."""
    ledger = make_ledger(lb03_engine)

    results = run_together(10, lambda: ledger.admit(SAM))

    reasons = sorted(getattr(result, "reason", "") for result in results)
    assert reasons == ["busy"] * 8 + ["ok"] * 2
    assert row_of(lb03_engine, SAM) == (2, 2, 0)


def test_a_failure_of_the_service_gives_the_place_back(lb03_engine: Engine) -> None:
    """A document the service failed to read does not cost the visitor one of their ten."""
    ledger = make_ledger(lb03_engine)
    admission = ledger.admit(SAM)

    given_back = ledger.release(SAM, admission.day, refund=True)

    assert given_back is True
    assert row_of(lb03_engine, SAM) == (0, 0, 1)
    assert ledger.usage(SAM).remaining == limits.DOCUMENTS_PER_DAY


def test_a_document_turned_away_at_the_door_gives_its_place_back_without_spending_a_refund(lb03_engine: Engine) -> None:
    """The readers being full is not the visitor's doing: any number of such refusals leave their day as it was."""
    ledger = make_ledger(lb03_engine)

    for _ in range(limits.MAX_REFUNDS_PER_DAY + 2):
        admission = ledger.admit(SAM)
        assert admission.allowed
        ledger.release_unstarted(SAM, admission.day)

    assert row_of(lb03_engine, SAM) == (0, 0, 0)
    assert ledger.usage(SAM).remaining == limits.DOCUMENTS_PER_DAY


def test_places_given_back_are_capped_so_a_failure_made_on_purpose_stays_bounded(lb03_engine: Engine) -> None:
    """After three refunds a day the fourth failure frees its worker slot but costs the visitor the place."""
    ledger = make_ledger(lb03_engine)
    given = []

    for _ in range(limits.MAX_REFUNDS_PER_DAY + 2):
        admission = ledger.admit(SAM)
        assert admission.allowed
        given.append(ledger.release(SAM, admission.day, refund=True))

    assert given == [True] * limits.MAX_REFUNDS_PER_DAY + [False, False]
    assert row_of(lb03_engine, SAM) == (2, 0, limits.MAX_REFUNDS_PER_DAY)


def test_refunds_that_arrive_together_cannot_pass_the_cap(lb03_engine: Engine) -> None:
    """Refunds are checked by the statement that gives them, so ten at the same moment give back exactly three."""
    ledger = make_ledger(lb03_engine, limit=20, max_active=20)
    days = [ledger.admit(SAM).day for _ in range(10)]

    results = run_together(10, lambda: ledger.release(SAM, days[0], refund=True))

    assert sum(1 for result in results if result is True) == limits.MAX_REFUNDS_PER_DAY
    used, active, refunds = row_of(lb03_engine, SAM)
    assert (used, active, refunds) == (10 - limits.MAX_REFUNDS_PER_DAY, 0, limits.MAX_REFUNDS_PER_DAY)


def test_a_document_that_ends_without_a_refund_keeps_its_place(lb03_engine: Engine) -> None:
    """A document the visitor's own file made fail (or that finished) is counted, and frees only its slot."""
    ledger = make_ledger(lb03_engine)
    admission = ledger.admit(SAM)

    assert ledger.release(SAM, admission.day, refund=False) is False

    assert row_of(lb03_engine, SAM) == (1, 0, 0)


def test_releasing_more_than_was_admitted_never_makes_a_counter_negative(lb03_engine: Engine) -> None:
    """A double release (a bug elsewhere) is absorbed: the counters stop at zero instead of tripping a check."""
    ledger = make_ledger(lb03_engine)
    admission = ledger.admit(SAM)

    ledger.release(SAM, admission.day, refund=False)
    ledger.release(SAM, admission.day, refund=False)
    ledger.release(SAM, admission.day, refund=True)
    ledger.release(SAM, admission.day, refund=True)

    used, active, _ = row_of(lb03_engine, SAM)
    assert (used, active) == (0, 0)


def test_a_new_day_starts_a_new_count_and_a_document_is_released_on_the_day_it_was_counted(
    lb03_engine: Engine,
) -> None:
    """A document admitted before midnight and failed after it gives its place back to the day it was taken from."""
    clock = Clock(datetime(2026, 10, 1, 23, 59, tzinfo=UTC))
    ledger = make_ledger(lb03_engine, clock, limit=2, max_active=20)
    first = ledger.admit(SAM)
    ledger.release(SAM, first.day, refund=False)
    assert ledger.admit(SAM).allowed
    assert not ledger.admit(SAM).allowed

    clock.now = datetime(2026, 10, 2, 0, 1, tzinfo=UTC)
    assert ledger.admit(SAM).used == 1
    assert ledger.release(SAM, first.day, refund=True) is True

    # The first day's row had two places counted and one worker slot held; the refund took one of each.
    assert row_of(lb03_engine, SAM, Clock(datetime(2026, 10, 1, tzinfo=UTC))) == (1, 0, 1)
    assert row_of(lb03_engine, SAM, clock) == (1, 1, 0)


def test_the_counters_of_days_that_are_over_are_deleted_and_no_history_is_kept(lb03_engine: Engine) -> None:
    """The first upload of a day sweeps the counters older than two days, so retention needs no scheduler."""
    clock = Clock()
    with lb03_engine.begin() as connection:
        connection.execute(
            insert(QuotaUsage).values(session_key=SAM, day=(clock.now - timedelta(days=3)).date(), used=4)
        )
        connection.execute(
            insert(QuotaUsage).values(session_key=SAM, day=(clock.now - timedelta(days=1)).date(), used=2)
        )
    ledger = make_ledger(lb03_engine, clock)

    ledger.admit(ALEX)

    with lb03_engine.connect() as connection:
        days = connection.execute(select(QuotaUsage.day).where(QuotaUsage.session_key == SAM)).scalars().all()
    assert days == [(clock.now - timedelta(days=1)).date()]


def test_the_sweep_command_counts_what_it_removed(lb03_engine: Engine) -> None:
    """`sweep()` is what `manage.py sweep_lb03` calls: it returns the number of counters it deleted."""
    clock = Clock()
    with lb03_engine.begin() as connection:
        connection.execute(insert(QuotaUsage).values(session_key=SAM, day=(clock.now - timedelta(days=5)).date()))
        connection.execute(insert(QuotaUsage).values(session_key=ALEX, day=(clock.now - timedelta(days=9)).date()))
        connection.execute(insert(QuotaUsage).values(session_key=ALEX, day=clock.now.date(), used=1))

    removed = make_ledger(lb03_engine, clock).sweep()

    assert removed == 2
    with lb03_engine.connect() as connection:
        assert connection.execute(select(QuotaUsage.used)).scalars().all() == [1]


def test_a_visitor_with_no_documents_today_has_every_place_and_nothing_running(lb03_engine: Engine) -> None:
    """Reading the count of someone who has not uploaded creates nothing and reports zero."""
    usage = make_ledger(lb03_engine).usage(SAM)

    assert (usage.used, usage.active, usage.remaining) == (0, 0, limits.DOCUMENTS_PER_DAY)
    with lb03_engine.connect() as connection:
        assert connection.execute(select(QuotaUsage)).first() is None


def test_midnight_after_a_day_is_the_start_of_the_next_one_in_utc() -> None:
    """The board is told when the count starts again, at midnight UTC."""
    assert midnight_after(NOON.date()) == datetime(2026, 10, 2, tzinfo=UTC)
