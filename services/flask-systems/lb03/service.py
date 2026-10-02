"""LB-03 as the running service holds it: the documents, the quota, the files, and the runner that reads them.

`build_service` loads each part and proves it before the service starts to serve: the chart of accounts and the
golden set (whose samples a duplicate is compared with) are read with their strict readers, the file store is opened,
and the ledger and the repository get the system's own Postgres engine. A part that can't be built stops LB-03 from
serving (its routes answer 503 and its readiness check fails) without stopping the other systems of the monolith. With
no gateway the service still serves what needs none (the quota, the visitor's documents), and says it cannot read.

The `Lb03Service` methods are what the HTTP routes call, and they return plain results or a `Refusal` that says which
status and code to answer with: this module knows nothing of Flask, and the routes know nothing of Postgres.
"""

import hashlib
import json
import logging
import re
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Literal

from sqlalchemy.exc import SQLAlchemyError

from config.environment import Environment
from core.data_files import DataFileError
from core.databases import can_query
from core.errors import describe_failure
from core.platform import REPOSITORY_ROOT, Platform
from lb03 import limits
from lb03.accounts import ChartOfAccounts, EntryError, JournalEntry, post, read_chart
from lb03.boxes import check_fields_on_page
from lb03.checks import CheckResult, blocks_export, run_checks
from lb03.duplicates import Known, duplicate_result, find_duplicate, identity_of, sample_identities
from lb03.export import journal_csv, lines_csv
from lb03.golden import read_golden_set
from lb03.invoice import ExtractedInvoice, FieldPathError, get_field, set_field
from lb03.ocr.pool import OcrPool, PoolSettings
from lb03.pipeline import Job, Offload, Parts, Pipeline, Reader
from lb03.quota import Admission, PostgresLedger, Usage, midnight_after
from lb03.repository import (
    DocumentRepository,
    EditedReading,
    NewDocument,
    StoredDocument,
    checks_from_json,
    invoice_from_json,
    placements_from_json,
)
from lb03.runner import PipelineRunner, RunnerBusyError, RunnerClosedError
from lb03.sniff import HEAD_BYTES, sniff_kind
from lb03.spans import QueuedSpanWriter
from lb03.states import DocumentState
from lb03.storage import (
    FileStore,
    LocalFileStore,
    S3FileStore,
    StorageError,
    document_prefix,
    original_key,
    page_key,
    s3_client,
)
from lb03.sweeper import sweep
from lb_common.tracing import Tracer

logger = logging.getLogger(__name__)

# Where uploaded files are kept unless LB03_FILES_DIR says otherwise (git-ignored, with the other generated data).
DEFAULT_FILES_DIRECTORY = REPOSITORY_ROOT / "data" / "generated" / "lb03" / "files"
# The most corrections one document keeps, so a visitor can't grow a row without bound.
MAX_CORRECTIONS = 100
# How many times a correction is worked out again when another one was saved while it was being made.
EDIT_ATTEMPTS = 3
MAX_LABEL_CHARS = 80
# Characters a file name may keep for display; anything else becomes a space. The name is only ever shown back
# to the visitor who sent it, as text, and is never used as a path.
LABEL_UNSAFE = re.compile(r"[^\w .,()+&'-]+", re.UNICODE)

NOT_SERVING_MESSAGE = "The invoice reader is not available right now."
CANNOT_READ_MESSAGE = "The invoice reader has no models to ask right now, so it can't read a document."
DAILY_LIMIT_MESSAGE = (
    f"You have uploaded today's {limits.DOCUMENTS_PER_DAY} documents. The count starts again at midnight UTC."
)
BUSY_MESSAGE = (
    f"{limits.MAX_ACTIVE_PER_VISITOR} of your documents are being read. Wait for one to finish, then upload again."
)
READERS_BUSY_MESSAGE = "The readers are busy with other visitors' documents. Try again in a minute."
TOO_LARGE_MESSAGE = f"The file is larger than {limits.MAX_UPLOAD_BYTES // (1024 * 1024)} MB."
UNSUPPORTED_MESSAGE = "The file is not a PDF, PNG, JPEG or WebP."
NOT_FOUND_MESSAGE = "There is no such document. Documents are deleted an hour after they are uploaded."
NOT_READY_MESSAGE = "The document has not been read yet, or it could not be read."
STILL_READING_MESSAGE = "The document is still being read. It can be deleted once it has ended."
INVALID_FIELD_MESSAGE = "That field doesn't exist on this document, or the value doesn't fit it."
TOO_MANY_CORRECTIONS_MESSAGE = f"A document keeps at most {MAX_CORRECTIONS} corrections."
EDIT_CONFLICT_MESSAGE = "The document was changed while this correction was made. Try it again."
CHECKS_FAILED_MESSAGE = "The document fails a check that stops its export. Correct the failing fields first."
NO_ENTRY_MESSAGE = "The document does not make a balanced journal entry."

