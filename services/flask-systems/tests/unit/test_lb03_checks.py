"""Tests for LB-03's deterministic checks: the arithmetic is code's, and a failure is reported, never fixed."""

from datetime import date
from typing import Any

import pytest

from lb03.checks import (
    REPAIRABLE,
    CheckId,
    CheckResult,
    Severity,
    blocks_export,
    failures,
    repair_request,
    run_checks,
)
from lb03.invoice import ExtractedInvoice

TODAY = date(2026, 10, 1)
GOOD: dict[str, Any] = {
    "document_type": "invoice",
    "vendor": "Bohemia Packaging s.r.o.",
    "invoice_number": "2026-0412",
    "issue_date": "2026-09-14",
    "due_date": "2026-10-14",
    "currency": "CZK",
    "line_items": [
        {"description": "Kraft bag", "quantity": 4, "unit_price": "1850.00", "total": "7400.00"},
        {"description": "Labels", "quantity": 10, "unit_price": "120.00", "total": "1200.00"},
    ],
    "subtotal": "8600.00",
    "vat": [{"rate": 21, "base": "8600.00", "amount": "1806.00"}],
    "total": "10406.00",
}


def invoice(**changes: Any) -> ExtractedInvoice:
    """Build the good invoice with some fields replaced."""
    return ExtractedInvoice.model_validate({**GOOD, **changes})


def outcome(subject: ExtractedInvoice, check: CheckId) -> CheckResult:
    """Run every check on an invoice and return the one named."""
    return next(result for result in run_checks(subject, TODAY) if result.id is check)


def test_a_good_invoice_passes_every_check() -> None:
    """Nothing fails, nothing is skipped, and the export is not blocked."""
    results = run_checks(invoice(), TODAY)
    assert [result.id for result in results] == [
        CheckId.REQUIRED_FIELDS,
        CheckId.DATES_VALID,
        CheckId.CURRENCY_KNOWN,
        CheckId.SIGNS_AGREE,
        CheckId.LINE_MATH,
        CheckId.LINE_ITEMS_SUM,
        CheckId.VAT_MATH,
        CheckId.VAT_BASES,
        CheckId.TOTAL_RECONCILES,
    ]
    assert {result.status for result in results} == {"passed"}
    assert not blocks_export(results)


def test_missing_fields_are_named() -> None:
    """A receipt with no number fails required_fields and says which."""
    result = outcome(invoice(invoice_number=None, line_items=[]), CheckId.REQUIRED_FIELDS)
    assert result.failed
    assert result.fields == ("invoice_number", "line_items")


@pytest.mark.parametrize(
    ("changes", "failing"),
    [
        ({"issue_date": "2026-12-01"}, True),
        ({"issue_date": "2026-10-01"}, False),
        ({"issue_date": "1999-12-31"}, True),
        ({"due_date": "2026-09-01"}, True),
        ({"due_date": "2026-09-14"}, False),
        ({"due_date": None}, False),
    ],
)
def test_dates_must_not_be_in_the_future_or_backwards(changes: dict[str, Any], failing: bool) -> None:
    """An issue date after today, before 2000, or a due date before the issue date, fails."""
    assert outcome(invoice(**changes), CheckId.DATES_VALID).failed is failing


def test_an_unknown_currency_fails_and_a_known_one_passes() -> None:
    """The seven trading currencies pass, XYZ does not."""
    assert outcome(invoice(currency="XYZ"), CheckId.CURRENCY_KNOWN).failed
    assert outcome(invoice(currency="EUR"), CheckId.CURRENCY_KNOWN).status == "passed"
    assert outcome(invoice(currency=None), CheckId.CURRENCY_KNOWN).status == "skipped"


