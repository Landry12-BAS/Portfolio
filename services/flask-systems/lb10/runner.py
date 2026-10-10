"""The runner: eval runs on an event loop of their own, so a request answers 202 and the page polls.

Gunicorn serves requests on a few threads, and a run takes up to a few minutes, all of it spent waiting on
the gateway. A request thread can't hold that, and Flask's async views give each request a loop that ends
with it (docs/STACK.md). So the service keeps one event loop per worker process, on a daemon thread, and a
request only hands a run to it (`submit`) and answers 202. Whatever blocks goes through `offload`: a thread
pool, with a copy of the task's context so the gateway client still knows which run and span it is calling
for. This is LB-03's runner (lb03/runner.py) cut down to what an eval run needs: no heartbeat (a run that
outlives its deadline is ended by the API when it is read), no sweep of its own.

When a run ends, the runner settles it: the report is written, or the run is marked failed with its code,
and the visitor's place is given back when the service is the one that failed. A worker told to stop ends
the runs it holds as interrupted, so none is left "running" for good.
"""

import asyncio
import atexit
import contextvars
import functools
import logging
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any

from sqlalchemy.exc import SQLAlchemyError

from core import shutdown
from core.errors import describe_failure
from lb10.limits import CONCURRENCY, RUN_DEADLINE_SECONDS
from lb10.pipeline import FAILURE_INTERRUPTED, FAILURE_TIME_LIMIT, EvalPipeline, Offload, RunFailedError, RunRequest
from lb10.quota import Admission, Ledger
from lb10.repository import EvalRepository

logger = logging.getLogger(__name__)

# How many runs may be in flight in one worker at once, beyond which `submit` says the lab is busy.
MAX_IN_FLIGHT = 8
# How long closing waits for the loop to cancel its tasks and for its thread to end, and the grace the held
# runs get to finish first.
CLOSE_SECONDS = 10.0
SHUTDOWN_GRACE_SECONDS = 15.0
# The failures that give the visitor their run back: the service, not the prompt, is what failed.
REFUNDED_FAILURES = frozenset({"model_budget", "no_answers", FAILURE_TIME_LIMIT, FAILURE_INTERRUPTED, "call_limit"})


class RunnerClosedError(Exception):
    """The runner is shutting down and takes no more runs."""


class RunnerBusyError(Exception):
    """Too many runs are in flight in this worker, so this one is not taken."""


@dataclass(frozen=True)
class Job:
    """One run handed to the runner: what to run, and the visitor's admission to settle when it ends."""

    request: RunRequest
    admission: Admission | None


