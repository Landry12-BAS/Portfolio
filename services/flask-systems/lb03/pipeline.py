"""LB-03's pipeline: one document, from the uploaded file to a checked reading with a box for every field.

    OCR (a caged worker) -> injection check -> extract (lb-fast on the text; lb-vision with the picture for a photo)
    -> validate -> [at most one targeted repair] -> boxes -> duplicates -> journal entry -> ready

One document is one run of LB-03. Each step is a span of the run's trace and a record in the document's own list of
steps, and both hold metadata only: counts, durations, names of checks, never a word of the document. Every model
call goes through the gateway labelled with the run, so the run's quotas apply and the Scope shows the whole story.

The pipeline is async because a document spends most of its time waiting: for a free OCR worker, for a model, for
storage and the database. While one document waits, another is read. Everything that blocks (the gateway's calls, the
file store, the database, the box rule) is handed to a thread pool with the run's context copied across, so the
event loop only ever coordinates, and no document holds up another. The OCR worker is a process of its own and is
awaited the same way; reading itself is bounded by the pool's few workers, since it is CPU work.

Everything a model says is untrusted. It is parsed against the lenient invoice schema, held to the arithmetic checks
(which code owns, never the model), tied to the words on the page by the box rule, and compared with the visitor's
other documents. A document that does not add up is returned with its failing checks listed, never fixed by code.
The text a model is shown was first checked by the gateway's injection classifier, and sits in a delimited slot.

A run ends in one of two states, and writes it once: `ready` (with whatever checks failed, which is a finding and
not a failure) or `failed` with a code from a fixed list. `Ended.wrote` says whether this run wrote the ending, so the
caller gives the visitor's place back exactly once.
"""

import asyncio
import base64
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Protocol

from openai import OpenAIError

from core.structured import ChatMessage, ChatModels, InjectionGuard, StructuredAnswer, StructuredOutputError
from lb03 import limits
from lb03.accounts import ChartOfAccounts, EntryError, JournalEntry, post
from lb03.boxes import PageWords, Placement, check_fields_on_page, expected_paths, place_fields
from lb03.checks import REPAIRABLE, CheckResult, Severity, blocks_export, failures, run_checks
from lb03.duplicates import Identity, Known, duplicate_result, find_duplicate, identity_of
from lb03.extraction import CallBudget, LimitError, extract, repair
from lb03.invoice import ExtractedInvoice
from lb03.ocr.pool import OcrError, Reading
from lb03.prompts import EXTRACT_ALIAS, VISION_ALIAS, Slot, extraction_messages, guard_segments, new_code, reading_text
from lb03.repository import FinishedReading
from lb03.states import DocumentState, FailureCode
from lb03.storage import FileStore, StorageError, original_key, page_key
from lb_common.run import Run, new_run_id, run_scope
from lb_common.tracing import OpenSpan, Tracer

SYSTEM_KEY = "lb-03"
# What the gateway says when a budget or a quota is spent, as opposed to a failure.
BUDGET_CODES = frozenset({"quota_exceeded", "budget_exhausted"})
# The only picture format the vision model is sent, as an inline data URL.
JPEG_DATA_URL = "data:image/jpeg;base64,"
type Detail = dict[str, str | int | float | bool]


class Offload(Protocol):
    """Runs a blocking function off the event loop, in a thread pool, inside a copy of the run's context."""

    async def __call__[Result](self, function: Callable[..., Result], *arguments: Any) -> Result:
        """Call `function` with the arguments in a worker thread and wait for what it returns."""
        ...


class Documents(Protocol):
    """Where the pipeline keeps a document's progress and its ending: Postgres in the service, memory in the eval."""

    def advance(self, document_id: str, state: DocumentState, steps: Sequence[dict[str, Any]], now: datetime) -> bool:
        """Move a document that is still being read to its next state; False if it has ended or is gone."""
        ...

    def finish_ready(self, document_id: str, reading: FinishedReading, now: datetime) -> bool:
        """Save a finished reading and mark the document `ready`; False if it had already ended."""
        ...

    def finish_failed(
        self,
        document_id: str,
        code: FailureCode,
        now: datetime,
        model_calls: int,
        run_id: str | None,
        steps: list[dict[str, Any]],
    ) -> bool:
        """Mark a document `failed` with the code that says why; False if it had already ended."""
        ...

    def known_identities(self, session_key: str, now: datetime, exclude: str) -> list[Known]:
        """Return the identities of the visitor's other finished documents of the hour, for the duplicate check."""
        ...


