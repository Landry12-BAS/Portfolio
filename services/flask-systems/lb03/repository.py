"""Reading and writing documents: every statement is by id and visitor, and a document that has ended stays ended.

The pipeline works on a document for up to a couple of minutes, in a process that may die, while the visitor's
page polls it and may edit it. Two rules keep that safe:

- A read of a document is by id *and* session key, and only while it has not expired, so one visitor never sees
  another's document and a document is gone at its hour even before the sweep removes it.
- A document that is `ready` or `failed` is final: a late step of the pipeline, or the recovery of a lost document,
  can't overwrite it. Each write that moves a document along checks that in the same transaction, under a row lock.

JSON columns hold the checked reading. The functions at the top turn the domain's objects into JSON and back, so
the schema of each column is in one place, and nothing read from the database is trusted without being parsed again.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field, fields
from datetime import date, datetime, timedelta
from typing import Any, Literal, cast

from sqlalchemy import Engine, delete, func, insert, select, update
from sqlalchemy.engine import Row

from lb03 import limits
from lb03.accounts import JournalEntry
from lb03.boxes import Placement
from lb03.checks import CheckId, CheckResult, Severity
from lb03.duplicates import Identity, Known
from lb03.invoice import ExtractedInvoice
from lb03.models import Document
from lb03.ocr.protocol import Quad
from lb03.states import ACTIVE_STATES, FINAL_STATES, DocumentState, FailureCode

type SaveOutcome = Literal["saved", "conflict", "missing"]
FINAL_VALUES = tuple(state.value for state in FINAL_STATES)
ACTIVE_VALUES = tuple(state.value for state in ACTIVE_STATES)


def invoice_json(invoice: ExtractedInvoice) -> dict[str, Any]:
    """Write an invoice as the JSON the extraction column holds: amounts as exact decimal strings, dates as ISO."""
    return invoice.model_dump(mode="json")


def invoice_from_json(content: dict[str, Any]) -> ExtractedInvoice:
    """Read an invoice back from its column, validating it again as if it had just come from a model."""
    return ExtractedInvoice.model_validate(content)


def checks_json(results: Sequence[CheckResult]) -> list[dict[str, Any]]:
    """Write check results as the JSON the checks column holds."""
    return [
        {
            "id": result.id.value,
            "status": result.status,
            "severity": result.severity.value,
            "message": result.message,
            "fields": list(result.fields),
            "expected": result.expected,
            "actual": result.actual,
        }
        for result in results
    ]


def checks_from_json(content: Sequence[dict[str, Any]]) -> list[CheckResult]:
    """Read check results back from their column."""
    return [
        CheckResult(
            id=CheckId(item["id"]),
            status=item["status"],
            severity=Severity(item["severity"]),
            message=item["message"],
            fields=tuple(item["fields"]),
            expected=item["expected"],
            actual=item["actual"],
        )
        for item in content
    ]


def placements_json(found: dict[str, Placement]) -> dict[str, Any]:
    """Write the boxes found for the fields as the JSON the placements column holds."""
    return {
        path: {
            "page": placement.page,
            "quad": list(placement.quad),
            "confidence": placement.confidence,
            "match": placement.match,
        }
        for path, placement in found.items()
    }


def placements_from_json(content: dict[str, Any]) -> dict[str, Placement]:
    """Read the boxes of the fields back from their column."""
    return {
        path: Placement(
            path=path,
            page=int(item["page"]),
            quad=cast(Quad, tuple(float(value) for value in item["quad"])),
            confidence=float(item["confidence"]),
            match=float(item["match"]),
        )
        for path, item in content.items()
    }


def journal_json(entry: JournalEntry | None) -> dict[str, Any] | None:
    """Write a journal entry as the JSON the journal column holds, amounts as decimal strings."""
    if entry is None:
        return None
    return {
        "date": entry.day.isoformat(),
        "reference": entry.reference,
        "currency": entry.currency,
        "lines": [
            {
                "account": line.account,
                "name": line.name,
                "debit": f"{line.debit:.2f}",
                "credit": f"{line.credit:.2f}",
                "memo": line.memo,
            }
            for line in entry.lines
        ],
    }


@dataclass(frozen=True)
class NewDocument:
    """What is known when a file is accepted: who sent it, what it is, and when it was counted."""

    id: str
    session_key: str
    label: str
    kind: str
    byte_size: int
    file_sha256: str
    admitted_on: date


@dataclass(frozen=True)
class FinishedReading:
    """What the pipeline made of a document, to be saved together when it ends `ready`."""

    invoice: ExtractedInvoice
    placements: dict[str, Placement]
    checks: list[CheckResult]
    journal: JournalEntry | None
    identity: Identity | None
    duplicate_of: str | None
    duplicate_same_content: bool | None
    page_count: int
    text_cut: bool
    model: str
    model_calls: int
    run_id: str
    ocr_ms: int
    elapsed_ms: int
    steps: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class EditedReading:
    """A document's reading after a visitor corrected a field: everything that follows from the new value."""

    invoice: ExtractedInvoice
    placements: dict[str, Placement]
    checks: list[CheckResult]
    journal: JournalEntry | None
    identity: Identity | None
    duplicate_of: str | None
    duplicate_same_content: bool | None


