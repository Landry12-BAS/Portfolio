"""Tests for LB-03's runner (lb03/runner.py) and the sweep (lb03/sweeper.py) on a real Postgres.

The runner's claim is that documents wait together: two documents in flight are two model calls in flight at the same
moment, not one after the other. The proof is a barrier that both model calls must reach before either may return,
which a runner that serialised its documents could never satisfy. The rest is bookkeeping that must be exact: a
document that ends gives its worker slot back, a document the service failed gives its place back, a document cut
off by a shutdown or lost with its worker is ended and settled, and a bug in a run never leaves a visitor held.
"""

import json
import secrets
import threading
import time
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import Engine, select

from core.structured import ChatMessage, Completion
from lb03 import limits
from lb03.accounts import read_chart
from lb03.boxes import PageWords
from lb03.duplicates import find_duplicate, identity_of, sample_identities
from lb03.golden import SEED_DIRECTORY, printed_as_reply, read_golden_set
from lb03.invoice import ExtractedInvoice
from lb03.models import QuotaUsage
from lb03.pipeline import Job, Offload, Parts, Pipeline
from lb03.quota import PostgresLedger
from lb03.repository import DocumentRepository, NewDocument, StoredDocument
from lb03.runner import PipelineRunner, RunnerBusyError, RunnerClosedError, RunnerSettings
from lb03.spans import QueuedSpanWriter
from lb03.states import FailureCode
from lb03.storage import LocalFileStore, original_key
from lb03.sweeper import sweep
from lb_common.run import Run, current_run
from lb_common.tracing import Tracer
from tests.lb03_support import FakeGuard, FakeReader, invoice_page
from tests.support import MemorySpanWriter, unavailable

pytestmark = pytest.mark.integration

SAM = "session-of-sam-visitor-0001"
ALEX = "session-of-alex-visitor-0002"
GOLDEN = read_golden_set()
LEFT_PAGE = 0.5


def clock() -> datetime:
    """Return the real time, aware, in UTC: the runner's heartbeat and the sweep are about real elapsed time."""
    return datetime.now(UTC)


def plain_invoice() -> ExtractedInvoice:
    """Return the invoice of a golden document that reads cleanly and duplicates no sample."""
    samples = sample_identities(GOLDEN)
    for case in GOLDEN.cases:
        if case.expect.outcome != "valid" or case.printed is None or case.expect.duplicate_of is not None:
            continue
        invoice = ExtractedInvoice.from_reply(printed_as_reply(case.printed))
        identity = identity_of(invoice)
        if identity is not None and find_duplicate(identity, samples) is None:
            return invoice
    raise AssertionError("The golden set has no plain document.")


INVOICE = plain_invoice()
REPLY = json.dumps(json.loads(INVOICE.model_dump_json()))


class GatedChat:
    """A fake model whose calls block in a thread, as a network call does, until a gate opens or a barrier fills.

    `barrier` makes every call wait for the others: with a barrier of two, a call returns only once a second call is
    in flight too. `delay` is a plain wait. `seen_in_flight` is the most calls that were ever in progress together.
    """

    def __init__(
        self, barrier: int = 0, delay: float = 0.0, failure: Exception | None = None, barrier_seconds: float = 5.0
    ) -> None:
        """Wait for `barrier` calls to be in flight together (when set), then `delay` seconds, then answer."""
        self._barrier = threading.Barrier(barrier, timeout=barrier_seconds) if barrier else None
        self._delay = delay
        self._failure = failure
        self._lock = threading.Lock()
        self._in_flight = 0
        self.seen_in_flight = 0
        self.gate = threading.Event()
        self.gate.set()
        self.runs: list[Run | None] = []
        self.calls = 0

    def complete(
        self, alias: str, messages: Sequence[ChatMessage], max_tokens: int, timeout_seconds: float | None = None
    ) -> Completion:
        """Block like a network call, then return the reply for a clean document (or raise the failure given)."""
        del alias, messages, max_tokens, timeout_seconds
        with self._lock:
            self.calls += 1
            self._in_flight += 1
            self.seen_in_flight = max(self.seen_in_flight, self._in_flight)
            self.runs.append(current_run())
        try:
            if self._barrier is not None:
                self._barrier.wait()
            self.gate.wait(10)
            time.sleep(self._delay)
            if self._failure is not None:
                raise self._failure
            return Completion(REPLY, "test/lb-fast")
        finally:
            with self._lock:
                self._in_flight -= 1