def test_mixed_signs_fail_and_a_whole_credit_note_passes() -> None:
    """A credit note printed with minus signs throughout is fine; one amount with the wrong sign is not."""
    negative = invoice(
        document_type="credit_note",
        line_items=[{"description": "Return", "quantity": 1, "unit_price": "-100.00", "total": "-100.00"}],
        subtotal="-100.00",
        vat=[{"rate": 21, "base": "-100.00", "amount": "-21.00"}],
        total="-121.00",
    )
    assert all(not result.failed for result in run_checks(negative, TODAY))
    mixed = invoice(vat=[{"rate": 21, "base": "8600.00", "amount": "-1806.00"}])
    assert outcome(mixed, CheckId.SIGNS_AGREE).failed


def test_a_line_that_does_not_multiply_fails() -> None:
    """Four bags at 1,850 is 7,400, not 7,040, and the failure names the line's total."""
    bad = invoice(
        line_items=[
            {"description": "Kraft bag", "quantity": 4, "unit_price": "1850.00", "total": "7040.00"},
            {"description": "Labels", "quantity": 10, "unit_price": "120.00", "total": "1200.00"},
        ]
    )
    result = outcome(bad, CheckId.LINE_MATH)
    assert result.failed
    assert result.fields == ("line_items.0.total",)
    assert (result.expected, result.actual) == ("7400.00", "7040.00")


def test_a_line_with_a_missing_number_is_not_checked() -> None:
    """A line with no unit price cannot be multiplied: the check is skipped, not passed."""
    result = outcome(invoice(line_items=[{"description": "Gift", "total": "10.00"}]), CheckId.LINE_MATH)
    assert result.status == "skipped"


def test_lines_must_add_up_to_the_subtotal() -> None:
    """Lines of 7,400 and 1,200 make 8,600; a subtotal of 8,060 fails."""
    result = outcome(invoice(subtotal="8060.00"), CheckId.LINE_ITEMS_SUM)
    assert result.failed
    assert (result.expected, result.actual) == ("8600.00", "8060.00")
    assert result.fields[0] == "subtotal"


def test_one_cent_of_rounding_is_forgiven_and_two_are_not() -> None:
    """Printed amounts are rounded one at a time, so the sum may differ by a cent."""
    assert outcome(invoice(subtotal="8600.01"), CheckId.LINE_ITEMS_SUM).status == "passed"
    assert outcome(invoice(subtotal="8600.02"), CheckId.LINE_ITEMS_SUM).failed


def test_vat_must_be_the_base_times_the_rate() -> None:
    """21% of 8,600 is 1,806; a printed 1,860 fails and says what it should be."""
    bad = invoice(vat=[{"rate": 21, "base": "8600.00", "amount": "1860.00"}])
    result = outcome(bad, CheckId.VAT_MATH)
    assert result.failed
    assert (result.expected, result.actual) == ("1806.00", "1860.00")


def test_a_single_vat_line_without_a_base_uses_the_subtotal() -> None:
    """An invoice with one rate often prints no base; the subtotal is it."""
    assert outcome(invoice(vat=[{"rate": 21, "amount": "1806.00"}]), CheckId.VAT_MATH).status == "passed"
    assert outcome(invoice(vat=[{"rate": 21, "amount": "1600.00"}]), CheckId.VAT_MATH).failed


def test_several_rates_are_each_checked() -> None:
    """A euro invoice with 19% and 7% passes when each line is right and fails on the wrong one."""
    euro = {
        "currency": "EUR",
        "line_items": [
            {"description": "Beans", "quantity": 1, "unit_price": "1000.00", "total": "1000.00"},
            {"description": "Cups", "quantity": 1, "unit_price": "500.00", "total": "500.00"},
        ],
        "subtotal": "1500.00",
        "vat": [
            {"rate": 7, "base": "1000.00", "amount": "70.00"},
            {"rate": 19, "base": "500.00", "amount": "95.00"},
        ],
        "total": "1665.00",
    }
    assert all(not result.failed for result in run_checks(invoice(**euro), TODAY))
    euro["vat"][1]["amount"] = "59.00"  # type: ignore[index]
    result = outcome(invoice(**euro), CheckId.VAT_MATH)
    assert result.failed
    assert result.fields == ("vat.1.amount",)