class EvalRunner:
    """Runs evals through the pipeline on a loop of its own, and settles each one as it ends."""

    def __init__(
        self,
        build_pipeline: Callable[[Offload, ThreadPoolExecutor], EvalPipeline],
        repository: EvalRepository,
        ledger: Ledger,
        deadline_seconds: float = RUN_DEADLINE_SECONDS,
        max_in_flight: int = MAX_IN_FLIGHT,
    ) -> None:
        """Run the pipeline `build_pipeline` makes (from the runner's `offload` and pool) once the first run arrives."""
        self._build_pipeline = build_pipeline
        self._repository = repository
        self._ledger = ledger
        self._deadline_seconds = deadline_seconds
        self._max_in_flight = max_in_flight
        self._lock = threading.Condition()
        self._held: dict[str, Job] = {}
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._pipeline: EvalPipeline | None = None
        self._executor: ThreadPoolExecutor | None = None
        self._closed = False

    @property
    def in_flight(self) -> int:
        """Return how many runs the runner holds."""
        with self._lock:
            return len(self._held)

    def start(self) -> None:
        """Start the loop's thread and the pipeline, once; later calls do nothing."""
        with self._lock:
            if self._closed:
                raise RunnerClosedError
            if self._thread is not None:
                return
            self._executor = ThreadPoolExecutor(max_workers=CONCURRENCY + 4, thread_name_prefix="lb10-io")
            self._pipeline = self._build_pipeline(self.offload, self._executor)
            loop = asyncio.new_event_loop()
            self._loop = loop
            ready = threading.Event()
            self._thread = threading.Thread(target=self._run_loop, args=(loop, ready), name="lb10-evals", daemon=True)
            self._thread.start()
            shutdown.register(self.close)
            atexit.register(self.close, 0.0)
        ready.wait(CLOSE_SECONDS)

    def submit(self, job: Job) -> None:
        """Hand a run to the loop and return at once; when the runner is busy or closing it raises and takes nothing."""
        self.start()
        with self._lock:
            if self._closed:
                raise RunnerClosedError
            if len(self._held) >= self._max_in_flight:
                raise RunnerBusyError
            self._held[job.request.run_id] = job
        loop = self._loop
        if loop is None:
            raise RunnerClosedError
        asyncio.run_coroutine_threadsafe(self._run(job), loop)

    async def offload(self, function: Callable[..., Any], *arguments: Any) -> Any:
        """Run a blocking function on a thread of the pool, in a copy of this task's context, and wait for it."""
        executor = self._executor
        if executor is None:
            raise RunnerClosedError
        context = contextvars.copy_context()
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(executor, functools.partial(context.run, function, *arguments))

    def close(self, grace_seconds: float | None = None) -> None:
        """Stop taking runs, give the held ones a few seconds to finish, then end the rest as interrupted."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            grace = SHUTDOWN_GRACE_SECONDS if grace_seconds is None else grace_seconds
            deadline = time.monotonic() + grace
            while self._held and time.monotonic() < deadline:
                self._lock.wait(timeout=max(deadline - time.monotonic(), 0.0))
        self._stop_loop()
        for job in self._leftover():
            self._settle(job, FAILURE_INTERRUPTED)
        if self._executor is not None:
            self._executor.shutdown(wait=False, cancel_futures=True)

    def _run_loop(self, loop: asyncio.AbstractEventLoop, ready: threading.Event) -> None:
        """Run the loop on its thread until stopped."""
        asyncio.set_event_loop(loop)
        loop.call_soon(ready.set)
        try:
            loop.run_forever()
        finally:
            loop.close()

    def _stop_loop(self) -> None:
        """Cancel what is still running on the loop, wait for it to unwind, then stop the loop and its thread."""
        loop, thread = self._loop, self._thread
        if loop is None or thread is None:
            return
        try:
            asyncio.run_coroutine_threadsafe(self._cancel_all(), loop).result(timeout=CLOSE_SECONDS)
        except (TimeoutError, RuntimeError) as error:
            logger.warning("The eval loop did not stop cleanly: %s", type(error).__name__)
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
        """Return the runs still held after the loop stopped: their pipelines were cancelled mid-way."""
        with self._lock:
            leftover = list(self._held.values())
            self._held.clear()
        return leftover

    async def _run(self, job: Job) -> None:
        """Take one run through the pipeline within its deadline, and settle how it ended."""
        pipeline = self._pipeline
        if pipeline is None:
            raise RunnerClosedError
        run_id = job.request.run_id

        def progress(done: int, cached: int) -> None:
            """Record how far the run has got; a note that can't be written is not worth stopping for."""
            try:
                self._repository.note_progress(run_id, done, cached)
            except SQLAlchemyError as error:
                logger.warning("Could not note a run's progress: %s", describe_failure(error))

        try:
            report = await asyncio.wait_for(pipeline.run(job.request, progress), timeout=self._deadline_seconds)
        except asyncio.CancelledError:
            # The shutdown cancelled this run. It stays held, so `close` ends it and settles the visitor.
            raise
        except TimeoutError:
            self._forget(run_id)
            self._settle(job, FAILURE_TIME_LIMIT)
            return
        except RunFailedError as error:
            self._forget(run_id)
            self._settle(job, error.failure)
            return
        except Exception as error:  # noqa: BLE001 - whatever went wrong, the run must be ended and the place settled
            logger.error("An eval run failed: %s", describe_failure(error))
            self._forget(run_id)
            self._settle(job, FAILURE_INTERRUPTED)
            return
        self._forget(run_id)
        try:
            self._repository.finish_run(
                run_id, report.model_dump(mode="json"), report.total_model_calls, report.total_cached_calls
            )
        except SQLAlchemyError as error:
            logger.error("Could not write a run's report: %s", describe_failure(error))
        self._release(job, refund=False)

    def _settle(self, job: Job, failure: str) -> None:
        """End a run as failed and give the visitor's place back when the service is what failed."""
        try:
            self._repository.fail_run(job.request.run_id, failure)
        except SQLAlchemyError as error:
            logger.error("Could not end a failed run: %s", describe_failure(error))
        self._release(job, refund=failure in REFUNDED_FAILURES)

    def _release(self, job: Job, refund: bool) -> None:
        """Free the visitor's place in the ledger, giving the run back when asked."""
        if job.admission is None:
            return
        try:
            self._ledger.finish(job.admission, refund)
        except SQLAlchemyError as error:
            logger.error("Could not settle a run's place: %s", describe_failure(error))

    def _forget(self, run_id: str) -> None:
        """Stop holding a run, and wake `close` if it was waiting for the last one."""
        with self._lock:
            self._held.pop(run_id, None)
            self._lock.notify_all()
