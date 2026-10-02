"""The runner: LB-03's documents on an event loop of their own, so they wait together and not one after another.

Gunicorn serves requests on a few threads (docs/STACK.md), and a document takes up to a couple of minutes, most of it
spent waiting for OCR, a model or storage. A request thread can't hold a document that long, and `asgiref`, which
runs Flask's async views, gives each request a loop of its own that ends with the request. So the service keeps one
event loop per worker process, on a daemon thread, and a request only hands a document to it (`submit`) and answers
202. The visitor's page then polls for the document's state.

On that loop each document is a task of the pipeline (lb03/pipeline.py). Whatever blocks goes through `offload`: a
thread pool, with a copy of the task's context so the gateway client still knows which run it is calling for. The
loop itself only ever coordinates, which is why two documents in flight do not wait for each other: while one is
blocked in a model call, the other is too, in another thread, and the elapsed time is the longer one and not the sum.
OCR is the exception, on purpose: it is CPU work in a process of its own, and the pool allows few of them at a time.

The runner also keeps the documents it holds alive and the storage clean:

- every half minute it tells the database it is still working on its documents (`touch`), so another worker can tell
  a document that was lost from one that is only slow;
- every minute it runs the sweep (lb03/sweeper.py): documents lost by a dead worker are ended and given back to the
  visitor, and whatever is past its hour is deleted;
- when the worker is told to stop it gives its documents a few seconds to finish, then ends the rest as interrupted
  and gives the visitors their places back, instead of leaving them to be found lost.

At most a few documents are in the pipeline at once, and a few more may wait their turn; beyond that `submit` says the
readers are busy, so a flood of uploads can't pile up work without bound.
"""

import asyncio
import contextvars
import functools
import logging
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy.exc import SQLAlchemyError

from core.errors import describe_failure
from lb03 import limits
from lb03.pipeline import Ended, Job, Offload, Pipeline
from lb03.quota import PostgresLedger
from lb03.repository import DocumentRepository
from lb03.states import SERVICE_FAILURES, FailureCode

logger = logging.getLogger(__name__)

# How many documents may wait for a place in the pipeline, beyond the ones in it: they hold no memory but their ids.
MAX_WAITING = 64
# How long closing waits for the loop to cancel its tasks and for its thread to end.
CLOSE_SECONDS = 10.0


class RunnerClosedError(Exception):
    """The runner is shutting down and takes no more documents."""


class RunnerBusyError(Exception):
    """Too many documents are in the pipeline or waiting for it, so this one is not taken."""


@dataclass(frozen=True)
class RunnerSettings:
    """How the runner is sized and timed. The defaults are the production values; tests shorten the times."""

    max_in_flight: int = limits.MAX_DOCUMENTS_IN_FLIGHT
    max_waiting: int = MAX_WAITING
    heartbeat_seconds: float = limits.HEARTBEAT_SECONDS
    sweep_seconds: float = limits.SWEEP_INTERVAL_SECONDS
    shutdown_grace_seconds: float = limits.SHUTDOWN_GRACE_SECONDS


