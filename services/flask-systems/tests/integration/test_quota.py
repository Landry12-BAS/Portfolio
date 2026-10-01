"""Tests for the quota ledger (lb05/quota.py) on a real Postgres: the limit holds even when questions arrive together.

A fake database can't show that: what is under test is one SQL statement that must be atomic, so the concurrency tests
send many questions at once from many threads, each on its own connection, and count how many were let in.
"""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta, timezone

import pytest
from sqlalchemy import Engine, insert, select
from sqlalchemy.exc import IntegrityError

from lb05.models import QuotaUsage
from lb05.quota import BUSY_SECONDS, KEEP_DAYS, Admission, PostgresLedger, midnight_after
from lb05.safety import QUESTIONS_PER_DAY
from tests.support import TODAY

pytestmark = pytest.mark.integration

VISITOR = "0" * 64
OTHER_VISITOR = "1" * 64
DAY = TODAY.date()


@dataclass
class MovableClock:
    """A clock a test moves by hand, in aware datetimes."""

    now: datetime = TODAY

    def __call__(self) -> datetime:
        """Return the time now."""
        return self.now

    def move(self, **amount: float) -> None:
        """Move the clock on, by any `timedelta` amount (seconds, days...)."""
        self.now += timedelta(**amount)


def count_of(engine: Engine, session_key: str = VISITOR, day: date = DAY) -> int | None:
    """Read a visitor's stored count for a day, or None when they have no row."""
    with engine.connect() as connection:
        return connection.execute(
            select(QuotaUsage.used).where(QuotaUsage.session_key == session_key, QuotaUsage.day == day)
        ).scalar_one_or_none()


def busy_until_of(engine: Engine, session_key: str = VISITOR, day: date = DAY) -> datetime | None:
    """Read when a visitor's running question stops holding their place, or None when none is running."""
    with engine.connect() as connection:
        return connection.execute(
            select(QuotaUsage.busy_until).where(QuotaUsage.session_key == session_key, QuotaUsage.day == day)
        ).scalar_one()


def put_row(engine: Engine, session_key: str, day: date, used: int) -> None:
    """Write a counter directly, as an earlier day's questions would have left it."""
    with engine.begin() as connection:
        connection.execute(insert(QuotaUsage).values(session_key=session_key, day=day, used=used))


def test_a_visitor_is_let_in_twenty_five_times_and_the_twenty_sixth_is_refused(engine: Engine) -> None:
    """The datasheet's promise, counted by Postgres: 25 questions a day, one at a time, and no 26th."""
    ledger = PostgresLedger(engine, MovableClock())

    admitted = []
    for _ in range(QUESTIONS_PER_DAY):
        admission = ledger.admit(VISITOR)
        admitted.append(admission)
        ledger.finish(admission, refund=False)
    refused = ledger.admit(VISITOR)

    assert [admission.allowed for admission in admitted] == [True] * QUESTIONS_PER_DAY
    assert [admission.used for admission in admitted] == list(range(1, QUESTIONS_PER_DAY + 1))
    assert admitted[-1].remaining == 0
    assert (refused.allowed, refused.reason, refused.used, refused.remaining) == (False, "daily_limit", 25, 0)
    assert count_of(engine) == QUESTIONS_PER_DAY


def test_a_visitor_has_one_question_running_at_a_time(engine: Engine) -> None:
    """A second question is refused as busy, without costing anything, until the first one ends."""
    ledger = PostgresLedger(engine, MovableClock())

    first = ledger.admit(VISITOR)
    second = ledger.admit(VISITOR)
    ledger.finish(first, refund=False)
    third = ledger.admit(VISITOR)

    assert (first.allowed, first.used) == (True, 1)
    assert (second.allowed, second.reason, second.used) == (False, "busy", 1)
    assert (third.allowed, third.used) == (True, 2)
    assert busy_until_of(engine) is not None


