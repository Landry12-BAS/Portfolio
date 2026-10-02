"""Tests for LB-03's golden set: its strict reader, and that every document's printed truth is what it claims to be.

The golden set is data, written before any prompt (docs/PLAYBOOK.md, step 3) and read strictly. These tests prove
the data is sound with no model and no OCR: a document marked valid passes every check, a planted error trips
exactly the check it names and no other, a hostile document's truth is consistent, and the duplicates repeat what
they say they repeat.
"""

import copy
from collections import Counter
from decimal import Decimal
from typing import Any

import pytest
import yaml
from pydantic import ValidationError

from core.data_files import DataFileError
from lb03.checks import CheckId, run_checks
from lb03.golden import (
    EVALS_DIRECTORY,
    GoldenCase,
    GoldenSet,
    printed_as_reply,
    read_golden_set,
)
from lb03.invoice import ExtractedInvoice
from lb03.money import amount_text

SAMPLES = {"clean-pdf", "crumpled-photo", "handwritten-receipt", "euro-vat", "prompt-injection", "planted-total"}


@pytest.fixture(scope="module")
def golden() -> GoldenSet:
    """Read the real golden set once."""
    return read_golden_set()


@pytest.fixture(scope="module")
def raw() -> dict[str, Any]:
    """Read the golden set's YAML as plain data, for the tests that bend it."""
    loaded = yaml.safe_load((EVALS_DIRECTORY / "golden.yaml").read_text(encoding="utf-8"))
    assert isinstance(loaded, dict)
    return loaded


def extraction(case: GoldenCase) -> ExtractedInvoice:
    """Read a case's printed truth the way the pipeline reads a perfect model's answer."""
    assert case.printed is not None
    return ExtractedInvoice.model_validate(printed_as_reply(case.printed))


def failing_checks(golden: GoldenSet, case: GoldenCase) -> list[CheckId]:
    """Run the deterministic checks on a case's printed truth, on the golden set's day, and name those that fail."""
    return [result.id for result in run_checks(extraction(case), golden.today) if result.failed]


def test_the_golden_set_reads_and_is_the_size_the_datasheet_needs(golden: GoldenSet) -> None:
    """About forty documents, in every kind the task asks for, and the six curated samples."""
    kinds = Counter(case.kind for case in golden.cases)
    assert 40 <= len(golden.cases) <= 50
    assert set(kinds) == {
        "clean_pdf",
        "multi_page_pdf",
        "photo",
        "handwritten",
        "euro_vat",
        "credit_note",
        "duplicate",
        "hostile",
        "planted_error",
        "over_limit",
        "unreadable",
    }
    assert {case.sample for case in golden.samples()} == SAMPLES
    assert kinds["handwritten"] >= 3
    assert kinds["hostile"] >= 3
    assert kinds["planted_error"] >= 5


def test_every_valid_document_passes_every_check(golden: GoldenSet) -> None:
    """The printed truth of a document that is meant to be fine adds up, exactly as the checks count."""
    for case in golden.cases:
        if case.expect.outcome in {"valid", "held"}:
            assert failing_checks(golden, case) == [], case.id


def test_every_planted_error_trips_exactly_the_check_it_names(golden: GoldenSet) -> None:
    """The validators catch each planted arithmetic error, and the others stay quiet."""
    planted = [case for case in golden.cases if case.expect.outcome == "needs_review"]
    assert len(planted) >= 5
    for case in planted:
        assert failing_checks(golden, case) == case.expect.failing_checks, case.id


def test_the_planted_errors_are_well_outside_the_one_cent_rule(golden: GoldenSet) -> None:
    """A planted error is at least ten cents out, so rounding can never be what the check is catching."""
    case = golden.case("planted-total-hanse-2026-4700")
    result = next(r for r in run_checks(extraction(case), golden.today) if r.id is CheckId.TOTAL_RECONCILES)
    assert result.expected is not None
    assert result.actual is not None
    assert abs(Decimal(result.actual) - Decimal(result.expected)) >= Decimal("0.10")


def test_every_failed_expectation_names_its_code_and_the_documents_that_cannot_be_read_have_no_truth(
    golden: GoldenSet,
) -> None:
    """The page-limit and blank-page documents end in a failure code; the blank page prints nothing."""
    failed = [case for case in golden.cases if case.expect.outcome == "failed"]
    assert {case.expect.failure for case in failed} == {"too_many_pages", "no_text"}
    assert golden.case("blank-page").printed is None


def test_a_hostile_document_says_what_must_not_happen_to_it(golden: GoldenSet) -> None:
    """The hostile documents ask for a total of zero, and the golden set says that total must not appear."""
    hostile = [case for case in golden.cases if case.kind == "hostile"]
    ordering = [case for case in hostile if case.render.notice]
    assert len(ordering) >= 3
    for case in ordering:
        assert case.expect.outcome == "held"
        assert case.expect.must_not_become == {"total": "0.00"}
        assert case.expect.guard_flags
        assert case.printed is not None
        assert case.printed.total != 0


