"""What the API says about a document: the fields table, the checks, the confidence bands and the failure words."""

from datetime import UTC, date, datetime
from decimal import Decimal

import pytest

from lb03.accounts import post, read_chart
from lb03.boxes import Placement, check_fields_on_page, place_fields
from lb03.checks import CheckId, run_checks
from lb03.duplicates import duplicate_result, identity_of
from lb03.golden import SEED_DIRECTORY, printed_as_reply, read_golden_set
from lb03.invoice import ExtractedInvoice, field_paths
from lb03.presenter import (
    FAILURE_MESSAGES,
    HIGH_CONFIDENCE,
    MEDIUM_CONFIDENCE,
    band_of,
    document_out,
    kind_of,
    summary_out,
)
from lb03.repository import (
    StoredDocument,
    checks_json,
    invoice_json,
    journal_json,
    placements_json,
)
from lb03.service import MAX_LABEL_CHARS, clean_label
from lb03.states import FailureCode
from tests.lb03_support import invoice_page

NOW = datetime(2026, 10, 1, 9, 30, tzinfo=UTC)
GOLDEN = read_golden_set()
INVOICE = ExtractedInvoice.from_reply(printed_as_reply(GOLDEN.case("bohemia-packaging-2026-0412").printed))  # type: ignore[arg-type]


def stored_document(**changes: object) -> StoredDocument:
    """Make a stored document of a read invoice with its boxes, checks and journal entry, as a test changes it."""
    placements = place_fields(INVOICE, [invoice_page(INVOICE)])
    results = [*run_checks(INVOICE, date(2026, 10, 1)), check_fields_on_page(INVOICE, set(placements))]
    results.append(duplicate_result(identity_of(INVOICE), None))
    values: dict[str, object] = {
        "id": "A" * 22,
        "session_key": "session-of-sam-visitor-0001",
        "state": "ready",
        "failure_code": None,
        "label": "invoice.pdf",
        "kind": "pdf",
        "byte_size": 1000,
        "file_sha256": "0" * 64,
        "page_count": 1,
        "admitted_on": date(2026, 10, 1),
        "extraction": invoice_json(INVOICE),
        "placements": placements_json(placements),
        "checks": checks_json(results),
        "journal": journal_json(post(INVOICE, read_chart(SEED_DIRECTORY))),
        "steps": [{"name": "ocr", "status": "ok", "ms": 900, "detail": {"pages": 1}}],
        "corrections": [],
        "identity_vendor": None,
        "identity_number": None,
        "content_hash": None,
        "duplicate_of": None,
        "duplicate_same_content": None,
        "text_cut": False,
        "model": "test/lb-fast",
        "model_calls": 2,
        "run_id": "run-0001-aaaaaaaa",
        "ocr_ms": 900,
        "elapsed_ms": 4000,
        "created_at": NOW,
        "updated_at": NOW,
        "expires_at": NOW,
    }
    values.update(changes)
    return StoredDocument(**values)  # type: ignore[arg-type]


def test_every_failure_code_has_a_sentence_for_someone_reading_the_api() -> None:
    """A new code can't be added without saying what it means."""
    assert set(FAILURE_MESSAGES) == set(FailureCode)
    assert all(sentence.endswith(".") for sentence in FAILURE_MESSAGES.values())


@pytest.mark.parametrize(
    ("confidence", "band"),
    [
        (1.0, "high"),
        (HIGH_CONFIDENCE, "high"),
        (0.89, "medium"),
        (MEDIUM_CONFIDENCE, "medium"),
        (0.74, "low"),
        (0.0, "low"),
    ],
)
def test_a_confidence_is_said_in_a_word_so_the_board_never_uses_colour_alone(confidence: float, band: str) -> None:
    """Cut at 0.9 and 0.75."""
    assert band_of(confidence) == band


def test_each_field_says_what_kind_of_value_it_holds() -> None:
    """The board offers the right control for each: a date picker, a number field, a list of kinds."""
    kinds = {path: kind_of(path) for path in field_paths(INVOICE)}

    assert kinds["document_type"] == "choice"
    assert kinds["vendor"] == "text"
    assert kinds["issue_date"] == "date"
    assert kinds["currency"] == "currency"
    assert kinds["line_items.0.quantity"] == "quantity"
    assert kinds["line_items.0.unit_price"] == "amount"
    assert kinds["vat.0.rate"] == "rate"
    assert kinds["total"] == "amount"


def test_a_ready_document_is_a_fields_table_with_boxes_checks_and_a_balanced_journal_entry() -> None:
    """Everything the board draws, in one typed shape."""
    document = document_out(stored_document())

    assert document.state == "ready"
    assert document.failure is None
    assert [field.path for field in document.fields or []] == field_paths(INVOICE)
    total = next(field for field in document.fields or [] if field.path == "total")
    assert total.value == f"{INVOICE.total:.2f}"
    assert total.box is not None
    assert (total.box.page, len(total.box.quad), total.box.band) == (1, 8, "high")
    assert total.edited is False
    assert document.can_export is True
    assert document.journal is not None
    assert document.journal.total_debit == document.journal.total_credit
    assert document.journal_status == "made"
    assert document.duplicate is None


def test_a_field_a_failed_check_names_lists_that_check() -> None:
    """The check is on the fields it is about, so the board can mark them."""
    wrong = INVOICE.model_copy(update={"total": Decimal("1.00")})
    results = run_checks(wrong, date(2026, 10, 1))
    document = document_out(stored_document(extraction=invoice_json(wrong), checks=checks_json(results), journal=None))

    total = next(field for field in document.fields or [] if field.path == "total")
    assert CheckId.TOTAL_RECONCILES in total.checks
    assert document.can_export is False
    assert document.journal_status == "blocked_by_checks"