class Reader(Protocol):
    """Reads a file's pages: the OCR pool, or a stand-in for it in tests."""

    async def read(self, data: bytes, on_start: Callable[[], Awaitable[None]] | None = None) -> Reading:
        """Return what the worker read, awaiting `on_start` once the reading itself begins."""
        ...


@dataclass(frozen=True)
class Parts:
    """What the pipeline is built from, so a test can replace each part with a fake of its own."""

    chat: ChatModels
    guard: InjectionGuard | None
    reader: Reader
    store: FileStore
    repository: Documents
    tracer: Tracer
    chart: ChartOfAccounts
    samples: Sequence[Known]
    offload: Offload
    clock: Callable[[], datetime]
    monotonic: Callable[[], float] = time.monotonic
    # What to do when the pipeline is finished with for good, such as stopping the thread that writes its spans.
    cleanup: Callable[[], object] | None = None


@dataclass(frozen=True)
class Job:
    """One document to read: who sent it, what it is, and when it was handed to the pipeline.

    The file itself is not in the job: it is in the file store, and the pipeline reads it when its turn comes, so a
    document that is waiting for a place holds no memory.
    """

    document_id: str
    session_key: str
    kind: str
    extension: str
    admitted_on: date
    submitted: float
    # A document of the eval or of a recorded sample, not a visitor's: its run has no session, so no visitor's
    # daily quota at the gateway is counted for it.
    synthetic: bool = False


@dataclass(frozen=True)
class Ended:
    """How a document's run ended: with a reading (no failure) or with a failure code.

    `wrote` is true when this run wrote the ending itself. It is false when the document had already ended or was
    gone, which means whoever ended it also gave the visitor's place back, so the caller must not.
    """

    failure: FailureCode | None
    wrote: bool
    model_calls: int
    run_id: str


class StopError(Exception):
    """The run can't go on: `step` is where it stopped and `code` says why the document has no result."""

    def __init__(self, step: str, code: FailureCode) -> None:
        """Stop at `step`, for `code`."""
        super().__init__(f"{step}: {code.value}")
        self.step = step
        self.code = code


class GoneError(Exception):
    """The document ended, or was removed, while the run was working on it, so there is nothing left to do."""


@dataclass
class Work:
    """One document while it is being read: its run, its call budget, and the steps finished so far."""

    job: Job
    run_id: str
    budget: CallBudget | None = None
    steps: list[dict[str, Any]] = field(default_factory=list)
    unsaved: list[dict[str, Any]] = field(default_factory=list)

    def note(self, name: str, started: float, now: float, status: str = "ok", detail: Detail | None = None) -> None:
        """Record a finished step: what it was, whether it worked, how long it took and a few counts."""
        record: dict[str, Any] = {"name": name, "status": status, "ms": round((now - started) * 1000)}
        record["detail"] = detail or {}
        self.steps.append(record)
        self.unsaved.append(record)

    def calls(self) -> int:
        """Return how many model calls the document has made."""
        return self.budget.calls if self.budget is not None else 0


@dataclass(frozen=True)
class Extraction:
    """What the extraction step came to: the invoice, the reply it was read from, and what to ask again with."""

    invoice: ExtractedInvoice
    reply: str
    model: str
    alias: str
    messages: list[ChatMessage]
    slot: Slot


def model_failure(error: OpenAIError) -> FailureCode:
    """Say why a model call failed: the gateway's budget or quota is spent, or something went wrong."""
    code = getattr(error, "code", None)
    return FailureCode.MODEL_BUDGET if code in BUDGET_CODES else FailureCode.MODEL_FAILED