class PipelineRunner:
    """Runs documents through the pipeline on a loop of its own, and looks after the ones it holds."""

    def __init__(
        self,
        build_pipeline: Callable[[Offload], Pipeline],
        repository: DocumentRepository,
        ledger: PostgresLedger,
        sweep: Callable[[], object],
        clock: Callable[[], datetime],
        settings: RunnerSettings | None = None,
    ) -> None:
        """Run the pipeline `build_pipeline` makes, settling each document's end with `repository` and `ledger`.

        `build_pipeline` is given the runner's `offload` and is called when the first document arrives, in this
        process: whatever it starts (a thread for the spans, say) is started after gunicorn has forked.
        """
        self._build_pipeline = build_pipeline
        self._repository = repository
        self._ledger = ledger
        self._sweep = sweep
        self._clock = clock
        self._settings = settings or RunnerSettings()
        self._lock = threading.Condition()
        self._held: dict[str, Job] = {}
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._pipeline: Pipeline | None = None
        self._slots: asyncio.Semaphore | None = None
        self._executor: ThreadPoolExecutor | None = None
        self._closed = False

    @property
    def in_flight(self) -> int:
        """Return how many documents the runner holds: those in the pipeline and those waiting for a place."""
        with self._lock:
            return len(self._held)

    def start(self) -> None:
        """Start the loop's thread and the pipeline, once; later calls do nothing."""
        with self._lock:
            if self._closed:
                raise RunnerClosedError
            if self._thread is not None:
                return
            threads = self._settings.max_in_flight + 4
            self._executor = ThreadPoolExecutor(max_workers=threads, thread_name_prefix="lb03-io")
            self._pipeline = self._build_pipeline(self.offload)
            loop = asyncio.new_event_loop()
            self._loop = loop
            ready = threading.Event()
            self._thread = threading.Thread(
                target=self._run_loop, args=(loop, ready), name="lb03-pipeline", daemon=True
            )
            self._thread.start()
        ready.wait(CLOSE_SECONDS)

    def submit(self, job: Job) -> None:
        """Hand a document to the pipeline and return at once; it is read in the background.

        Raises `RunnerBusyError` when too many documents are already held, and `RunnerClosedError` when the runner
        is shutting down. In both cases the document was not taken and the caller must settle the visitor's place.
        """
        self.start()
        with self._lock:
            if self._closed:
                raise RunnerClosedError
            if len(self._held) >= self._settings.max_in_flight + self._settings.max_waiting:
                raise RunnerBusyError
            self._held[job.document_id] = job
        loop = self._loop
        if loop is None:
            raise RunnerClosedError
        asyncio.run_coroutine_threadsafe(self._run(job), loop)

    async def offload[Result](self, function: Callable[..., Result], *arguments: Any) -> Result:
        """Run a blocking function in a thread of the pool, in a copy of this task's context, and wait for it.

        The copy is what lets the gateway client, called from the thread, still find the run and the open span of the
        document it is calling for.
        """
        executor = self._executor
        if executor is None:
            raise RunnerClosedError
        context = contextvars.copy_context()
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(executor, functools.partial(context.run, function, *arguments))

    def close(self) -> None:
        """Stop taking documents, give the held ones a few seconds to finish, then end the rest as interrupted."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            deadline = time.monotonic() + self._settings.shutdown_grace_seconds
            while self._held and time.monotonic() < deadline:
                self._lock.wait(timeout=max(deadline - time.monotonic(), 0.0))
        self._stop_loop()
        for job in self._leftover():
            self._interrupt_now(job)
        if self._executor is not None:
            self._executor.shutdown(wait=False, cancel_futures=True)

    def _run_loop(self, loop: asyncio.AbstractEventLoop, ready: threading.Event) -> None:
        """Run the loop on its thread: make the slots, start the heartbeat and the sweep, and run until stopped."""
        asyncio.set_event_loop(loop)
        self._slots = asyncio.Semaphore(self._settings.max_in_flight)
        loop.create_task(self._heartbeat())
        loop.create_task(self._sweeping())
        loop.call_soon(ready.set)
        try:
            loop.run_forever()
        finally:
            loop.close()

    def _stop_loop(self) -> None:
        """Cancel what is still running on the loop, wait for it to unwind (so no OCR worker is left running), stop."""
        loop, thread = self._loop, self._thread
        if loop is None or thread is None:
            return
        try:
            asyncio.run_coroutine_threadsafe(self._cancel_all(), loop).result(timeout=CLOSE_SECONDS)
        except (TimeoutError, RuntimeError) as error:
            logger.warning("The pipeline loop did not stop cleanly: %s", type(error).__name__)
        loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=CLOSE_SECONDS)

    @staticmethod
    async def _cancel_all() -> None:
        """Cancel every task of the loop but this one, and wait for each to finish unwinding."""
        current = asyncio.current_task()
        tasks = [task for task in asyncio.all_tasks() if task is not current]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    def _leftover(self) -> list[Job]:
        """Return the documents still held after the loop stopped: their pipelines were cancelled mid-way."""
        with self._lock:
            leftover = list(self._held.values())
            self._held.clear()
        return leftover

    def _interrupt_now(self, job: Job) -> None:
        """End a document that was cut off by shutdown as interrupted, and give the visitor's place back."""
        try:
            wrote = self._repository.finish_failed(job.document_id, FailureCode.INTERRUPTED, self._clock(), 0, None, [])
            if wrote:
                self._ledger.release(job.session_key, job.admitted_on, refund=True)
        except SQLAlchemyError as error:
            logger.error("Could not end an interrupted document: %s", describe_failure(error))

    async def _run(self, job: Job) -> None:
        """Take one document through the pipeline when a place is free, and settle how it ended."""
        pipeline, slots = self._pipeline, self._slots
        if pipeline is None or slots is None:
            raise RunnerClosedError
        ended: Ended | None = None
        try:
            async with slots:
                ended = await pipeline.process(job)
        except asyncio.CancelledError:
            # The shutdown cancelled this run. The document stays held, so `close` ends it and settles the visitor.
            raise
        except Exception as error:  # noqa: BLE001 - whatever went wrong, the document must be ended and the place settled
            logger.error("A document's run failed: %s", describe_failure(error))
            ended = await self._end_interrupted(job)
        self._forget(job.document_id)
        if ended is not None and ended.wrote:
            await self._give_back_or_keep(job, ended)

    async def _end_interrupted(self, job: Job) -> Ended | None:
        """End a document whose run failed by a bug as interrupted; None when even that could not be written."""
        try:
            wrote = await self.offload(
                self._repository.finish_failed, job.document_id, FailureCode.INTERRUPTED, self._clock(), 0, None, []
            )
        except SQLAlchemyError as error:
            logger.error("Could not end a document after its run failed: %s", describe_failure(error))
            return None
        return Ended(FailureCode.INTERRUPTED, wrote, 0, "")

    async def _give_back_or_keep(self, job: Job, ended: Ended) -> None:
        """Free the visitor's worker slot, and give the place back when the service is the one that failed."""
        refund = ended.failure in SERVICE_FAILURES
        try:
            await self.offload(self._ledger.release, job.session_key, job.admitted_on, refund)
        except SQLAlchemyError as error:
            logger.error("Could not settle a document's place: %s", describe_failure(error))

    def _forget(self, document_id: str) -> None:
        """Stop holding a document, and wake `close` if it was waiting for the last one."""
        with self._lock:
            self._held.pop(document_id, None)
            self._lock.notify_all()

    async def _heartbeat(self) -> None:
        """Say, every so often, that this worker is still reading the documents it holds."""
        while True:
            await asyncio.sleep(self._settings.heartbeat_seconds)
            with self._lock:
                ids = list(self._held)
            if not ids:
                continue
            try:
                await self.offload(self._repository.touch, ids, self._clock())
            except SQLAlchemyError as error:
                logger.warning("Could not note that documents are still being read: %s", describe_failure(error))

    async def _sweeping(self) -> None:
        """Run the sweep when the worker starts and then every so often; it never stops, whatever a pass does."""
        while True:
            try:
                await self.offload(self._sweep)
            except Exception as error:  # noqa: BLE001 - a failed pass is logged and the next one tries again
                logger.error("A sweep pass failed: %s", describe_failure(error))
            await asyncio.sleep(self._settings.sweep_seconds)
