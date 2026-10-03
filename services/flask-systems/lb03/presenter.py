"""What the API says about a document: the models of its answers, and the functions that make them from a stored row.

A stored document is JSON columns as the pipeline saved them. The API turns that into one flat, typed shape the
board can draw without interpreting anything: the fields as a table (each with its value as text, its box and how sure
the service is, whether the visitor corrected it, and the failed checks that name it), the checks, the duplicate that
was found, the journal entry, and the steps the run took. Every amount is a decimal string, never a float.

Words for people are kept to a minimum on purpose. The board writes its own sentences in the visitor's language from
the codes (a check's id, a failure code, a state); the English `message` beside a code is for someone reading the API.
"""

from datetime import datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel

from lb03 import limits
from lb03.checks import CheckId, Severity
from lb03.invoice import ExtractedInvoice, field_paths, get_field
from lb03.repository import StoredDocument, checks_from_json, invoice_from_json
from lb03.states import DocumentState, FailureCode

# The confidence bands the board draws: a share of certainty from 0 to 1, cut at these two points.
HIGH_CONFIDENCE = 0.9
MEDIUM_CONFIDENCE = 0.75

type Band = Literal["high", "medium", "low"]
type FieldKind = Literal["choice", "text", "date", "currency", "amount", "quantity", "rate"]
type JournalStatus = Literal["made", "blocked_by_checks", "does_not_balance"]

# What each failure code means, for someone reading the API. The board has its own words in each language.
FAILURE_MESSAGES: dict[FailureCode, str] = {
    FailureCode.UNSUPPORTED_FILE: "The file is not a PDF, PNG, JPEG or WebP.",
    FailureCode.TOO_LARGE: "The file is larger than 10 MB.",
    FailureCode.TOO_MANY_PAGES: "The file has more than 5 pages.",
    FailureCode.IMAGE_TOO_BIG: "The image or a page of it has more pixels than the reader accepts.",
    FailureCode.UNREADABLE_FILE: "The file could not be decoded.",
    FailureCode.UNSAFE_FILE: "The file carries active content or reaches outside itself, which the reader refuses.",
    FailureCode.NO_TEXT: "No words could be read from the pages.",
    FailureCode.OCR_FAILED: "The reader stopped before it finished.",
    FailureCode.INJECTION_SUSPECTED: "The injection check flagged the text, so no model was shown it.",
    FailureCode.UNCHECKED: "The injection check could not run, so no model was shown the text.",
    FailureCode.MODEL_FAILED: "The language models are not answering right now.",
    FailureCode.MODEL_BUDGET: "Today's free model capacity is used up.",
    FailureCode.MODEL_OUTPUT: "The model's reply could not be read.",
    FailureCode.TIME_LIMIT: "The document took longer than the time it is given.",
    FailureCode.CALL_LIMIT: "The document needed more model calls than it is given.",
    FailureCode.INTERRUPTED: "The process that was reading the document stopped before it finished.",
}


class StepOut(BaseModel):
    """One step of a document's run: what it was, how it ended, how long it took, and a few counts about it."""

    name: str
    status: Literal["ok", "error", "skipped"]
    ms: int
    detail: dict[str, str | int | float | bool]


class BoxOut(BaseModel):
    """Where a field is printed: its page (from 1), the four corners of the words, and how sure the service is.

    Corners are `x, y` as a share of the page's width and height, clockwise from the top left. `confidence` is the
    words' own certainty times how well they match the value, and `band` is that number in a word, so the board
    never says it with colour alone.
    """

    page: int
    quad: list[float]
    confidence: float
    match: float
    band: Band


class FieldOut(BaseModel):
    """One field of the invoice: its value as text, its box when it was found on the page, and what the checks say."""

    path: str
    kind: FieldKind
    value: str | None
    box: BoxOut | None
    edited: bool
    checks: list[CheckId]


class CheckOut(BaseModel):
    """One check's verdict, with the numbers that disagree and the fields it is about."""

    id: CheckId
    status: Literal["passed", "failed", "skipped"]
    severity: Severity
    message: str
    fields: list[str]
    expected: str | None
    actual: str | None


class DuplicateOut(BaseModel):
    """The document this one repeats: one of the visitor's own, or one of the samples, with the same content or not."""

    of: str
    source: Literal["document", "sample"]
    same_content: bool


class JournalLineOut(BaseModel):
    """One line of a journal entry: an account, and an amount on one side."""

    account: str
    name: str
    debit: str
    credit: str
    memo: str


class JournalOut(BaseModel):
    """A balanced journal entry as the board shows it: amounts as decimal strings, with the two totals."""

    date: str
    reference: str
    currency: str
    lines: list[JournalLineOut]
    total_debit: str
    total_credit: str


class CorrectionOut(BaseModel):
    """One correction a visitor made: which field, what it was and what it became."""

    path: str
    was: str | None
    now: str | None
    at: datetime


class FailureOut(BaseModel):
    """Why a document has no result: the code the board has words for, and a sentence for someone reading the API."""

    code: FailureCode
    message: str