type ExportFormat = Literal["csv", "journal", "json"]


@dataclass(frozen=True)
class Refusal:
    """A request the service won't take, as the status and the code it is answered with."""

    status: int
    code: str
    message: str
    resets_at: str | None = None


@dataclass(frozen=True)
class Download:
    """A file the visitor asked for: its bytes, its media type and the fixed name it is offered under."""

    content: bytes
    media_type: str
    filename: str


# What a correction is answered with when another one was saved while it was being made, more than a few times.
EDIT_CONFLICT = Refusal(409, "edit_conflict", EDIT_CONFLICT_MESSAGE)


def clean_label(filename: str | None) -> str:
    """Make a file name safe to show back: no folders, no control or odd characters, and a limit to its length."""
    name = (filename or "").replace("\\", "/").rsplit("/", 1)[-1]
    shown = " ".join(LABEL_UNSAFE.sub(" ", name).split())[:MAX_LABEL_CHARS]
    return shown or "document"


def build_store(environment: Environment) -> FileStore:
    """Open the file store the environment describes: a bucket on any S3-compatible service, or a local folder."""
    if environment.lb03_storage == "s3":
        secret = environment.lb03_s3_secret_access_key
        if environment.lb03_s3_bucket is None or environment.lb03_s3_access_key_id is None or secret is None:
            raise StorageError("The bucket, its access key and its secret are all needed.")
        client = s3_client(
            environment.lb03_s3_endpoint,
            environment.lb03_s3_region,
            environment.lb03_s3_access_key_id,
            secret.get_secret_value(),
        )
        return S3FileStore(client, environment.lb03_s3_bucket)
    folder = Path(environment.lb03_files_dir) if environment.lb03_files_dir else DEFAULT_FILES_DIRECTORY
    return LocalFileStore(folder)