def repair_failure(error: LimitError | StructuredOutputError | OpenAIError) -> str:
    """Say, in the fixed vocabulary of failure codes, why a repair could not be made."""
    if isinstance(error, LimitError):
        return error.code.value
    if isinstance(error, StructuredOutputError):
        return FailureCode.MODEL_OUTPUT.value
    return model_failure(error).value


def data_url(picture: bytes) -> str:
    """Write a JPEG as the inline data URL the models are sent a picture in."""
    return JPEG_DATA_URL + base64.b64encode(picture).decode("ascii")


def error_checks(results: Sequence[CheckResult]) -> list[CheckResult]:
    """Return the failed checks that stop an export."""
    return [result for result in failures(list(results)) if result.severity is Severity.ERROR]


class Pipeline:
    """Reads documents: the whole chain, safe to share between the documents in flight."""

    def __init__(self, parts: Parts) -> None:
        """Read documents with `parts`."""
        self.parts = parts

    def close(self) -> None:
        """Release what the pipeline holds (the span thread, say) once no document will be read again."""
        if self.parts.cleanup is not None:
            self.parts.cleanup()

    async def process(self, job: Job) -> Ended:
        """Read one document as one run of LB-03, and write how it ended.

        Raises only for a bug: every way a document can fail by itself is a failure code written to the document.
        """
        run = Run(
            system=SYSTEM_KEY,
            run_id=new_run_id(),
            data_class="synthetic" if job.synthetic else "visitor",
            session=None if job.synthetic else job.session_key,
        )
        work = Work(job=job, run_id=run.run_id)
        with run_scope(run), self.parts.tracer.span("invoice reading", kind="system.run") as root:
            ended = await self.guarded(work)
            root.set("kind", job.kind)
            root.set("outcome", "ready" if ended.failure is None else "failed")
            root.set("model_calls", ended.model_calls)
            if ended.failure is not None:
                root.set("failure", ended.failure.value)
        return ended

    async def guarded(self, work: Work) -> Ended:
        """Run the steps under the whole-document time limit, and turn every way of stopping into an ending."""
        try:
            async with asyncio.timeout(limits.HARD_LIMIT_SECONDS):
                return await self.read_document(work)
        except StopError as stop:
            return await self.fail(work, stop.step, stop.code)
        except GoneError:
            return Ended(None, False, work.calls(), work.run_id)
        except TimeoutError:
            return await self.fail(work, "time limit", FailureCode.TIME_LIMIT)

    async def read_document(self, work: Work) -> Ended:
        """Take the document through the steps, in order; each raises `StopError` when the document can't go on."""
        reading = await self.read_pages(work)
        pages = [PageWords(page.number, page.words) for page in reading.pages]
        extraction = await self.extract_invoice(work, reading, pages)
        invoice, results, model = await self.validate_and_repair(work, extraction)
        placements, results = await self.locate_fields(work, invoice, pages, results)
        identity, match, results = await self.compare_with_others(work, invoice, results)
        journal = await self.make_journal(work, invoice, results)
        finished = FinishedReading(
            invoice=invoice,
            placements=placements,
            checks=results,
            journal=journal,
            identity=identity,
            duplicate_of=match[0] if match else None,
            duplicate_same_content=match[1] if match else None,
            page_count=len(reading.pages),
            text_cut=extraction.slot.cut,
            model=model,
            model_calls=work.calls(),
            run_id=work.run_id,
            ocr_ms=reading.wall_ms,
            elapsed_ms=self.elapsed_ms(work),
            steps=work.steps,
        )
        wrote = await self.parts.offload(
            self.parts.repository.finish_ready, work.job.document_id, finished, self.parts.clock()
        )
        return Ended(None, wrote, work.calls(), work.run_id)

    def elapsed_ms(self, work: Work) -> int:
        """Return how long ago the document was handed to the pipeline, in milliseconds."""
        return round((self.parts.monotonic() - work.job.submitted) * 1000)

    async def fail(self, work: Work, step: str, code: FailureCode) -> Ended:
        """Write that the document has no result, for `code`, noting the step it stopped at."""
        now = self.parts.monotonic()
        work.note(step, now, now, status="error", detail={"code": code.value})
        wrote = await self.parts.offload(
            self.parts.repository.finish_failed,
            work.job.document_id,
            code,
            self.parts.clock(),
            work.calls(),
            work.run_id,
            work.steps,
        )
        return Ended(code, wrote, work.calls(), work.run_id)

    async def advance(self, work: Work, state: DocumentState) -> None:
        """Move the document to its next state, saving the steps finished so far; `GoneError` if it has ended."""
        steps = list(work.unsaved)
        work.unsaved.clear()
        moved = await self.parts.offload(
            self.parts.repository.advance, work.job.document_id, state, steps, self.parts.clock()
        )
        if not moved:
            raise GoneError

    async def read_pages(self, work: Work) -> Reading:
        """Read the pages in the caged worker, keep a picture of each for the viewer, and refuse a page-less read."""
        waiting_since = work.job.submitted

        async def on_start() -> None:
            """Note how long the document waited for a free reader, and show it as being read."""
            now = self.parts.monotonic()
            work.note("queue", waiting_since, now, detail={"waited_ms": round((now - waiting_since) * 1000)})
            await self.advance(work, DocumentState.OCR)

        started = self.parts.monotonic()
        with self.parts.tracer.span("read pages", kind="system.tool") as span:
            data = await self.load_file(work)
            try:
                reading = await self.parts.reader.read(data, on_start)
            except OcrError as error:
                span.set("code", error.code.value)
                if error.exit_status is not None:
                    span.set("exit_status", error.exit_status)
                raise StopError("ocr", error.code) from None
            words = sum(len(page.words) for page in reading.pages)
            span.set("pages", len(reading.pages))
            span.set("words", words)
            span.set("worker_ms", reading.worker_ms)
            span.set("wall_ms", reading.wall_ms)
            self.describe_cage(span, reading)
            if words == 0:
                raise StopError("ocr", FailureCode.NO_TEXT)
            await self.keep_pictures(work, reading)
        sandbox = reading.sandbox
        detail: Detail = {
            "pages": len(reading.pages),
            "words": words,
            "worker_ms": reading.worker_ms,
            "seccomp": sandbox.seccomp,
            "landlock_abi": sandbox.landlock_abi,
        }
        work.note("ocr", started, self.parts.monotonic(), detail=detail)
        return reading

    async def load_file(self, work: Work) -> bytes:
        """Read the uploaded file back from the store; a file that is gone or can't be read fails the document."""
        key = original_key(work.job.document_id, work.job.extension)
        try:
            return await self.parts.offload(self.parts.store.get, key)
        except StorageError:
            raise StopError("ocr", FailureCode.OCR_FAILED) from None

    @staticmethod
    def describe_cage(span: OpenSpan, reading: Reading) -> None:
        """Record on the span which walls the OCR worker put up round itself."""
        span.set("rlimits", reading.sandbox.rlimits)
        span.set("no_new_privileges", reading.sandbox.no_new_privileges)
        span.set("seccomp", reading.sandbox.seccomp)
        span.set("landlock_abi", reading.sandbox.landlock_abi)

    async def keep_pictures(self, work: Work, reading: Reading) -> None:
        """Store the picture of each page, for the viewer, under the document's own prefix."""
        for page in reading.pages:
            key = page_key(work.job.document_id, page.number)
            await self.parts.offload(self.parts.store.put, key, page.picture, "image/jpeg")

    async def extract_invoice(self, work: Work, reading: Reading, pages: list[PageWords]) -> Extraction:
        """Check the text for an injection, then ask the model to fill the invoice schema from it (and the picture)."""
        await self.advance(work, DocumentState.EXTRACT)
        work.budget = CallBudget(self.parts.chat, self.parts.guard, self.parts.monotonic)
        picture = data_url(reading.model_picture) if reading.model_picture is not None else None
        alias = VISION_ALIAS if picture is not None else EXTRACT_ALIAS
        messages, slot = extraction_messages(reading_text(pages), alias, new_code(), picture)
        await self.check_injection(work, slot.text)
        started = self.parts.monotonic()
        with self.parts.tracer.span("extract", alias=alias, picture=picture is not None) as span:
            try:
                answer = await self.parts.offload(extract, work.budget, alias, messages)
            except LimitError as error:
                raise StopError("extract", error.code) from None
            except StructuredOutputError:
                raise StopError("extract", FailureCode.MODEL_OUTPUT) from None
            except OpenAIError as error:
                raise StopError("extract", model_failure(error)) from None
            span.set("attempts", answer.attempts)
            span.set("text_cut", slot.cut)
            span.set("text_chars", len(slot.text))
        detail: Detail = {
            "alias": alias,
            "attempts": answer.attempts,
            "text_chars": len(slot.text),
            "text_cut": slot.cut,
            "picture": picture is not None,
        }
        work.note("extract", started, self.parts.monotonic(), detail=detail)
        return Extraction(answer.value, answer.reply, answer.model, alias, list(messages), slot)

    async def check_injection(self, work: Work, text: str) -> None:
        """Ask the gateway's injection check about exactly the text the model will be shown; a flag stops the document.

        A check that could not be made counts as unchecked, and the model is never shown text nobody looked at.
        """
        started = self.parts.monotonic()
        segments = guard_segments(text)
        budget = work.budget
        if budget is None:
            raise StopError("injection check", FailureCode.UNCHECKED)
        if not segments:
            raise StopError("injection check", FailureCode.NO_TEXT)
        highest = 0.0
        flagged = False
        with self.parts.tracer.span("injection check", kind="system.tool", segments=len(segments)) as span:
            for segment in segments:
                try:
                    verdict = await self.parts.offload(budget.check_injection, segment)
                except LimitError as error:
                    raise StopError("injection check", error.code) from None
                except OpenAIError:
                    raise StopError("injection check", FailureCode.UNCHECKED) from None
                highest = max(highest, verdict.score)
                if verdict.flagged:
                    flagged = True
                    break
            span.set("flagged", flagged)
            span.set("score", round(highest, 4))
        detail: Detail = {"segments": len(segments), "flagged": flagged, "score": round(highest, 4)}
        work.note("injection check", started, self.parts.monotonic(), detail=detail)
        if flagged:
            raise StopError("injection check", FailureCode.INJECTION_SUSPECTED)

    async def validate_and_repair(
        self, work: Work, extraction: Extraction
    ) -> tuple[ExtractedInvoice, list[CheckResult], str]:
        """Check the arithmetic, and send the model back once, naming the failed checks a rereading may fix.

        The repaired reading replaces the first only if it fails fewer checks; either way the failing checks that are
        left are reported. Returns the invoice, its results and the model that wrote it.
        """
        await self.advance(work, DocumentState.VALIDATE)
        results = await self.validate(work, extraction.invoice)
        repairable = failures(results, REPAIRABLE)
        if not repairable or not self.may_repair(work):
            return extraction.invoice, results, extraction.model
        await self.advance(work, DocumentState.REPAIR)
        repaired = await self.repair_reading(work, extraction, results, repairable)
        return repaired if repaired is not None else (extraction.invoice, results, extraction.model)

    def may_repair(self, work: Work) -> bool:
        """Tell whether the document may still make the one call a repair needs."""
        budget = work.budget
        return (
            budget is not None
            and budget.calls < limits.MAX_MODEL_CALLS
            and budget.seconds_left() >= limits.MIN_CALL_SECONDS
        )

    async def validate(self, work: Work, invoice: ExtractedInvoice) -> list[CheckResult]:
        """Run the arithmetic checks on an invoice, as a step of the run."""
        started = self.parts.monotonic()
        with self.parts.tracer.span("validate") as span:
            results = await self.parts.offload(run_checks, invoice, self.parts.clock().date())
            failed = len(failures(results))
            span.set("failed", failed)
        work.note("validate", started, self.parts.monotonic(), detail={"failed": failed, "ran": len(results)})
        return results

    async def repair_reading(
        self, work: Work, extraction: Extraction, results: list[CheckResult], repairable: list[CheckResult]
    ) -> tuple[ExtractedInvoice, list[CheckResult], str] | None:
        """Send the model back to the document once, and take its new reading only if it fails fewer checks.

        Returns the new reading, or None when the repair could not be made or did not help: the first reading
        then stands, and its failing checks are what the visitor is shown. A failed repair never fails the document.
        """
        budget = work.budget
        if budget is None:
            return None
        started = self.parts.monotonic()
        with self.parts.tracer.span("repair", checks=len(repairable)) as span:
            try:
                answer: StructuredAnswer[ExtractedInvoice] = await self.parts.offload(
                    repair, budget, extraction.alias, extraction.messages, extraction.reply, repairable
                )
            except (LimitError, StructuredOutputError, OpenAIError) as error:
                reason = repair_failure(error)
                span.set("error", reason)
                work.note("repair", started, self.parts.monotonic(), status="error", detail={"reason": reason})
                return None
            repaired_results = await self.parts.offload(run_checks, answer.value, self.parts.clock().date())
            before, after = len(error_checks(results)), len(error_checks(repaired_results))
            adopted = after < before
            span.set("adopted", adopted)
            span.set("failed_before", before)
            span.set("failed_after", after)
        detail: Detail = {"adopted": adopted, "failed_before": before, "failed_after": after}
        work.note("repair", started, self.parts.monotonic(), detail=detail)
        return (answer.value, repaired_results, answer.model) if adopted else None

    async def locate_fields(
        self, work: Work, invoice: ExtractedInvoice, pages: list[PageWords], results: list[CheckResult]
    ) -> tuple[dict[str, Placement], list[CheckResult]]:
        """Find the box of every field on the page, and warn about the values that are not on it."""
        started = self.parts.monotonic()
        with self.parts.tracer.span("place fields") as span:
            found = await self.parts.offload(place_fields, invoice, pages)
            check = check_fields_on_page(invoice, set(found))
            expected = len(expected_paths(invoice))
            span.set("found", len(found))
            span.set("expected", expected)
        work.note("place fields", started, self.parts.monotonic(), detail={"found": len(found), "expected": expected})
        return found, [*results, check]

    async def compare_with_others(
        self, work: Work, invoice: ExtractedInvoice, results: list[CheckResult]
    ) -> tuple[Identity | None, tuple[str, bool] | None, list[CheckResult]]:
        """Compare the invoice with the visitor's other documents of the hour and the samples, for a duplicate."""
        started = self.parts.monotonic()
        identity = identity_of(invoice)
        match = None
        compared = 0
        with self.parts.tracer.span("check duplicates") as span:
            if identity is not None:
                others = await self.parts.offload(
                    self.parts.repository.known_identities,
                    work.job.session_key,
                    self.parts.clock(),
                    work.job.document_id,
                )
                known = [*others, *self.parts.samples]
                compared = len(known)
                match = find_duplicate(identity, known)
            span.set("compared", compared)
            span.set("duplicate", match is not None)
        result = duplicate_result(identity, match)
        work.note(
            "check duplicates",
            started,
            self.parts.monotonic(),
            detail={"compared": compared, "duplicate": match is not None},
        )
        found = (f"{match.known.source}:{match.known.reference}", match.same_content) if match is not None else None
        return identity, found, [*results, result]

    async def make_journal(
        self, work: Work, invoice: ExtractedInvoice, results: list[CheckResult]
    ) -> JournalEntry | None:
        """Make the balanced journal entry, only for a document no failed check stops from being exported."""
        started = self.parts.monotonic()
        entry = None
        status = "ok"
        detail: Detail = {}
        with self.parts.tracer.span("journal entry") as span:
            if blocks_export(results):
                status, detail = "skipped", {"reason": "checks_failed"}
                span.skip("checks_failed")
            else:
                try:
                    entry = post(invoice, self.parts.chart)
                except EntryError:
                    status, detail = "error", {"reason": "does_not_balance"}
                    span.set("reason", "does_not_balance")
                else:
                    span.set("lines", len(entry.lines))
                    detail = {"lines": len(entry.lines)}
        work.note("journal entry", started, self.parts.monotonic(), status=status, detail=detail)
        return entry