@dataclass
class Harness:
    """A runner on a real database, with fakes for the models, the guard and the reader, and ways to look at both."""

    runner: PipelineRunner
    repository: DocumentRepository
    ledger: PostgresLedger
    store: LocalFileStore
    chat: GatedChat
    spans: MemorySpanWriter
    queue: QueuedSpanWriter
    sweeps: list[float]
    engine: Engine


@pytest.fixture
def make_harness(lb03_engine: Engine, tmp_path: Path) -> Iterator[Callable[..., Harness]]:
    """Return a maker of harnesses, and close every runner it made when the test ends."""
    made: list[Harness] = []

    def make(
        chat: GatedChat | None = None,
        reader: FakeReader | None = None,
        settings: RunnerSettings | None = None,
        sweep_function: Callable[[], object] | None = None,
    ) -> Harness:
        """Build the runner: its pipeline is made by the runner itself on the first document, as in production."""
        the_chat = chat or GatedChat()
        the_reader = reader or FakeReader([invoice_page(INVOICE)])
        repository = DocumentRepository(lb03_engine)
        ledger = PostgresLedger(lb03_engine, clock)
        store = LocalFileStore(tmp_path / "files")
        spans = MemorySpanWriter()
        queue = QueuedSpanWriter(spans)
        sweeps: list[float] = []

        def build(offload: Offload) -> Pipeline:
            """Make the pipeline for the runner, with its own tracer on the queued span writer."""
            return Pipeline(
                Parts(
                    chat=the_chat,
                    guard=FakeGuard(),
                    reader=the_reader,
                    store=store,
                    repository=repository,
                    tracer=Tracer(queue),
                    chart=read_chart(SEED_DIRECTORY),
                    samples=sample_identities(GOLDEN),
                    offload=offload,
                    clock=clock,
                    cleanup=queue.close,
                )
            )

        def count_sweep() -> None:
            """Note that a sweep ran, and run the one the test gave."""
            sweeps.append(time.monotonic())
            if sweep_function is not None:
                sweep_function()

        runner = PipelineRunner(
            build, repository, ledger, count_sweep, clock, settings or RunnerSettings(sweep_seconds=3600.0)
        )
        harness = Harness(runner, repository, ledger, store, the_chat, spans, queue, sweeps, lb03_engine)
        made.append(harness)
        return harness

    yield make
    for harness in made:
        harness.runner.close()
        harness.queue.close()


def upload(harness: Harness, session: str = SAM) -> Job:
    """Do what the upload route does before the pipeline: admit, store the file, make the row, build the job."""
    admission = harness.ledger.admit(session)
    assert admission.allowed, admission.reason
    document_id = secrets.token_urlsafe(16)
    harness.store.put(original_key(document_id, "pdf"), b"%PDF-1.7 a file", "application/pdf")
    harness.repository.create(
        NewDocument(document_id, session, "invoice.pdf", "pdf", 15, "ab" * 32, admission.day), clock()
    )
    return Job(document_id, session, "pdf", "pdf", admission.day, time.monotonic())


def wait_for(condition: Callable[[], bool], timeout: float = 10.0) -> bool:
    """Poll until a condition holds or the time is up; return whether it held."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.02)
    return condition()


def document_of(harness: Harness, job: Job) -> StoredDocument:
    """Read a document back from the database, whoever's it is."""
    found = harness.repository.get_for_pipeline(job.document_id)
    assert found is not None
    return found


def wait_final(harness: Harness, job: Job, timeout: float = 10.0) -> StoredDocument:
    """Wait for a document to end, and return it; fail the test if it does not."""
    assert wait_for(lambda: document_of(harness, job).is_final, timeout), "the document did not end in time"
    return document_of(harness, job)