class Lb03Service:
    """What the routes call: upload, read, correct, export and delete a visitor's documents."""

    def __init__(
        self,
        repository: DocumentRepository,
        ledger: PostgresLedger,
        store: FileStore,
        runner: PipelineRunner | None,
        chart: ChartOfAccounts,
        samples: list[Known],
        clock: Callable[[], datetime],
        database_check: Callable[[], bool],
    ) -> None:
        """Serve documents from these parts. `runner` is None when there are no models to ask: nothing can be read."""
        self._repository = repository
        self._ledger = ledger
        self._store = store
        self._runner = runner
        self._chart = chart
        self._samples = samples
        self._clock = clock
        self._database_check = database_check

    def can_read(self) -> bool:
        """Tell whether the service can read documents: it has models to ask, and a runner to do it."""
        return self._runner is not None

    def is_ready(self) -> bool:
        """Tell whether the service can serve right now: its database answers."""
        return self._database_check()

    def close(self) -> None:
        """Stop the runner, which ends the documents it still holds and settles their visitors."""
        if self._runner is not None:
            self._runner.close()

    def usage(self, session_key: str) -> Usage:
        """Return how many documents a visitor has uploaded today, and how many are being read."""
        return self._ledger.usage(session_key)

    def upload(self, session_key: str, filename: str | None, data: bytes) -> StoredDocument | Refusal:
        """Take a visitor's file: look at its first bytes, count it, store it, and hand it to the readers.

        The file is not decoded here, in the web process: only its signature is looked at, and OCR (a caged worker)
        decodes it. A file that is not one of the four kinds, or is too large, is refused before it counts or is stored.
        """
        runner = self._runner
        if runner is None:
            return Refusal(503, "unavailable", CANNOT_READ_MESSAGE)
        if len(data) > limits.MAX_UPLOAD_BYTES:
            return Refusal(413, "too_large", TOO_LARGE_MESSAGE)
        kind = sniff_kind(data[:HEAD_BYTES])
        if kind is None:
            return Refusal(415, "unsupported_file", UNSUPPORTED_MESSAGE)
        admission = self._ledger.admit(session_key)
        if not admission.allowed:
            return self._not_admitted(admission)
        document_id = secrets.token_urlsafe(16)
        try:
            self._store.put(original_key(document_id, kind.extension), data, kind.mime)
            stored = self._repository.create(
                NewDocument(
                    id=document_id,
                    session_key=session_key,
                    label=clean_label(filename),
                    kind=kind.name,
                    byte_size=len(data),
                    file_sha256=hashlib.sha256(data).hexdigest(),
                    admitted_on=admission.day,
                ),
                self._clock(),
            )
            runner.submit(Job(document_id, session_key, kind.name, kind.extension, admission.day, time.monotonic()))
        except RunnerBusyError:
            self._take_back(session_key, admission, document_id)
            return Refusal(503, "readers_busy", READERS_BUSY_MESSAGE)
        except RunnerClosedError:
            self._take_back(session_key, admission, document_id)
            return Refusal(503, "unavailable", NOT_SERVING_MESSAGE)
        except (StorageError, SQLAlchemyError) as error:
            logger.error("Could not take an upload: %s", describe_failure(error))
            self._take_back(session_key, admission, document_id)
            return Refusal(503, "unavailable", NOT_SERVING_MESSAGE)
        return stored

    def document(self, session_key: str, document_id: str) -> StoredDocument | None:
        """Return a visitor's own document, if it exists and has not expired."""
        return self._repository.get(document_id, session_key, self._clock())

    def documents(self, session_key: str) -> list[StoredDocument]:
        """Return a visitor's documents of the hour, newest first."""
        return self._repository.list_for(session_key, self._clock())

    def queued_ahead(self, stored: StoredDocument) -> int | None:
        """Say how many documents are waiting ahead of one that is still waiting; None for any other."""
        if stored.state != DocumentState.UPLOADED.value:
            return None
        return self._repository.queued_ahead(stored)

    def page_picture(self, session_key: str, document_id: str, number: int) -> bytes | Refusal:
        """Return the picture of one page of a visitor's document, which is never served any other way."""
        stored = self.document(session_key, document_id)
        if stored is None or stored.page_count is None or not 1 <= number <= stored.page_count:
            return Refusal(404, "not_found", NOT_FOUND_MESSAGE)
        try:
            return self._store.get(page_key(document_id, number))
        except StorageError:
            return Refusal(404, "not_found", NOT_FOUND_MESSAGE)

    def edit_field(self, session_key: str, document_id: str, path: str, text: str) -> StoredDocument | Refusal:
        """Correct one field of a read document, then run every check again on the corrected reading.

        The new value goes through the same schema a model's answer does, so a number that isn't one is refused. A
        corrected field counts as confirmed by the visitor and loses its box (there is no word on the page to
        point at), the duplicate check and the journal entry are made again, and the correction is recorded.
        """
        for _ in range(EDIT_ATTEMPTS):
            outcome = self._try_edit(session_key, document_id, path, text)
            if outcome is not EDIT_CONFLICT:
                return outcome
        return EDIT_CONFLICT

    def export(self, session_key: str, document_id: str, export_format: ExportFormat) -> Download | Refusal:
        """Make a file of a read document: its lines or its journal entry as CSV, or everything as JSON.

        The CSV files are refused while a failed check stops the export. The JSON always goes: it carries the checks.
        """
        stored = self.document(session_key, document_id)
        if stored is None:
            return Refusal(404, "not_found", NOT_FOUND_MESSAGE)
        if stored.state != DocumentState.READY.value or stored.extraction is None:
            return Refusal(409, "not_ready", NOT_READY_MESSAGE)
        if export_format == "json":
            return self._json_export(stored)
        if blocks_export(checks_from_json(stored.checks or [])):
            return Refusal(409, "checks_failed", CHECKS_FAILED_MESSAGE)
        invoice = invoice_from_json(stored.extraction)
        if export_format == "csv":
            return Download(lines_csv(invoice).encode("utf-8"), "text/csv; charset=utf-8", "invoice-lines.csv")
        try:
            entry = post(invoice, self._chart)
        except EntryError:
            return Refusal(409, "no_journal_entry", NO_ENTRY_MESSAGE)
        return Download(journal_csv(entry).encode("utf-8"), "text/csv; charset=utf-8", "journal-entry.csv")

    def delete(self, session_key: str, document_id: str) -> Refusal | None:
        """Delete a visitor's document that has ended, with its files; None when it was deleted."""
        stored = self.document(session_key, document_id)
        if stored is None:
            return Refusal(404, "not_found", NOT_FOUND_MESSAGE)
        if not stored.is_final:
            return Refusal(409, "still_reading", STILL_READING_MESSAGE)
        try:
            self._store.delete_prefix(document_prefix(document_id))
            self._repository.delete(document_id, session_key)
        except (StorageError, SQLAlchemyError) as error:
            logger.error("Could not delete a document: %s", describe_failure(error))
            return Refusal(503, "unavailable", NOT_SERVING_MESSAGE)
        return None

    def _not_admitted(self, admission: Admission) -> Refusal:
        """Turn the ledger's refusal into the answer: the day's documents used up, or two being read."""
        if admission.reason == "busy":
            return Refusal(429, "document_running", BUSY_MESSAGE)
        return Refusal(429, "daily_limit", DAILY_LIMIT_MESSAGE, resets_at=midnight_after(admission.day).isoformat())

    def _take_back(self, session_key: str, admission: Admission, document_id: str) -> None:
        """Undo an upload that could not be handed to the readers: its files, its row, and the visitor's place."""
        try:
            self._store.delete_prefix(document_prefix(document_id))
        except StorageError as error:
            logger.error("Could not delete the files of a refused upload: %s", describe_failure(error))
        try:
            self._repository.delete(document_id, session_key)
            self._ledger.release(session_key, admission.day, refund=True)
        except SQLAlchemyError as error:
            logger.error("Could not settle a refused upload: %s", describe_failure(error))

    def _try_edit(self, session_key: str, document_id: str, path: str, text: str) -> StoredDocument | Refusal:
        """Work out one correction on the document as it is now, and save it; `conflict` as a refusal if it moved."""
        now = self._clock()
        stored = self._repository.get(document_id, session_key, now)
        if stored is None:
            return Refusal(404, "not_found", NOT_FOUND_MESSAGE)
        if stored.state != DocumentState.READY.value or stored.extraction is None:
            return Refusal(409, "not_ready", NOT_READY_MESSAGE)
        if len(stored.corrections) >= MAX_CORRECTIONS:
            return Refusal(409, "too_many_corrections", TOO_MANY_CORRECTIONS_MESSAGE)
        invoice = invoice_from_json(stored.extraction)
        try:
            before = get_field(invoice, path)
            edited = set_field(invoice, path, text)
            after = get_field(edited, path)
        except FieldPathError:
            return Refusal(422, "invalid_field", INVALID_FIELD_MESSAGE)
        if after == before:
            return stored
        placements = {key: box for key, box in placements_from_json(stored.placements or {}).items() if key != path}
        confirmed = {item["path"] for item in stored.corrections} | {path}
        results = run_checks(edited, now.date())
        results.append(check_fields_on_page(edited, set(placements), confirmed))
        identity = identity_of(edited)
        others = self._repository.known_identities(session_key, now, exclude=document_id)
        match = find_duplicate(identity, [*others, *self._samples]) if identity is not None else None
        results.append(duplicate_result(identity, match))
        reading = EditedReading(
            invoice=edited,
            placements=placements,
            checks=results,
            journal=self._entry_for(edited, results),
            identity=identity,
            duplicate_of=f"{match.known.source}:{match.known.reference}" if match is not None else None,
            duplicate_same_content=match.same_content if match is not None else None,
        )
        correction = {"path": path, "was": before, "now": after, "at": now.isoformat()}
        saved = self._repository.save_edit(document_id, session_key, reading, correction, len(stored.corrections), now)
        if saved == "conflict":
            return EDIT_CONFLICT
        if saved == "missing":
            return Refusal(404, "not_found", NOT_FOUND_MESSAGE)
        updated = self._repository.get(document_id, session_key, now)
        return updated if updated is not None else Refusal(404, "not_found", NOT_FOUND_MESSAGE)

    def _entry_for(self, invoice: ExtractedInvoice, results: list[CheckResult]) -> JournalEntry | None:
        """Make the journal entry of a corrected reading, only when no failed check stops its export."""
        if blocks_export(results):
            return None
        try:
            return post(invoice, self._chart)
        except EntryError:
            return None

    @staticmethod
    def _json_export(stored: StoredDocument) -> Download:
        """Make the JSON file of a read document: the invoice, its checks, the journal entry and its corrections."""
        content = {
            "document": {
                "id": stored.id,
                "label": stored.label,
                "kind": stored.kind,
                "pages": stored.page_count,
                "model": stored.model,
                "run_id": stored.run_id,
            },
            "invoice": stored.extraction,
            "checks": stored.checks,
            "journal": stored.journal,
            "duplicate_of": stored.duplicate_of,
            "corrections": stored.corrections,
        }
        text = json.dumps(content, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
        return Download(text.encode("utf-8"), "application/json", "invoice.json")


def build_service(platform: Platform, reader: Reader | None = None) -> Lb03Service | None:
    """Build the service from the platform, or return None, saying why in the log, when a part can't be built.

    `reader` replaces the OCR pool, for tests that must not run OCR; the running service never passes one.
    """
    environment = platform.environment
    engine = platform.engines.get("lb03")
    if engine is None:
        logger.error("LB-03 can't start: the platform has no database engine for its schema.")
        return None
    try:
        chart = read_chart(platform.seed_directory() / "lb03")
        samples = sample_identities(read_golden_set())
        store = build_store(environment)
    except (DataFileError, StorageError, OSError) as error:
        logger.error("LB-03 can't start: %s", describe_failure(error))
        return None
    repository = DocumentRepository(engine)
    ledger = PostgresLedger(engine, platform.clock)
    runner = build_runner(platform, repository, ledger, store, chart, samples, reader)
    return Lb03Service(
        repository=repository,
        ledger=ledger,
        store=store,
        runner=runner,
        chart=chart,
        samples=samples,
        clock=platform.clock,
        database_check=lambda: can_query(engine),
    )


def build_runner(
    platform: Platform,
    repository: DocumentRepository,
    ledger: PostgresLedger,
    store: FileStore,
    chart: ChartOfAccounts,
    samples: list[Known],
    reader: Reader | None = None,
) -> PipelineRunner | None:
    """Make the runner, or None (with a warning) when the platform has no models, no injection check or no spans."""
    chat, guard, span_writer = platform.chat, platform.guard, platform.span_writer
    if chat is None or guard is None or span_writer is None:
        logger.warning("LB-03 has no gateway: it serves its quota and documents, and can't read a new document.")
        return None
    environment = platform.environment

    def build_pipeline(offload: Offload) -> Pipeline:
        """Make the pipeline when the first document arrives, so its OCR pool and span thread start after the fork."""
        scratch = Path(environment.lb03_scratch_dir) if environment.lb03_scratch_dir else None
        pool = reader or OcrPool(PoolSettings(workers=environment.lb03_ocr_workers, scratch_root=scratch))
        return Pipeline(
            Parts(
                chat=chat,
                guard=guard,
                reader=pool,
                store=store,
                repository=repository,
                tracer=Tracer(QueuedSpanWriter(span_writer)),
                chart=chart,
                samples=samples,
                offload=offload,
                clock=platform.clock,
            )
        )

    def sweep_now() -> None:
        """Run one pass of the sweep as of now."""
        sweep(repository, ledger, store, platform.clock())

    return PipelineRunner(build_pipeline, repository, ledger, sweep_now, platform.clock)