class DocumentOut(BaseModel):
    """A document as the API shows it: where it is, and once it is read, everything that was made of it."""

    id: str
    state: DocumentState
    failure: FailureOut | None
    label: str
    kind: str
    byte_size: int
    # Set once the pages have been read and drawn, also for a document that failed afterwards: it can still show them.
    pages: int | None
    created_at: datetime
    updated_at: datetime
    expires_at: datetime
    queued_ahead: int | None
    text_cut: bool
    model: str | None
    model_calls: int
    run_id: str | None
    ocr_ms: int | None
    elapsed_ms: int | None
    steps: list[StepOut]
    prices_include_vat: bool | None
    fields: list[FieldOut] | None
    checks: list[CheckOut] | None
    duplicate: DuplicateOut | None
    journal: JournalOut | None
    journal_status: JournalStatus | None
    corrections: list[CorrectionOut]
    can_export: bool


class DocumentSummaryOut(BaseModel):
    """A document in a list: enough to find it again and see how it stands."""

    id: str
    state: DocumentState
    failure: FailureOut | None
    label: str
    kind: str
    byte_size: int
    pages: int | None
    created_at: datetime
    expires_at: datetime
    checks_failed: int | None
    can_export: bool


class DocumentListOut(BaseModel):
    """The visitor's documents of the hour, newest first."""

    documents: list[DocumentSummaryOut]


class DocumentLimitsOut(BaseModel):
    """The limits LB-03 enforces, which are the ones its datasheet promises.

    The models of every system of the monolith share one OpenAPI document and are named in it by class name, and a
    second class of the same name would silently replace the first: LB-05 has a `LimitsOut` and a `QuotaOut` too, so
    these two are named for what they limit.
    """

    documents_per_day: int
    concurrent_documents: int
    max_upload_bytes: int
    max_pages: int
    file_lifetime_seconds: int
    max_model_calls_per_document: int
    document_deadline_seconds: float


class DocumentQuotaOut(BaseModel):
    """A visitor's documents today, the limits, and whether the service can read documents at all right now."""

    used: int
    remaining: int
    active: int
    resets_at: datetime
    can_read: bool
    limits: DocumentLimitsOut


def band_of(confidence: float) -> Band:
    """Say a confidence in a word: high from 0.9, medium from 0.75, low below."""
    if confidence >= HIGH_CONFIDENCE:
        return "high"
    if confidence >= MEDIUM_CONFIDENCE:
        return "medium"
    return "low"


def kind_of(path: str) -> FieldKind:
    """Say what kind of value a field holds, so the board can offer the right way to correct it."""
    name = path.rsplit(".", 1)[-1]
    kinds: dict[str, FieldKind] = {
        "document_type": "choice",
        "vendor": "text",
        "invoice_number": "text",
        "description": "text",
        "issue_date": "date",
        "due_date": "date",
        "currency": "currency",
        "quantity": "quantity",
        "rate": "rate",
    }
    return kinds.get(name, "amount")


def limits_out() -> DocumentLimitsOut:
    """Return the limits the service enforces: the datasheet's, from the constants the code enforces them with."""
    return DocumentLimitsOut(
        documents_per_day=limits.DOCUMENTS_PER_DAY,
        concurrent_documents=limits.MAX_ACTIVE_PER_VISITOR,
        max_upload_bytes=limits.MAX_UPLOAD_BYTES,
        max_pages=limits.MAX_PAGES,
        file_lifetime_seconds=limits.FILE_LIFETIME_SECONDS,
        max_model_calls_per_document=limits.MAX_MODEL_CALLS,
        document_deadline_seconds=limits.DOCUMENT_DEADLINE_SECONDS,
    )


def failure_out(code: str | None) -> FailureOut | None:
    """Describe a document's failure code for the API; None when it has not failed."""
    if code is None:
        return None
    failure = FailureCode(code)
    return FailureOut(code=failure, message=FAILURE_MESSAGES[failure])


def steps_out(stored: StoredDocument) -> list[StepOut]:
    """Describe the steps a document's run recorded, in order."""
    return [
        StepOut(name=step["name"], status=step["status"], ms=step["ms"], detail=step.get("detail", {}))
        for step in stored.steps
    ]


class StoredPlacement(BaseModel):
    """A placement as the pipeline saved it in the placements column, read back with its types checked."""

    page: int
    quad: list[float]
    confidence: float
    match: float


def box_out(placement: dict[str, Any] | None) -> BoxOut | None:
    """Describe a field's stored placement, or return None for a field that was not found on the page."""
    if placement is None:
        return None
    stored = StoredPlacement.model_validate(placement)
    return BoxOut(
        page=stored.page,
        quad=stored.quad,
        confidence=round(stored.confidence, 4),
        match=round(stored.match, 4),
        band=band_of(stored.confidence),
    )