def test_a_question_that_never_ends_stops_holding_its_visitor_when_its_time_is_up(engine: Engine) -> None:
    """If a process dies mid-question the busy flag runs out on its own, and not a second early."""
    clock = MovableClock()
    ledger = PostgresLedger(engine, clock)
    ledger.admit(VISITOR)

    clock.move(seconds=BUSY_SECONDS - 1)
    too_early = ledger.admit(VISITOR)
    clock.move(seconds=1)
    on_time = ledger.admit(VISITOR)

    assert (too_early.allowed, too_early.reason) == (False, "busy")
    assert (on_time.allowed, on_time.used) == (True, 2)


def test_a_refund_gives_the_place_back_and_frees_the_visitor(engine: Engine) -> None:
    """A question the service failed to answer costs the visitor nothing, and they can ask again at once."""
    ledger = PostgresLedger(engine, MovableClock())

    failed = ledger.admit(VISITOR)
    ledger.finish(failed, refund=True)
    again = ledger.admit(VISITOR)

    assert count_of(engine) == 1
    assert (again.allowed, again.used) == (True, 1)
    assert busy_until_of(engine) is not None


def test_a_refund_never_takes_a_count_below_zero(engine: Engine) -> None:
    """Ending a question twice can't push a visitor's count negative."""
    ledger = PostgresLedger(engine, MovableClock())
    admission = ledger.admit(VISITOR)

    ledger.finish(admission, refund=True)
    ledger.finish(admission, refund=True)

    assert count_of(engine) == 0


def test_ending_a_question_that_was_never_admitted_changes_nothing(engine: Engine) -> None:
    """A refused question has nothing to give back, and ending it must not free the question that is running."""
    ledger = PostgresLedger(engine, MovableClock())
    running = ledger.admit(VISITOR)
    refused = ledger.admit(VISITOR)

    ledger.finish(refused, refund=True)

    assert not refused.allowed
    assert count_of(engine) == 1
    assert busy_until_of(engine) is not None
    ledger.finish(running, refund=False)
    assert busy_until_of(engine) is None


def test_the_count_starts_again_at_midnight_utc(engine: Engine) -> None:
    """The day is the UTC day: the last second of it still counts, the first second of the next starts again."""
    clock = MovableClock(datetime(2026, 10, 1, 23, 59, 58, tzinfo=UTC))
    ledger = PostgresLedger(engine, clock, limit=1, busy_seconds=0)
    first = ledger.admit(VISITOR)

    clock.move(seconds=1)
    still_today = ledger.admit(VISITOR)
    clock.move(seconds=1)
    tomorrow = ledger.admit(VISITOR)

    assert first.allowed
    assert (still_today.allowed, still_today.reason) == (False, "daily_limit")
    assert (tomorrow.allowed, tomorrow.day, tomorrow.used) == (True, date(2026, 10, 2), 1)
    assert count_of(engine, day=date(2026, 10, 1)) == 1


def test_the_day_is_the_utc_day_whatever_zone_the_clock_is_in(engine: Engine) -> None:
    """A clock in another zone is read in UTC: 23:30 at UTC-5 on the 1st is 04:30 UTC on the 2nd."""
    zone = timezone(timedelta(hours=-5))
    ledger = PostgresLedger(engine, lambda: datetime(2026, 10, 1, 23, 30, tzinfo=zone))

    admission = ledger.admit(VISITOR)

    assert admission.day == date(2026, 10, 2)
    assert ledger.usage(VISITOR).resets_at == datetime(2026, 10, 3, tzinfo=UTC)


def test_visitors_are_counted_apart(engine: Engine) -> None:
    """One visitor using up their day or holding a question leaves another's untouched."""
    ledger = PostgresLedger(engine, MovableClock(), limit=1)

    first = ledger.admit(VISITOR)
    other = ledger.admit(OTHER_VISITOR)
    again = ledger.admit(VISITOR)

    assert (first.allowed, other.allowed) == (True, True)
    assert not again.allowed
    assert count_of(engine, OTHER_VISITOR) == 1


