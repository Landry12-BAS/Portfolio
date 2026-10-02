"""The worker's last duties: each system's callbacks run once, last registered first, and one failing stops no other."""

import pytest

from core import shutdown


@pytest.fixture(autouse=True)
def clean_registry() -> None:
    """Start and end every test with no callbacks registered, so tests never run each other's."""
    shutdown._callbacks.clear()


def test_callbacks_run_last_registered_first() -> None:
    """The system that started last winds down first, as a stack of resources does."""
    order: list[str] = []
    shutdown.register(lambda: order.append("first"))
    shutdown.register(lambda: order.append("second"))

    shutdown.run_all()

    assert order == ["second", "first"]


def test_callbacks_run_once() -> None:
    """A second call finds nothing left to do."""
    calls: list[int] = []
    shutdown.register(lambda: calls.append(1))

    shutdown.run_all()
    shutdown.run_all()

    assert calls == [1]


def test_a_callback_that_fails_is_logged_by_type_and_the_others_still_run(caplog: pytest.LogCaptureFixture) -> None:
    """One system failing to wind down never leaves another's documents or counters unsettled."""
    ran: list[str] = []

    def broken() -> None:
        """Fail, with a message that must never reach a log."""
        raise RuntimeError("a visitor's secret words")

    shutdown.register(lambda: ran.append("early"))
    shutdown.register(broken)
    shutdown.register(lambda: ran.append("late"))

    with caplog.at_level("ERROR", logger="core.shutdown"):
        shutdown.run_all()

    assert ran == ["late", "early"]
    assert "RuntimeError" in caplog.text
    assert "visitor's secret words" not in caplog.text