def counters(harness: Harness, session: str = SAM) -> tuple[int, int, int]:
    """Read a visitor's (used, active, refunds) of today straight from the ledger's table."""
    today = clock().date()
    with harness.engine.connect() as connection:
        row = connection.execute(
            select(QuotaUsage.used, QuotaUsage.active, QuotaUsage.refunds).where(
                QuotaUsage.session_key == session, QuotaUsage.day == today
            )
        ).one()
    return (row.used, row.active, row.refunds)


def test_a_submitted_document_is_read_in_the_background_and_its_worker_slot_is_freed(
    make_harness: Callable[..., Harness],
) -> None:
    """The request only hands the document over; it ends ready on its own, and the visitor can upload again."""
    harness = make_harness()
    job = upload(harness)
    assert counters(harness) == (1, 1, 0)

    harness.runner.submit(job)
    document = wait_final(harness, job)

    assert (document.state, document.failure_code) == ("ready", None)
    assert wait_for(lambda: counters(harness) == (1, 0, 0))
    assert wait_for(lambda: harness.runner.in_flight == 0)


def test_two_documents_in_flight_do_not_serialise(make_harness: Callable[..., Harness]) -> None:
    """Each model call waits until a second one is in flight too: a runner that read documents one by one would hang."""
    chat = GatedChat(barrier=2)
    harness = make_harness(chat=chat)
    first, second = upload(harness, SAM), upload(harness, ALEX)

    harness.runner.submit(first)
    harness.runner.submit(second)

    assert wait_final(harness, first).state == "ready"
    assert wait_final(harness, second).state == "ready"
    assert chat.seen_in_flight == 2


def test_the_barrier_proof_can_fail_a_runner_that_reads_one_document_at_a_time_cannot_pass_it(
    make_harness: Callable[..., Harness],
) -> None:
    """The control: with room for one document at a time the barrier is never filled, so no document ends ready."""
    chat = GatedChat(barrier=2, barrier_seconds=0.5)
    harness = make_harness(chat=chat, settings=RunnerSettings(max_in_flight=1, sweep_seconds=3600.0))
    first, second = upload(harness, SAM), upload(harness, ALEX)

    harness.runner.submit(first)
    harness.runner.submit(second)

    assert wait_final(harness, first).state == "failed"
    assert wait_final(harness, second).state == "failed"
    assert chat.seen_in_flight == 1


def test_the_waits_overlap_in_time_and_the_total_is_the_longest_not_the_sum(
    make_harness: Callable[..., Harness],
) -> None:
    """Four documents that each wait half a second for a model take about half a second together, not two."""
    harness = make_harness(chat=GatedChat(delay=0.5), reader=FakeReader([invoice_page(INVOICE)], delay=0.2))
    sessions = [f"session-of-visitor-{index:04d}-xxxxxxxx" for index in range(4)]
    jobs = [upload(harness, session) for session in sessions]
    started = time.monotonic()

    for job in jobs:
        harness.runner.submit(job)
    for job in jobs:
        assert wait_final(harness, job).state == "ready"
    elapsed = time.monotonic() - started

    assert elapsed < 1.4, f"four 0.7 second documents took {elapsed:.2f} seconds: they were read one after another"


def test_no_more_documents_are_in_the_pipeline_than_the_limit_and_the_rest_wait_their_turn(
    make_harness: Callable[..., Harness],
) -> None:
    """With room for two in the pipeline, five documents are all read, but never more than two model calls at once."""
    chat = GatedChat(delay=0.2)
    harness = make_harness(chat=chat, settings=RunnerSettings(max_in_flight=2, sweep_seconds=3600.0))
    jobs = [upload(harness, f"session-of-visitor-{index:04d}-xxxxxxxx") for index in range(5)]

    for job in jobs:
        harness.runner.submit(job)

    for job in jobs:
        assert wait_final(harness, job).state == "ready"
    assert chat.seen_in_flight == 2


