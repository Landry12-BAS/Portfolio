"""A span writer that never waits: spans go on a bounded queue and a thread of its own writes them out.

LB-03's pipeline runs on one event loop thread that every document in flight shares. The tracer writes each span as
the step ends, and writing to Redis is a network call: done on that thread, one slow Redis would stall every
document, the ones that are only waiting for a model included. So the pipeline's tracer writes here instead. `write`
puts the spans on a queue and returns at once, and a daemon thread takes them off in batches and hands them to the
real writer.

Telemetry never fails a run, and never holds one up. When the queue is full (Redis has been away for a long time) a
span is dropped and counted rather than waited for, and a real writer that raises is logged by type alone and the
thread carries on.
"""

import logging
import queue
import threading
from collections.abc import Sequence

from lb_common.tracing import Span, SpanWriter

logger = logging.getLogger(__name__)

# How many spans may wait to be written, and how many go to the writer in one batch.
QUEUE_CAPACITY = 2_000
BATCH_SIZE = 50
# How many dropped spans pass between two log lines about it.
DROP_LOG_EVERY = 100


class QueuedSpanWriter:
    """Hands spans to `writer` from a thread of its own, so recording a span never waits on the network."""

    def __init__(self, writer: SpanWriter, capacity: int = QUEUE_CAPACITY, batch_size: int = BATCH_SIZE) -> None:
        """Write to `writer` in batches of at most `batch_size`, holding at most `capacity` spans meanwhile."""
        self._writer = writer
        self._batch_size = batch_size
        self._queue: queue.Queue[Span | None] = queue.Queue(maxsize=capacity)
        self._unwritten = 0
        self._idle = threading.Condition()
        self.dropped = 0
        self._thread = threading.Thread(target=self._drain, name="lb03-spans", daemon=True)
        self._thread.start()

    def write(self, spans: Sequence[Span]) -> None:
        """Queue the spans and return at once; a span that finds the queue full is dropped. Never raises."""
        for span in spans:
            with self._idle:
                self._unwritten += 1
            try:
                self._queue.put_nowait(span)
            except queue.Full:
                self._finished(1)
                self._note_drop()

    def flush(self, timeout: float = 5.0) -> bool:
        """Wait until every queued span has been handed to the writer; return whether that happened in time."""
        with self._idle:
            return self._idle.wait_for(lambda: self._unwritten == 0, timeout=timeout)

    def close(self, timeout: float = 5.0) -> None:
        """Write what is queued, then stop the thread."""
        self.flush(timeout)
        self._queue.put(None)
        self._thread.join(timeout)

    def _note_drop(self) -> None:
        """Count a dropped span, and say so now and then."""
        self.dropped += 1
        if self.dropped % DROP_LOG_EVERY == 1:
            logger.warning("Dropped %d spans so far: the span queue is full.", self.dropped)

    def _finished(self, count: int) -> None:
        """Note that `count` spans are done with, written or dropped, and wake whoever is flushing."""
        with self._idle:
            self._unwritten -= count
            self._idle.notify_all()

    def _drain(self) -> None:
        """Take spans off the queue in batches and write them, until told to stop."""
        while True:
            first = self._queue.get()
            if first is None:
                return
            batch = [first]
            stop = False
            while len(batch) < self._batch_size:
                try:
                    following = self._queue.get_nowait()
                except queue.Empty:
                    break
                if following is None:
                    stop = True
                    break
                batch.append(following)
            self._write_batch(batch)
            if stop:
                return

    def _write_batch(self, batch: list[Span]) -> None:
        """Hand a batch to the real writer; a failure is logged by its type and never stops the thread."""
        try:
            self._writer.write(batch)
        except Exception as error:  # noqa: BLE001 - telemetry must never take the writer thread down
            logger.warning("A span batch could not be written: %s", type(error).__name__)
        finally:
            self._finished(len(batch))