def test_vat_bases_must_add_up_to_the_subtotal() -> None:
    """Bases of 5,000 and 3,000 against a subtotal of 8,600 fail."""
    bad = invoice(
        vat=[{"rate": 21, "base": "5000.00", "amount": "1050.00"}, {"rate": 12, "base": "3000.00", "amount": "360.00"}]
    )
    assert outcome(bad, CheckId.VAT_BASES).failed


def test_the_total_must_be_the_subtotal_plus_the_vat() -> None:
    """8,600 and 1,806 make 10,406; a printed total of 10,046 fails."""
    result = outcome(invoice(total="10046.00"), CheckId.TOTAL_RECONCILES)
    assert result.failed
    assert (result.expected, result.actual) == ("10406.00", "10046.00")


def test_a_missing_subtotal_is_the_sum_of_the_lines() -> None:
    """An invoice with no VAT and no subtotal still reconciles: its total is its lines."""
    plain = invoice(subtotal=None, vat=[], total="8600.00")
    assert outcome(plain, CheckId.TOTAL_RECONCILES).status == "passed"
    assert outcome(invoice(subtotal=None, vat=[], total="8000.00"), CheckId.TOTAL_RECONCILES).failed


def test_a_receipt_whose_prices_include_vat_adds_up_to_its_total() -> None:
    """On a gross receipt the lines add to the total, and base plus VAT adds to it too."""
    receipt = {
        "document_type": "receipt",
        "prices_include_vat": True,
        "subtotal": None,
        "line_items": [
            {"description": "Flat white", "quantity": 2, "unit_price": "49.00", "total": "98.00"},
            {"description": "Croissant", "quantity": 1, "unit_price": "32.00", "total": "32.00"},
        ],
        "vat": [{"rate": 12, "base": "116.07", "amount": "13.93"}],
        "total": "130.00",
    }
    results = {result.id: result for result in run_checks(invoice(**receipt), TODAY)}
    assert results[CheckId.LINE_ITEMS_SUM].status == "passed"
    assert results[CheckId.VAT_MATH].status == "passed"
    assert results[CheckId.VAT_BASES].status == "passed"
    assert results[CheckId.TOTAL_RECONCILES].status == "skipped"
    receipt["total"] = "135.00"
    assert outcome(invoice(**receipt), CheckId.LINE_ITEMS_SUM).failed


def test_nothing_is_ever_fixed() -> None:
    """The checks report the numbers that disagree and never change the invoice they were given."""
    bad = invoice(total="10046.00")
    before = bad.model_dump()
    run_checks(bad, TODAY)
    assert bad.model_dump() == before


def test_repairable_checks_exclude_duplicates_and_missing_boxes() -> None:
    """A second reading can fix arithmetic, not a duplicate or a field the page doesn't show."""
    assert CheckId.NOT_DUPLICATE not in REPAIRABLE
    assert CheckId.FIELDS_ON_PAGE not in REPAIRABLE
    assert CheckId.TOTAL_RECONCILES in REPAIRABLE


def test_the_repair_request_names_exactly_the_failed_checks() -> None:
    """The request lists each failed check by name with its numbers, and no passed check."""
    bad = invoice(subtotal="8060.00", total="10046.00")
    request = repair_request(failures(run_checks(bad, TODAY), REPAIRABLE))
    assert "line_items_sum" in request
    assert "total_reconciles" in request
    assert "8600.00" in request
    assert "vat_math" not in request
    assert "dates_valid" not in request


def test_only_error_failures_block_the_export() -> None:
    """A failed warning asks for a look; a failed error stops the export."""
    warning = CheckResult(CheckId.FIELDS_ON_PAGE, "failed", Severity.WARNING)
    error = CheckResult(CheckId.NOT_DUPLICATE, "failed", Severity.ERROR)
    assert not blocks_export([warning])
    assert blocks_export([warning, error])
    assert not blocks_export([CheckResult(CheckId.NOT_DUPLICATE, "skipped", Severity.ERROR)])