def test_documents_beyond_the_waiting_room_are_refused_so_a_flood_cannot_pile_up(
    make_harness: Callable[..., Harness],
) -> None:
    """One in the pipeline, one waiting: the third is told the readers are busy, and nothing of it was taken."""
    chat = GatedChat()
    chat.gate.clear()
    harness = make_harness(chat=chat, settings=RunnerSettings(max_in_flight=1, max_waiting=1, sweep_seconds=3600.0))
    jobs = [upload(harness, f"session-of-visitor-{index:04d}-xxxxxxxx") for index in range(3)]

    harness.runner.submit(jobs[0])
    harness.runner.submit(jobs[1])
    with pytest.raises(RunnerBusyError):
        harness.runner.submit(jobs[2])

    assert harness.runner.in_flight == 2
    chat.gate.set()
    assert wait_final(harness, jobs[0]).state == "ready"
    assert wait_final(harness, jobs[1]).state == "ready"
    assert not document_of(harness, jobs[2]).is_final


def test_every_model_call_runs_in_a_thread_that_knows_the_documents_run(make_harness: Callable[..., Harness]) -> None:
    """The context is copied into the thread, so the gateway client labels the call with the document's own run."""
    chat = GatedChat()
    harness = make_harness(chat=chat)
    job = upload(harness)

    harness.runner.submit(job)
    document = wait_final(harness, job)

    runs = [run for run in chat.runs if run is not None]
    assert len(runs) == chat.calls == 1
    assert (runs[0].system, runs[0].session, runs[0].run_id) == ("lb-03", SAM, document.run_id)


def test_the_spans_of_a_run_reach_the_writer_without_the_loop_waiting_for_them(
    make_harness: Callable[..., Harness],
) -> None:
    """The root span is written once the run is over, through the queue."""
    harness = make_harness()
    job = upload(harness)

    harness.runner.submit(job)
    document = wait_final(harness, job)

    assert harness.queue.flush()
    assert {span.run_id for span in harness.spans.spans} == {document.run_id}
    assert harness.spans.named("invoice reading").attrs["outcome"] == "ready"


def test_a_document_the_service_failed_gives_the_visitors_place_back(make_harness: Callable[..., Harness]) -> None:
    """The models are down: the document fails as `model_failed`, and it does not cost one of the visitor's ten."""
    harness = make_harness(chat=GatedChat(failure=unavailable()))
    job = upload(harness)

    harness.runner.submit(job)
    document = wait_final(harness, job)

    assert document.failure_code == FailureCode.MODEL_FAILED.value
    assert wait_for(lambda: counters(harness) == (0, 0, 1))


def test_a_document_that_is_the_visitors_own_fault_keeps_its_place(make_harness: Callable[..., Harness]) -> None:
    """A file with no text fails by its own content, which is counted: the place is not given back."""
    harness = make_harness(reader=FakeReader([PageWords(1, [])]))
    job = upload(harness)

    harness.runner.submit(job)
    document = wait_final(harness, job)

    assert document.failure_code == FailureCode.NO_TEXT.value
    assert wait_for(lambda: counters(harness) == (1, 0, 0))


def test_a_bug_in_a_run_ends_the_document_as_interrupted_and_gives_the_place_back(
    make_harness: Callable[..., Harness],
) -> None:
    """Whatever raises inside a run, the document is ended and the visitor is not left held on it."""
    harness = make_harness(chat=GatedChat(failure=RuntimeError("a bug nobody expected")))
    job = upload(harness)

    harness.runner.submit(job)
    document = wait_final(harness, job)

    assert document.failure_code == FailureCode.INTERRUPTED.value
    assert wait_for(lambda: counters(harness) == (0, 0, 1))
    assert wait_for(lambda: harness.runner.in_flight == 0)


def test_the_heartbeat_keeps_a_slow_document_from_looking_lost(make_harness: Callable[..., Harness]) -> None:
    """While a worker holds a document it says so, so another worker's sweep leaves it alone."""
    harness = make_harness(
        reader=FakeReader([invoice_page(INVOICE)], delay=1.0),
        settings=RunnerSettings(heartbeat_seconds=0.1, sweep_seconds=3600.0),
    )
    job = upload(harness)
    created = document_of(harness, job).created_at

    harness.runner.submit(job)

    assert wait_for(lambda: document_of(harness, job).updated_at > created + timedelta(seconds=0.4), timeout=5.0)
    assert not document_of(harness, job).is_final or document_of(harness, job).state == "ready"
    wait_final(harness, job)


