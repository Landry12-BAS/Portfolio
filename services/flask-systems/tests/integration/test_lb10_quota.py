"""Tests for LB-10's quota ledger on a real Postgres: one run a day, one at a time, and the refunds."""

import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import Engine

from lb10.limits import MAX_REFUNDS_PER_DAY, RUNS_PER_DAY
from lb10.quota import PostgresLedger, midnight_after

pytestmark = pytest.mark.integration

NOON = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)
SESSION = "session-of-sam-visitor-0001"


class Clock:
    """A clock a test moves by hand."""

    def __init__(self, now: datetime = NOON) -> None:
        """Start at `now`."""
        self.now = now

    def __call__(self) -> datetime:
        """Return the time."""
        return self.now


def make_ledger(engine: Engine, clock: Clock | None = None, **settings: int) -> PostgresLedger:
    """Build a ledger on the test engine with the real limits unless a test changes them."""
    return PostgresLedger(engine, clock or Clock(), **settings)


def test_a_visitor_has_one_run_a_day_and_is_told_when_the_count_starts_again(lb10_engine: Engine) -> None:
    """The datasheet's promise: one run, then the day's limit, which starts again at midnight UTC."""
    clock = Clock()
    ledger = make_ledger(lb10_engine, clock)
    assert RUNS_PER_DAY == 1

    first = ledger.admit(SESSION)
    assert (first.allowed, first.used, first.remaining) == (True, 1, 0)
    ledger.finish(first, refund=False)
    second = ledger.admit(SESSION)
    assert (second.allowed, second.reason) == (False, "daily_limit")
    assert ledger.usage(SESSION).resets_at == midnight_after(NOON.date())
    clock.now = NOON + timedelta(days=1)
    assert ledger.admit(SESSION).allowed


def test_a_running_run_blocks_a_second_until_it_ends_or_its_flag_expires(lb10_engine: Engine) -> None:
    """One run at a time, even if the limit allowed more; a dead worker's flag expires on its own."""
    clock = Clock()
    ledger = make_ledger(lb10_engine, clock, limit=3, busy_seconds=60)
    first = ledger.admit(SESSION)
    assert first.allowed
    assert ledger.admit(SESSION).reason == "busy"
    ledger.finish(first, refund=False)
    assert ledger.admit(SESSION).allowed
    clock.now = NOON + timedelta(seconds=61)
    assert ledger.admit(SESSION).allowed


def test_a_refund_gives_the_place_back_a_capped_number_of_times(lb10_engine: Engine) -> None:
    """The service's failure costs the visitor nothing, twice a day; after that a failed run counts."""
    ledger = make_ledger(lb10_engine, limit=10)
    for _ in range(MAX_REFUNDS_PER_DAY):
        admission = ledger.admit(SESSION)
        assert ledger.finish(admission, refund=True)
    assert ledger.usage(SESSION).used == 0
    admission = ledger.admit(SESSION)
    assert not ledger.finish(admission, refund=True)
    assert ledger.usage(SESSION).used == 1


def test_a_run_that_never_started_hands_its_place_back_without_spending_a_refund(lb10_engine: Engine) -> None:
    """Undoing an admission is not a refund: it works however many were given, and leaves the refunds untouched."""
    ledger = make_ledger(lb10_engine)
    for _ in range(MAX_REFUNDS_PER_DAY + 2):
        ledger.release(ledger.admit(SESSION))
    assert ledger.usage(SESSION).used == 0
    admission = ledger.admit(SESSION)
    assert admission.allowed
    assert ledger.finish(admission, refund=True)
    counted = ledger.admit(SESSION)
    assert counted.allowed
    ledger.finish(counted, refund=False)
    # Releasing a request that was never admitted gives nothing back.
    not_admitted = ledger.admit(SESSION)
    ledger.release(not_admitted)
    assert (not_admitted.allowed, ledger.usage(SESSION).used) == (False, 1)


def test_requests_arriving_together_cannot_both_take_the_one_place(lb10_engine: Engine) -> None:
    """The admission is one atomic upsert: of many requests at once, exactly one is admitted."""
    ledger = make_ledger(lb10_engine)
    gate = threading.Barrier(6)

    def try_once(_: int) -> bool:
        """Wait for everyone, then ask."""
        gate.wait(timeout=10)
        return ledger.admit(SESSION).allowed

    with ThreadPoolExecutor(max_workers=6) as pool:
        admitted = list(pool.map(try_once, range(6)))
    assert admitted.count(True) == 1


def test_the_sweep_deletes_the_counters_of_days_that_are_over(lb10_engine: Engine) -> None:
    """No history of a visitor is kept past their day."""
    clock = Clock()
    ledger = make_ledger(lb10_engine, clock)
    ledger.finish(ledger.admit(SESSION), refund=False)
    clock.now = NOON + timedelta(days=3)
    assert ledger.sweep() == 1
    assert ledger.usage(SESSION).used == 0


def make_runner_free(callback: Callable[[], None]) -> None:
    """Call a callback, for symmetry with the runner tests that end a run."""
    callback()