def test_a_field_with_no_box_is_a_value_not_found_on_the_page() -> None:
    """No placement, no box: the board says it was not found."""
    document = document_out(stored_document(placements={}))

    assert all(field.box is None for field in document.fields or [])


def test_a_corrected_field_is_marked_and_the_corrections_are_listed() -> None:
    """The board shows which values the visitor typed in, and what they replaced."""
    correction = {"path": "vendor", "was": "Old", "now": "New", "at": "2026-10-01T09:31:00+00:00"}
    document = document_out(stored_document(corrections=[correction]))

    vendor = next(field for field in document.fields or [] if field.path == "vendor")
    assert vendor.edited is True
    assert [(item.path, item.was, item.now) for item in document.corrections] == [("vendor", "Old", "New")]


def test_a_duplicate_names_what_it_repeats_and_whether_the_content_matches() -> None:
    """`document:<id>` and `sample:<id>` are told apart."""
    own = document_out(stored_document(duplicate_of="document:" + "B" * 22, duplicate_same_content=True))
    sample = document_out(stored_document(duplicate_of="sample:clean-pdf", duplicate_same_content=False))

    assert own.duplicate is not None
    assert (own.duplicate.source, own.duplicate.of, own.duplicate.same_content) == ("document", "B" * 22, True)
    assert sample.duplicate is not None
    assert (sample.duplicate.source, sample.duplicate.of, sample.duplicate.same_content) == (
        "sample",
        "clean-pdf",
        False,
    )


def test_a_document_still_being_read_has_no_fields_and_says_how_many_are_ahead() -> None:
    """The honest wait: its state, and the queue in front of it."""
    waiting = stored_document(
        state="uploaded", extraction=None, placements=None, checks=None, journal=None, page_count=None, steps=[]
    )

    document = document_out(waiting, queued_ahead=3)

    assert (document.state, document.queued_ahead, document.fields, document.checks) == ("uploaded", 3, None, None)
    assert document.can_export is False
    assert document.journal_status is None


def test_a_failed_document_carries_its_code_and_a_sentence() -> None:
    """No result, and why."""
    failed = stored_document(
        state="failed", failure_code="injection_suspected", extraction=None, placements=None, checks=None, journal=None
    )

    document = document_out(failed)

    assert document.failure is not None
    assert document.failure.code is FailureCode.INJECTION_SUSPECTED
    assert "injection" in document.failure.message
    assert document.fields is None


def test_the_summary_counts_the_failed_checks_and_says_whether_it_can_be_exported() -> None:
    """A line in the list."""
    wrong = INVOICE.model_copy(update={"total": Decimal("1.00")})
    results = run_checks(wrong, date(2026, 10, 1))

    clean = summary_out(stored_document())
    failing = summary_out(stored_document(extraction=invoice_json(wrong), checks=checks_json(results)))

    assert (clean.checks_failed, clean.can_export) == (0, True)
    assert failing.checks_failed is not None
    assert failing.checks_failed >= 1
    assert failing.can_export is False


def test_the_boxes_come_back_as_numbers_with_the_precision_the_board_needs() -> None:
    """The quad is eight numbers from 0 to about 1, and the confidence is rounded."""
    placement = Placement("total", 1, (0.1, 0.2, 0.3, 0.2, 0.3, 0.25, 0.1, 0.25), 0.912345678, 1.0)
    document = document_out(stored_document(placements=placements_json({"total": placement})))

    total = next(field for field in document.fields or [] if field.path == "total")
    assert total.box is not None
    assert total.box.confidence == 0.9123
    assert total.box.quad == [0.1, 0.2, 0.3, 0.2, 0.3, 0.25, 0.1, 0.25]


@pytest.mark.parametrize(
    ("name", "shown"),
    [
        ("invoice.pdf", "invoice.pdf"),
        ("../../etc/passwd", "passwd"),
        ("C:\\Users\\sam\\faktura 2026.pdf", "faktura 2026.pdf"),
        ("<script>alert(1)</script>.png", "script .png"),
        ("<img src=x onerror=alert(1)>.png", "img src x onerror alert(1) .png"),
        ("Účtenka č. 12 " + chr(0x2013) + " káva.jpg", "Účtenka č. 12 káva.jpg"),
        ("tab\tand\nnewline.pdf", "tab and newline.pdf"),
        ("", "document"),
        (None, "document"),
        ("///", "document"),
        ("x" * 300, "x" * MAX_LABEL_CHARS),
    ],
)
def test_a_file_name_is_shown_back_clean_and_never_used_as_a_path(name: str | None, shown: str) -> None:
    """No folders, no markup, no control characters, a limit to the length, and a fallback."""
    assert clean_label(name) == shown


def test_the_fields_are_those_the_invoice_has() -> None:
    """A document read from a one-line receipt has the fields of one, not a fixed list of them."""
    receipt = ExtractedInvoice.model_validate(
        {
            "document_type": "receipt",
            "vendor": "Cafe",
            "total": "4.00",
            "line_items": [{"description": "Coffee", "total": "4.00"}],
        }
    )
    stored = stored_document(
        extraction=invoice_json(receipt), placements={}, checks=checks_json(run_checks(receipt, date(2026, 10, 1)))
    )

    document = document_out(stored)

    assert [field.path for field in document.fields or []] == field_paths(receipt)
    assert not any(path.startswith("vat.") for path in [field.path for field in document.fields or []])
