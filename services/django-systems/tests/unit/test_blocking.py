"""Tests for core.blocking: blocking work runs off the event loop, and leaves no database connection behind."""

import asyncio
import threading

import pytest
from django.db import connections

from core.blocking import closing_connections, run_blocking


class Closings:
    """Counts how many times a thread's connections were closed."""

    def __init__(self) -> None:
        """Start with none."""
        self.count = 0

    def __call__(self) -> None:
        """Record one closing."""
        self.count += 1


@pytest.fixture
def closings(monkeypatch: pytest.MonkeyPatch) -> Closings:
    """Replace the closing of connections with a counter, so no test needs a database to see it happen."""
    counter = Closings()
    monkeypatch.setattr(connections, "close_all", counter)
    return counter


def test_work_that_finishes_closes_the_connections_and_returns_its_result(closings: Closings) -> None:
    """The wrapper is invisible: the same arguments in, the same result out, and the connections closed after."""

    def add(first: int, second: int) -> int:
        """Add two numbers."""
        return first + second

    assert closing_connections(add)(2, 3) == 5
    assert closings.count == 1


def test_work_that_fails_closes_the_connections_too(closings: Closings) -> None:
    """However the work ends, the thread leaves nothing open, and the error carries on."""

    def explode() -> None:
        """Fail."""
        raise RuntimeError("the model call failed")

    with pytest.raises(RuntimeError, match="the model call failed"):
        closing_connections(explode)()

    assert closings.count == 1


def test_the_wrapped_work_keeps_its_name_and_its_docstring(closings: Closings) -> None:  # noqa: ARG001
    """It is wrapped with functools.wraps, so traces and logs still name the work."""

    def take_turn() -> None:
        """Answer a message."""

    wrapped = closing_connections(take_turn)

    assert (wrapped.__name__, wrapped.__doc__) == ("take_turn", "Answer a message.")


async def test_blocking_work_runs_on_a_thread_of_its_own_and_the_loop_stays_free(closings: Closings) -> None:
    """While one visitor's work sleeps, the event loop that serves every other visitor goes on."""
    loop_thread = threading.get_ident()
    release = threading.Event()
    started = threading.Event()

    def slow(label: str) -> tuple[str, int]:
        """Wait until the test says go, and report the thread this ran on."""
        started.set()
        release.wait(timeout=5)
        return label, threading.get_ident()

    pending = asyncio.ensure_future(run_blocking(slow, "turn"))
    await asyncio.get_running_loop().run_in_executor(None, started.wait, 5)
    other_work_ran = await asyncio.sleep(0, result="the loop is free")
    release.set()
    label, worker_thread = await pending

    assert other_work_ran == "the loop is free"
    assert label == "turn"
    assert worker_thread != loop_thread
    assert closings.count == 1


async def test_many_blocking_jobs_run_at_the_same_time(closings: Closings) -> None:
    """Visitors are served side by side: none waits for another's model call to return."""
    barrier = threading.Barrier(4, timeout=5)

    def meet() -> int:
        """Wait for the three others; this only passes when all four are running at once."""
        return barrier.wait()

    arrivals = await asyncio.gather(*(run_blocking(meet) for _ in range(4)))

    assert sorted(arrivals) == [0, 1, 2, 3]
    assert closings.count == 4