def test_the_markup_document_carries_what_a_spreadsheet_would_run(golden: GoldenSet) -> None:
    """Its descriptions start with each of the four characters that make a spreadsheet read a cell as a formula."""
    case = golden.case("hostile-markup-fast-roast")
    assert case.printed is not None
    assert {line.description[0] for line in case.printed.line_items} == {"=", "@", "+", "-"}
    assert "<b>" in case.printed.vendor


def test_duplicates_repeat_the_document_they_name(golden: GoldenSet) -> None:
    """Both duplicates print the original's vendor and number, and one is a byte copy of its file."""
    original = golden.case("bohemia-packaging-2026-0412")
    for case in (golden.case("dup-bohemia-0412-copy"), golden.case("dup-bohemia-0412-reissue")):
        assert case.expect.duplicate_of == original.id
        assert case.printed is not None
        assert original.printed is not None
        assert (case.printed.vendor, case.printed.invoice_number) == (
            original.printed.vendor,
            original.printed.invoice_number,
        )
    assert golden.case("dup-bohemia-0412-copy").render.copy_of == original.id
    assert golden.case("dup-bohemia-0412-reissue").render.stamp == "COPY"


def test_apart_from_the_duplicates_no_two_documents_share_a_vendor_and_number(golden: GoldenSet) -> None:
    """The duplicate check can then be judged on the documents that are meant to be duplicates alone."""
    keys = Counter(
        (case.printed.vendor, case.printed.invoice_number)
        for case in golden.cases
        if case.printed is not None and case.expect.duplicate_of is None
    )
    assert [key for key, count in keys.items() if count > 1] == []


def test_the_document_types_cover_invoices_credit_notes_and_receipts(golden: GoldenSet) -> None:
    """Receipts have no due date and gross prices; credit notes appear with both kinds of sign."""
    kinds = {case.printed.document_type for case in golden.cases if case.printed is not None}
    assert kinds == {"invoice", "credit_note", "receipt"}
    receipts = [
        case.printed for case in golden.cases if case.printed is not None and case.printed.document_type == "receipt"
    ]
    assert all(printed.prices_include_vat and printed.due_date is None for printed in receipts)
    credit_notes = [
        case.printed
        for case in golden.cases
        if case.printed is not None and case.printed.document_type == "credit_note"
    ]
    assert {printed.total < 0 for printed in credit_notes} == {True, False}


def test_there_are_euro_invoices_with_several_vat_rates(golden: GoldenSet) -> None:
    """The euro sample has three rates, and others have two."""
    assert golden.case("hanse-green-2026-4417").sample == "euro-vat"
    printed = golden.case("hanse-green-2026-4417").printed
    assert printed is not None
    assert [vat.rate for vat in printed.vat] == [Decimal(0), Decimal(7), Decimal(19)]
    assert printed.currency == "EUR"


def test_the_perfect_answer_round_trips_through_the_schema(golden: GoldenSet) -> None:
    """What a perfect model would say is read by the schema into the printed numbers, to the cent."""
    for case in golden.cases:
        if case.printed is None:
            continue
        invoice = extraction(case)
        assert invoice.total == case.printed.total, case.id
        assert [amount_text(line.total or Decimal(0)) for line in invoice.line_items] == [
            amount_text(line.total) for line in case.printed.line_items
        ]


def test_an_unknown_field_is_an_error(raw: dict[str, Any]) -> None:
    """The reader is strict: a stray key is refused, not dropped."""
    bent = copy.deepcopy(raw)
    bent["cases"][0]["mood"] = "cheerful"
    with pytest.raises(ValidationError):
        GoldenSet.model_validate(bent)


def test_an_unquoted_amount_is_refused(raw: dict[str, Any]) -> None:
    """YAML would make 7400.00 a float, and money is never a float."""
    bent = copy.deepcopy(raw)
    bent["cases"][0]["printed"]["total"] = 10406.0
    with pytest.raises(ValidationError, match="quoted"):
        GoldenSet.model_validate(bent)


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda cases: cases[1].update({"id": cases[0]["id"]}), "more than once"),
        (lambda cases: cases[1].update({"file": cases[0]["file"]}), "file appears more than once"),
        (lambda cases: cases[1].update({"sample": cases[0]["sample"]}), "sample appears more than once"),
        (lambda cases: cases[0]["expect"].update({"outcome": "needs_review"}), "failing checks"),
        (lambda cases: cases[0]["expect"].update({"duplicate_of": "no-such-case"}), "not another case"),
        (lambda cases: cases[0]["expect"].update({"outcome": "failed"}), "failure code"),
        (lambda cases: cases[0].update({"printed": None}), "printed truth"),
        (lambda cases: cases[0]["render"].update({"medium": "photo"}), "photo effects"),
    ],
)
def test_a_golden_set_that_contradicts_itself_is_refused(raw: dict[str, Any], change: Any, message: str) -> None:
    """A repeat, a planted error with no check, a failure with no code, a dangling reference: each is refused."""
    bent = copy.deepcopy(raw)
    change(bent["cases"])
    with pytest.raises(ValidationError, match=message):
        GoldenSet.model_validate(bent)


def test_a_missing_file_is_a_data_file_error(tmp_path: Any) -> None:
    """Reading a folder with no golden set names the file."""
    with pytest.raises(DataFileError, match=r"golden\.yaml"):
        read_golden_set(tmp_path)
