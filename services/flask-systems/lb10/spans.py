"""A span writer for the pipeline's event loop: each write goes to a thread, so no Redis call stalls the loop.

The lab's model calls wait together on one event loop (lb10/pipeline.py). The tracer writes a span as each
step ends, and writing to Redis is a network call: made on the loop's thread, one slow Redis would hold every
call in flight. So the pipeline's tracer writes through this, which hands each batch to the thread pool the
pipeline already has and returns at once. Telemetry never fails a run: a writer that raises is logged by type.
"""

import logging
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor

from core.errors import describe_failure
from lb_common.tracing import Span, SpanWriter

logger = logging.getLogger(__name__)


class ThreadedSpanWriter:
    """Hands spans to `writer` on a thread of the pool, so recording a span never waits on the network."""

    def __init__(self, writer: SpanWriter, executor: ThreadPoolExecutor) -> None:
        """Write through `writer` on `executor`'s threads."""
        self._writer = writer
        self._executor = executor

    def write(self, spans: Sequence[Span]) -> None:
        """Queue the spans for writing and return at once. Never raises."""
        kept = list(spans)
        try:
            self._executor.submit(self._write_now, kept)
        except RuntimeError:
            # The pool is shutting down with the worker; the spans of a run that is ending anyway are let go.
            logger.warning("Dropped %d spans: the span writer's pool is closed.", len(kept))

    def _write_now(self, spans: list[Span]) -> None:
        """Write a batch, logging a failure by type alone."""
        try:
            self._writer.write(spans)
        except Exception as error:  # noqa: BLE001 - telemetry never fails a run; the failure is logged by type
            logger.error("Could not write %d spans: %s", len(spans), describe_failure(error))
