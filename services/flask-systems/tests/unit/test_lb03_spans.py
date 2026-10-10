"""The queued span writer: recording a span never waits on the network, and a failing writer never stops it."""

import threading
import time
from collections.abc import Sequence

import pytest

from lb03.spans import QueuedSpanWriter
from lb_common.tracing import Span


def make_span(index: int) -> Span:
    """Make one finished span, numbered so a test can tell the order they arrived in."""
    return Span(
        run_id="run-0000000000000001",
        system="lb-03",
        span_id=f"{index:016x}",
        kind="system.step",
        name=f"step {index}",
        status="ok",
        start_ms=index,
        end_ms=index + 1,
    )


class Collector:
    """A span writer that keeps what it is given, and can be made slow or broken."""

    def __init__(self, delay: float = 0.0, fail_first: int = 0) -> None:
        """Wait `delay` seconds on each write, and raise on the first `fail_first` writes."""
        self.batches: list[list[Span]] = []
        self._delay = delay
        self._fail_first = fail_first
        self.release = threading.Event()
        self.release.set()

    def write(self, spans: Sequence[Span]) -> None:
        """Keep the batch, after waiting for the gate to open and for the delay."""
        self.release.wait(5)
        time.sleep(self._delay)
        if self._fail_first > 0:
            self._fail_first -= 1
            raise RuntimeError("redis is away")
        self.batches.append(list(spans))

    def names(self) -> list[str]:
        """Return every span name received, in order."""
        return [span.name for batch in self.batches for span in batch]


def test_spans_reach_the_writer_in_the_order_they_were_recorded() -> None:
    """The queue is first in, first out, so a trace reads in the order its steps ended."""
    collector = Collector()
    writer = QueuedSpanWriter(collector)

    writer.write([make_span(1), make_span(2)])
    writer.write([make_span(3)])

    assert writer.flush()
    assert collector.names() == ["step 1", "step 2", "step 3"]
    writer.close()


def test_recording_a_span_does_not_wait_for_a_slow_writer() -> None:
    """With the real writer stuck, `write` still returns at once, so the pipeline's loop is never held up."""
    collector = Collector()
    collector.release.clear()
    writer = QueuedSpanWriter(collector)

    started = time.perf_counter()
    for index in range(20):
        writer.write([make_span(index)])
    elapsed = time.perf_counter() - started

    assert elapsed < 0.5
    collector.release.set()
    assert writer.flush()
    assert len(collector.names()) == 20
    writer.close()


def test_a_full_queue_drops_spans_instead_of_waiting_and_counts_them() -> None:
    """When Redis has been away so long that the queue fills, a span is dropped rather than waited for."""
    collector = Collector()
    collector.release.clear()
    writer = QueuedSpanWriter(collector, capacity=5, batch_size=1)

    for index in range(30):
        writer.write([make_span(index)])

    assert writer.dropped > 0
    collector.release.set()
    assert writer.flush()
    assert len(collector.names()) + writer.dropped == 30
    writer.close()


def test_a_writer_that_raises_is_logged_by_type_and_the_thread_carries_on(caplog: pytest.LogCaptureFixture) -> None:
    """A failed batch is lost, the next one is written, and the log names the error's type and nothing else."""
    collector = Collector(fail_first=1)
    writer = QueuedSpanWriter(collector, batch_size=1)

    with caplog.at_level("WARNING", logger="lb03.spans"):
        writer.write([make_span(1)])
        assert writer.flush()
        writer.write([make_span(2)])
        assert writer.flush()

    assert collector.names() == ["step 2"]
    assert "RuntimeError" in caplog.text
    assert "redis is away" not in caplog.text
    writer.close()


def test_closing_writes_what_is_queued_and_stops_the_thread() -> None:
    """A clean shutdown loses no span that was already recorded."""
    collector = Collector(delay=0.01)
    writer = QueuedSpanWriter(collector)
    writer.write([make_span(index) for index in range(10)])

    writer.close()

    assert len(collector.names()) == 10
    assert not writer._thread.is_alive()


def test_flush_gives_up_after_its_timeout_when_the_writer_is_stuck() -> None:
    """A stuck writer makes `flush` say so instead of hanging a shutdown."""
    collector = Collector()
    collector.release.clear()
    writer = QueuedSpanWriter(collector)
    writer.write([make_span(1)])

    assert writer.flush(timeout=0.1) is False

    collector.release.set()
    writer.close()