def test_usage_reads_the_count_and_the_reset_without_changing_anything(engine: Engine) -> None:
    """Looking at the count never costs a question and never starts a row."""
    ledger = PostgresLedger(engine, MovableClock())
    before = ledger.usage(VISITOR)
    ledger.admit(VISITOR)
    after = ledger.usage(VISITOR)

    assert (before.used, before.remaining) == (0, QUESTIONS_PER_DAY)
    assert (after.used, after.remaining) == (1, QUESTIONS_PER_DAY - 1)
    assert after.resets_at == midnight_after(DAY) == datetime(2026, 10, 2, tzinfo=UTC)
    assert count_of(engine, OTHER_VISITOR) is None


def admit_together(ledger: PostgresLedger, visitors: list[str]) -> list[Admission]:
    """Send one question for each name in `visitors` at the same moment, from many threads, and collect the answers."""
    with ThreadPoolExecutor(max_workers=16) as pool:
        return list(pool.map(ledger.admit, visitors))


def test_questions_arriving_together_never_take_more_than_the_limit(engine: Engine) -> None:
    """Sixty questions at once from one visitor: exactly 25 are admitted, and the stored count is exactly 25.

    The busy flag is off here (a busy time of zero), so only the limit is being tested: this is the case where
    a read-then-write ledger would let a few extra through.
    """
    ledger = PostgresLedger(engine, MovableClock(), busy_seconds=0)

    admissions = admit_together(ledger, [VISITOR] * 60)

    allowed = [admission for admission in admissions if admission.allowed]
    refused = [admission for admission in admissions if not admission.allowed]
    assert len(allowed) == QUESTIONS_PER_DAY
    assert sorted(admission.used for admission in allowed) == list(range(1, QUESTIONS_PER_DAY + 1))
    assert {admission.reason for admission in refused} == {"daily_limit"}
    assert count_of(engine) == QUESTIONS_PER_DAY


def test_questions_arriving_together_from_one_visitor_run_one_at_a_time(engine: Engine) -> None:
    """Thirty questions at once from one visitor: one is admitted, and every other one is told to wait."""
    ledger = PostgresLedger(engine, MovableClock())

    admissions = admit_together(ledger, [VISITOR] * 30)

    assert sum(admission.allowed for admission in admissions) == 1
    assert {admission.reason for admission in admissions if not admission.allowed} == {"busy"}
    assert count_of(engine) == 1


def test_questions_arriving_together_from_different_visitors_are_all_admitted(engine: Engine) -> None:
    """One visitor's question running never holds up another's."""
    ledger = PostgresLedger(engine, MovableClock())
    visitors = [f"{number:064x}" for number in range(20)]

    admissions = admit_together(ledger, visitors)

    assert all(admission.allowed for admission in admissions)
    assert all(count_of(engine, visitor) == 1 for visitor in visitors)


def test_the_sweep_removes_only_the_days_that_are_long_over(engine: Engine) -> None:
    """Counters are kept for today and the days just gone, and deleted after: no history of a visitor is kept."""
    ledger = PostgresLedger(engine, MovableClock())
    put_row(engine, VISITOR, DAY, 3)
    put_row(engine, VISITOR, DAY - timedelta(days=KEEP_DAYS), 4)
    put_row(engine, VISITOR, DAY - timedelta(days=KEEP_DAYS + 1), 5)
    put_row(engine, OTHER_VISITOR, DAY - timedelta(days=30), 6)

    removed = ledger.sweep()

    assert removed == 2
    assert count_of(engine, VISITOR, DAY) == 3
    assert count_of(engine, VISITOR, DAY - timedelta(days=KEEP_DAYS)) == 4
    assert count_of(engine, VISITOR, DAY - timedelta(days=KEEP_DAYS + 1)) is None
    assert count_of(engine, OTHER_VISITOR, DAY - timedelta(days=30)) is None


@pytest.mark.parametrize("used", [-1, 1001])
def test_the_database_itself_refuses_a_count_out_of_range(engine: Engine, used: int) -> None:
    """A bug elsewhere can't write a nonsense count: the table's check constraint holds the line."""
    with pytest.raises(IntegrityError):
        put_row(engine, VISITOR, DAY, used)