def fields_out(
    stored: StoredDocument, invoice: ExtractedInvoice, failed_checks: dict[str, set[CheckId]]
) -> list[FieldOut]:
    """Make the fields table: each field in reading order, with its box, whether it was corrected, and its checks."""
    placements = stored.placements or {}
    edited = {correction["path"] for correction in stored.corrections}
    return [
        FieldOut(
            path=path,
            kind=kind_of(path),
            value=get_field(invoice, path),
            box=box_out(placements.get(path)),
            edited=path in edited,
            checks=sorted(failed_checks.get(path, set())),
        )
        for path in field_paths(invoice)
    ]


def checks_out(stored: StoredDocument) -> list[CheckOut]:
    """Make the checks as the API shows them."""
    return [
        CheckOut(
            id=result.id,
            status=result.status,
            severity=result.severity,
            message=result.message,
            fields=list(result.fields),
            expected=result.expected,
            actual=result.actual,
        )
        for result in checks_from_json(stored.checks or [])
    ]


def failed_by_path(checks: list[CheckOut]) -> dict[str, set[CheckId]]:
    """Collect, for each field path, the checks that failed and name it."""
    found: dict[str, set[CheckId]] = {}
    for check in checks:
        if check.status == "failed":
            for path in check.fields:
                found.setdefault(path, set()).add(check.id)
    return found


def blocks_export_out(checks: list[CheckOut]) -> bool:
    """Tell whether any failed check is an error: such a document is not exported."""
    return any(check.status == "failed" and check.severity is Severity.ERROR for check in checks)


def journal_out(stored: StoredDocument) -> JournalOut | None:
    """Describe a stored journal entry, with the totals of its two sides."""
    entry = stored.journal
    if entry is None:
        return None
    lines = [JournalLineOut(**line) for line in entry["lines"]]
    zero = Decimal(0)
    return JournalOut(
        date=entry["date"],
        reference=entry["reference"],
        currency=entry["currency"],
        lines=lines,
        total_debit=f"{sum((Decimal(line.debit) for line in lines), zero):.2f}",
        total_credit=f"{sum((Decimal(line.credit) for line in lines), zero):.2f}",
    )


def duplicate_out(stored: StoredDocument) -> DuplicateOut | None:
    """Describe the document this one repeats, from the reference saved with it (`document:<id>` or `sample:<id>`)."""
    if stored.duplicate_of is None:
        return None
    source, _, reference = stored.duplicate_of.partition(":")
    return DuplicateOut(
        of=reference,
        source="sample" if source == "sample" else "document",
        same_content=bool(stored.duplicate_same_content),
    )


def journal_status_of(stored: StoredDocument, checks: list[CheckOut]) -> JournalStatus | None:
    """Say why there is a journal entry or not: made, held back by a failing check, or unable to balance."""
    if stored.state != DocumentState.READY.value:
        return None
    if stored.journal is not None:
        return "made"
    return "blocked_by_checks" if blocks_export_out(checks) else "does_not_balance"


def document_out(stored: StoredDocument, queued_ahead: int | None = None) -> DocumentOut:
    """Make the API's view of a stored document: its state, and when it is ready everything that was made of it."""
    ready = stored.state == DocumentState.READY.value and stored.extraction is not None
    checks = checks_out(stored) if ready else None
    invoice = invoice_from_json(stored.extraction) if ready and stored.extraction is not None else None
    return DocumentOut(
        id=stored.id,
        state=DocumentState(stored.state),
        failure=failure_out(stored.failure_code),
        label=stored.label,
        kind=stored.kind,
        byte_size=stored.byte_size,
        pages=stored.page_count,
        created_at=stored.created_at,
        updated_at=stored.updated_at,
        expires_at=stored.expires_at,
        queued_ahead=queued_ahead,
        text_cut=stored.text_cut,
        model=stored.model,
        model_calls=stored.model_calls,
        run_id=stored.run_id,
        ocr_ms=stored.ocr_ms,
        elapsed_ms=stored.elapsed_ms,
        steps=steps_out(stored),
        prices_include_vat=invoice.prices_include_vat if invoice is not None else None,
        fields=fields_out(stored, invoice, failed_by_path(checks or [])) if invoice is not None else None,
        checks=checks,
        duplicate=duplicate_out(stored) if ready else None,
        journal=journal_out(stored) if ready else None,
        journal_status=journal_status_of(stored, checks or []) if ready else None,
        corrections=[
            CorrectionOut(path=item["path"], was=item.get("was"), now=item.get("now"), at=item["at"])
            for item in stored.corrections
        ],
        can_export=ready and not blocks_export_out(checks or []),
    )


def summary_out(stored: StoredDocument) -> DocumentSummaryOut:
    """Make a document's line in the list."""
    ready = stored.state == DocumentState.READY.value and stored.extraction is not None
    checks = checks_out(stored) if ready else None
    failed = sum(1 for check in checks or [] if check.status == "failed")
    return DocumentSummaryOut(
        id=stored.id,
        state=DocumentState(stored.state),
        failure=failure_out(stored.failure_code),
        label=stored.label,
        kind=stored.kind,
        byte_size=stored.byte_size,
        pages=stored.page_count,
        created_at=stored.created_at,
        expires_at=stored.expires_at,
        checks_failed=failed if checks is not None else None,
        can_export=ready and not blocks_export_out(checks or []),
    )