@dataclass(frozen=True)
class StoredDocument:
    """A document row as plain data."""

    id: str
    session_key: str
    state: str
    failure_code: str | None
    label: str
    kind: str
    byte_size: int
    file_sha256: str
    page_count: int | None
    admitted_on: date
    extraction: dict[str, Any] | None
    placements: dict[str, Any] | None
    checks: list[dict[str, Any]] | None
    journal: dict[str, Any] | None
    steps: list[dict[str, Any]]
    corrections: list[dict[str, Any]]
    identity_vendor: str | None
    identity_number: str | None
    content_hash: str | None
    duplicate_of: str | None
    duplicate_same_content: bool | None
    text_cut: bool
    model: str | None
    model_calls: int
    run_id: str | None
    ocr_ms: int | None
    elapsed_ms: int | None
    created_at: datetime
    updated_at: datetime
    expires_at: datetime

    @property
    def is_final(self) -> bool:
        """Tell whether the pipeline is over for this document."""
        return self.state in FINAL_VALUES


def stored_from(row: Row[Any]) -> StoredDocument:
    """Make a stored document from a row of the documents table."""
    values = row._asdict()
    return StoredDocument(**{field.name: values[field.name] for field in fields(StoredDocument)})


class DocumentRepository:
    """The documents table, as the service uses it."""

    def __init__(self, engine: Engine) -> None:
        """Read and write the documents on the schema `engine` is bound to."""
        self.engine = engine

    def create(self, new: NewDocument, now: datetime) -> StoredDocument:
        """Insert a document in state `uploaded`, expiring an hour after `now`."""
        values = {
            "id": new.id,
            "session_key": new.session_key,
            "state": DocumentState.UPLOADED.value,
            "label": new.label,
            "kind": new.kind,
            "byte_size": new.byte_size,
            "file_sha256": new.file_sha256,
            "admitted_on": new.admitted_on,
            "created_at": now,
            "updated_at": now,
            "expires_at": now + timedelta(seconds=limits.FILE_LIFETIME_SECONDS),
        }
        with self.engine.begin() as connection:
            row = connection.execute(insert(Document).values(**values).returning(Document)).one()
        return stored_from(row)

    def get(self, document_id: str, session_key: str, now: datetime) -> StoredDocument | None:
        """Return a visitor's own document, if it exists and has not expired."""
        with self.engine.connect() as connection:
            row = connection.execute(
                select(Document).where(
                    Document.id == document_id, Document.session_key == session_key, Document.expires_at > now
                )
            ).one_or_none()
        return stored_from(row) if row is not None else None

    def get_for_pipeline(self, document_id: str) -> StoredDocument | None:
        """Return a document by id alone, for the pipeline working on it (the visitor's own routes never use this)."""
        with self.engine.connect() as connection:
            row = connection.execute(select(Document).where(Document.id == document_id)).one_or_none()
        return stored_from(row) if row is not None else None

    def list_for(self, session_key: str, now: datetime) -> list[StoredDocument]:
        """Return a visitor's unexpired documents, newest first."""
        with self.engine.connect() as connection:
            rows = connection.execute(
                select(Document)
                .where(Document.session_key == session_key, Document.expires_at > now)
                .order_by(Document.created_at.desc())
            ).all()
        return [stored_from(row) for row in rows]

    def advance(self, document_id: str, state: DocumentState, steps: Sequence[dict[str, Any]], now: datetime) -> bool:
        """Move a document that is still being read to its next state, noting the steps it finished; False if over."""
        with self.engine.begin() as connection:
            current = connection.execute(
                select(Document.state, Document.steps).where(Document.id == document_id).with_for_update()
            ).one_or_none()
            if current is None or current.state in FINAL_VALUES:
                return False
            connection.execute(
                update(Document)
                .where(Document.id == document_id)
                .values(state=state.value, updated_at=now, steps=[*current.steps, *steps])
            )
        return True

    def touch(self, document_ids: Sequence[str], now: datetime) -> None:
        """Note that the pipeline is still working on these documents, so they are not mistaken for lost ones."""
        if not document_ids:
            return
        with self.engine.begin() as connection:
            connection.execute(
                update(Document)
                .where(Document.id.in_(list(document_ids)), Document.state.in_(ACTIVE_VALUES))
                .values(updated_at=now)
            )

    def finish_ready(self, document_id: str, reading: FinishedReading, now: datetime) -> bool:
        """Save a finished reading and mark the document `ready`; False if the document had already ended."""
        values: dict[str, Any] = {
            "state": DocumentState.READY.value,
            "failure_code": None,
            "updated_at": now,
            "page_count": reading.page_count,
            "extraction": invoice_json(reading.invoice),
            "placements": placements_json(reading.placements),
            "checks": checks_json(reading.checks),
            "journal": journal_json(reading.journal),
            "identity_vendor": reading.identity.vendor if reading.identity else None,
            "identity_number": reading.identity.number if reading.identity else None,
            "content_hash": reading.identity.content if reading.identity else None,
            "duplicate_of": reading.duplicate_of,
            "duplicate_same_content": reading.duplicate_same_content,
            "text_cut": reading.text_cut,
            "model": reading.model[:80],
            "model_calls": reading.model_calls,
            "run_id": reading.run_id,
            "ocr_ms": reading.ocr_ms,
            "elapsed_ms": reading.elapsed_ms,
            "steps": reading.steps,
        }
        return self.end(document_id, values)

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
        values: dict[str, Any] = {
            "state": DocumentState.FAILED.value,
            "failure_code": code.value,
            "updated_at": now,
            "model_calls": model_calls,
            "run_id": run_id,
            "steps": steps,
        }
        return self.end(document_id, values)

    def end(self, document_id: str, values: dict[str, Any]) -> bool:
        """Write the values that end a document, if it has not ended: one update that checks the state itself."""
        with self.engine.begin() as connection:
            changed = connection.execute(
                update(Document).where(Document.id == document_id, Document.state.not_in(FINAL_VALUES)).values(**values)
            ).rowcount
        return bool(changed)

    def save_edit(
        self,
        document_id: str,
        session_key: str,
        edited: EditedReading,
        correction: dict[str, Any],
        corrections_seen: int,
        now: datetime,
    ) -> SaveOutcome:
        """Save a visitor's correction of a field: the new reading, all that follows from it, and a note of the change.

        Only a `ready` document of this visitor, within its hour, can be edited (`missing` otherwise). The reading
        the correction was made on had `corrections_seen` corrections; if another one was saved since, this one was
        worked out from an older reading and is not saved (`conflict`), so no correction is ever lost to a race.
        """
        with self.engine.begin() as connection:
            current = connection.execute(
                select(Document.corrections)
                .where(
                    Document.id == document_id,
                    Document.session_key == session_key,
                    Document.state == DocumentState.READY.value,
                    Document.expires_at > now,
                )
                .with_for_update()
            ).one_or_none()
            if current is None:
                return "missing"
            if len(current.corrections) != corrections_seen:
                return "conflict"
            connection.execute(
                update(Document)
                .where(Document.id == document_id)
                .values(
                    extraction=invoice_json(edited.invoice),
                    placements=placements_json(edited.placements),
                    checks=checks_json(edited.checks),
                    journal=journal_json(edited.journal),
                    identity_vendor=edited.identity.vendor if edited.identity else None,
                    identity_number=edited.identity.number if edited.identity else None,
                    content_hash=edited.identity.content if edited.identity else None,
                    duplicate_of=edited.duplicate_of,
                    duplicate_same_content=edited.duplicate_same_content,
                    corrections=[*current.corrections, correction],
                    updated_at=now,
                )
            )
        return "saved"

    def queued_ahead(self, document: StoredDocument) -> int:
        """Count the documents of anyone that were uploaded before this one and are still waiting to be read."""
        with self.engine.connect() as connection:
            return connection.execute(
                select(func.count())
                .select_from(Document)
                .where(
                    Document.state == DocumentState.UPLOADED.value,
                    Document.created_at < document.created_at,
                    Document.expires_at > document.created_at,
                )
            ).scalar_one()

    def known_identities(self, session_key: str, now: datetime, exclude: str) -> list[Known]:
        """Return the identities of a visitor's other finished documents of the hour, oldest first."""
        with self.engine.connect() as connection:
            rows = connection.execute(
                select(Document.id, Document.identity_vendor, Document.identity_number, Document.content_hash)
                .where(
                    Document.session_key == session_key,
                    Document.id != exclude,
                    Document.state == DocumentState.READY.value,
                    Document.expires_at > now,
                    Document.identity_vendor.is_not(None),
                )
                .order_by(Document.created_at)
            ).all()
        known: list[Known] = []
        for row in rows:
            if row.identity_number is None or row.content_hash is None:
                continue
            known.append(
                Known("document", row.id, Identity(row.identity_vendor, row.identity_number, row.content_hash))
            )
        return known

    def delete(self, document_id: str, session_key: str) -> bool:
        """Delete a visitor's own document; False if there is none."""
        with self.engine.begin() as connection:
            removed = connection.execute(
                delete(Document).where(Document.id == document_id, Document.session_key == session_key)
            ).rowcount
        return bool(removed)

    def expired(self, now: datetime, limit: int) -> list[StoredDocument]:
        """Return up to `limit` documents whose hour is over, oldest first."""
        with self.engine.connect() as connection:
            rows = connection.execute(
                select(Document).where(Document.expires_at <= now).order_by(Document.expires_at).limit(limit)
            ).all()
        return [stored_from(row) for row in rows]

    def purge(self, document_ids: Sequence[str]) -> int:
        """Delete documents by id, whoever's they are: for the sweep that removes the expired."""
        if not document_ids:
            return 0
        with self.engine.begin() as connection:
            return connection.execute(delete(Document).where(Document.id.in_(list(document_ids)))).rowcount

    def stale(self, before: datetime, limit: int) -> list[StoredDocument]:
        """Return up to `limit` documents still in the pipeline that have not been touched since `before`."""
        with self.engine.connect() as connection:
            rows = connection.execute(
                select(Document)
                .where(Document.state.in_(ACTIVE_VALUES), Document.updated_at < before, Document.expires_at > before)
                .order_by(Document.updated_at)
                .limit(limit)
            ).all()
        return [stored_from(row) for row in rows]