def test_the_sweep_runs_when_the_worker_starts_and_then_again_and_again(make_harness: Callable[..., Harness]) -> None:
    """A document lost by a dead worker is found within a minute, and the first look is at the start."""
    harness = make_harness(settings=RunnerSettings(sweep_seconds=0.1))

    harness.runner.start()

    assert wait_for(lambda: len(harness.sweeps) >= 3, timeout=5.0)


def test_a_sweep_that_fails_does_not_stop_the_next_one(make_harness: Callable[..., Harness]) -> None:
    """The sweep's task survives an error, which is logged by type, and tries again."""
    attempts: list[int] = []

    def sometimes_fails() -> None:
        """Fail the first time and work after."""
        attempts.append(1)
        if len(attempts) == 1:
            raise RuntimeError("redis was away")

    harness = make_harness(settings=RunnerSettings(sweep_seconds=0.1), sweep_function=sometimes_fails)

    harness.runner.start()

    assert wait_for(lambda: len(attempts) >= 3, timeout=5.0)


def test_closing_waits_for_documents_that_finish_in_time(make_harness: Callable[..., Harness]) -> None:
    """A worker told to stop gives its documents their grace, and they end as they would have."""
    harness = make_harness(
        reader=FakeReader([invoice_page(INVOICE)], delay=0.4), settings=RunnerSettings(shutdown_grace_seconds=5.0)
    )
    job = upload(harness)
    harness.runner.submit(job)

    harness.runner.close()

    assert document_of(harness, job).state == "ready"


def test_closing_ends_what_did_not_finish_as_interrupted_and_gives_the_visitor_their_place_back(
    make_harness: Callable[..., Harness],
) -> None:
    """A document cut off by the shutdown is not left to be found lost: it is ended and settled on the spot."""
    harness = make_harness(
        reader=FakeReader([invoice_page(INVOICE)], delay=30.0), settings=RunnerSettings(shutdown_grace_seconds=0.3)
    )
    job = upload(harness)
    harness.runner.submit(job)
    assert wait_for(lambda: document_of(harness, job).state == "ocr")

    harness.runner.close()

    document = document_of(harness, job)
    assert (document.state, document.failure_code) == ("failed", FailureCode.INTERRUPTED.value)
    assert counters(harness) == (0, 0, 1)


def test_a_worker_that_exits_ends_the_documents_it_holds_by_closing_the_runner(
    make_harness: Callable[..., Harness], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The runner asks to be closed as the worker stops, so no document is left to be found lost."""
    at_worker_exit: list[Callable[..., object]] = []
    at_interpreter_exit: list[tuple[Callable[..., object], tuple[object, ...]]] = []
    monkeypatch.setattr("lb03.runner.shutdown.register", at_worker_exit.append)
    monkeypatch.setattr(
        "lb03.runner.atexit.register", lambda function, *args: at_interpreter_exit.append((function, args))
    )
    harness = make_harness()

    harness.runner.start()
    harness.runner.start()

    assert at_worker_exit == [harness.runner.close]
    assert at_interpreter_exit == [(harness.runner.close, (0.0,))]


def test_closing_the_runner_stops_the_thread_that_writes_its_spans(make_harness: Callable[..., Harness]) -> None:
    """Nothing is left running when a worker has stopped: the span thread ends with the runner."""
    harness = make_harness()
    job = upload(harness)
    harness.runner.submit(job)
    wait_final(harness, job)

    harness.runner.close()

    assert not harness.queue._thread.is_alive()
    assert {span.run_id for span in harness.spans.spans} == {document_of(harness, job).run_id}


def test_a_closed_runner_takes_no_more_documents(make_harness: Callable[..., Harness]) -> None:
    """After `close`, a document handed over is refused, so the caller can settle the visitor's place."""
    harness = make_harness()
    job = upload(harness)
    harness.runner.start()
    harness.runner.close()

    with pytest.raises(RunnerClosedError):
        harness.runner.submit(job)


def test_the_sweep_ends_a_document_nobody_is_working_on_and_gives_the_place_back(
    make_harness: Callable[..., Harness],
) -> None:
    """A document lost with its worker: no sign of life for longer than the limit, so it is ended as interrupted."""
    harness = make_harness()
    job = upload(harness)
    long_ago = clock() - timedelta(seconds=limits.STALE_AFTER_SECONDS + 120)
    harness.repository.touch([job.document_id], long_ago)

    report = sweep(harness.repository, harness.ledger, harness.store, clock())

    document = document_of(harness, job)
    assert (document.state, document.failure_code) == ("failed", "interrupted")
    assert report.recovered == 1
    assert counters(harness) == (0, 0, 1)


def test_the_sweep_leaves_a_document_that_is_still_being_worked_on(make_harness: Callable[..., Harness]) -> None:
    """A recent sign of life keeps a document: the sweep recovers only the quiet ones."""
    harness = make_harness()
    job = upload(harness)

    report = sweep(harness.repository, harness.ledger, harness.store, clock())

    assert report.recovered == 0
    assert not document_of(harness, job).is_final


def test_the_sweep_deletes_the_documents_whose_hour_is_over_with_their_files(
    make_harness: Callable[..., Harness],
) -> None:
    """After an hour the row and every file of the document are gone, and a fresh document is untouched."""
    harness = make_harness()
    old, fresh = upload(harness, SAM), upload(harness, ALEX)
    harness.runner.start()
    later = clock() + timedelta(seconds=limits.FILE_LIFETIME_SECONDS + 5)
    harness.repository.finish_failed(old.document_id, FailureCode.NO_TEXT, clock(), 0, None, [])

    report = sweep(harness.repository, harness.ledger, harness.store, later)

    assert report.expired == 2
    assert harness.repository.get_for_pipeline(old.document_id) is None
    assert list(harness.store.objects()) == []
    assert fresh.document_id not in {item.id for item in harness.repository.list_for(ALEX, later)}


def test_the_sweep_deletes_a_file_whose_document_was_never_written(make_harness: Callable[..., Harness]) -> None:
    """A process that died between the file and the row leaves a folder with no document: gone after the hour."""
    harness = make_harness()
    orphan = secrets.token_urlsafe(16)
    harness.store.put(original_key(orphan, "pdf"), b"%PDF-1.7 orphan", "application/pdf")
    soon = clock() + timedelta(seconds=limits.FILE_LIFETIME_SECONDS - 600)
    later = clock() + timedelta(seconds=limits.FILE_LIFETIME_SECONDS + 600)

    early = sweep(harness.repository, harness.ledger, harness.store, soon)
    late = sweep(harness.repository, harness.ledger, harness.store, later)

    assert early.orphans == 0
    assert late.orphans == 1
    assert list(harness.store.objects()) == []


def test_the_sweep_settles_an_unfinished_document_before_deleting_it(make_harness: Callable[..., Harness]) -> None:
    """A document still unfinished at its hour is ended and its visitor settled, not just removed."""
    harness = make_harness()
    job = upload(harness)
    later = clock() + timedelta(seconds=limits.FILE_LIFETIME_SECONDS + 5)

    report = sweep(harness.repository, harness.ledger, harness.store, later)

    assert report.expired == 1
    assert counters(harness) == (0, 0, 1)
    assert harness.repository.get_for_pipeline(job.document_id) is None


def test_the_sweep_run_twice_does_the_same_as_once(make_harness: Callable[..., Harness]) -> None:
    """Every step is safe to repeat, and to run in two workers at once."""
    harness = make_harness()
    upload(harness)
    later = clock() + timedelta(seconds=limits.FILE_LIFETIME_SECONDS + 5)

    first = sweep(harness.repository, harness.ledger, harness.store, later)
    second = sweep(harness.repository, harness.ledger, harness.store, later)

    assert (first.expired, second.expired, second.recovered, second.orphans) == (1, 0, 0, 0)
