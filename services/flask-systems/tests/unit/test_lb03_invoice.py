"""Tests for LB-03's typed invoice: what a model's JSON may be, and how a visitor's edit is checked the same way."""

import json
from datetime import date
from decimal import Decimal
from typing import Any

import pytest
from pydantic import ValidationError

from lb03.invoice import (
    MAX_LINE_ITEMS,
    ExtractedInvoice,
    FieldPathError,
    field_paths,
    get_field,
    set_field,
)

REPLY: dict[str, Any] = {
    "document_type": "invoice",
    "vendor": "Bohemia Packaging s.r.o.",
    "invoice_number": "2026-0412",
    "issue_date": "2026-09-14",
    "due_date": "2026-10-14",
    "currency": "CZK",
    "line_items": [{"description": "Kraft bag", "quantity": 4, "unit_price": "1 850,00", "total": 7400.0}],
    "subtotal": "7400.00",
    "vat": [{"rate": 21, "base": "7400.00", "amount": "1554.00"}],
    "total": "8954.00",
}


def read(**changes: Any) -> ExtractedInvoice:
    """Read the sample reply with some fields replaced."""
    return ExtractedInvoice.model_validate_json(json.dumps({**REPLY, **changes}))


def test_a_good_reply_becomes_decimals_and_dates() -> None:
    """Amounts are Decimals read from numbers and strings alike, and dates are dates."""
    invoice = read()
    assert invoice.total == Decimal("8954.00")
    assert invoice.line_items[0].unit_price == Decimal("1850.00")
    assert invoice.line_items[0].total == Decimal("7400.0")
    assert invoice.vat[0].rate == Decimal(21)
    assert invoice.issue_date == date(2026, 9, 14)
    assert invoice.currency == "CZK"


def test_an_empty_reply_is_an_empty_invoice_not_an_error() -> None:
    """A document that prints nothing the model could read is a document with failed checks, not a failed reading."""
    invoice = ExtractedInvoice.model_validate({})
    assert invoice.vendor is None
    assert invoice.line_items == []
    assert invoice.document_type == "invoice"


def test_unknown_keys_are_ignored_and_cost_no_repair() -> None:
    """A model that adds a `notes` key is not asked to answer again."""
    assert read(notes="paid by card", extra={"a": 1}).vendor == "Bohemia Packaging s.r.o."


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("issue_date", "14/09/2026"),
        ("issue_date", "2026-02-30"),
        ("issue_date", 20260914),
        ("due_date", "next month"),
        ("total", "about ten"),
        ("total", True),
        ("subtotal", [1]),
        ("currency", "EURO"),
        ("currency", "12"),
        ("document_type", "quote"),
        ("vendor", "x" * 500),
        ("vendor", {"name": "x"}),
        ("prices_include_vat", "maybe"),
    ],
)
def test_a_field_that_does_not_fit_is_refused(field: str, value: object) -> None:
    """Dates are YYYY-MM-DD and real, amounts are amounts, a currency is a code, and text is bounded."""
    with pytest.raises(ValidationError):
        read(**{field: value})


def test_there_are_few_enough_rows() -> None:
    """More than forty line items, or eight VAT lines, is a misreading and is refused."""
    with pytest.raises(ValidationError):
        read(line_items=[{"description": "x", "total": 1}] * (MAX_LINE_ITEMS + 1))
    with pytest.raises(ValidationError):
        read(vat=[{"rate": 21}] * 9)


@pytest.mark.parametrize("empty", [None, "", "  ", "null", "N/A", "-", "—"])
def test_nothing_is_none(empty: object) -> None:
    """The ways a model writes 'not printed' all mean the field is empty."""
    invoice = read(vendor=empty, due_date=empty, total=empty, currency=empty)
    assert (invoice.vendor, invoice.due_date, invoice.total, invoice.currency) == (None, None, None, None)


def test_text_loses_control_characters() -> None:
    """A vendor with a newline, a tab or a NUL in it is cleaned to single spaces."""
    assert read(vendor="Bohemia\n\tPackaging\x00 s.r.o.").vendor == "Bohemia Packaging s.r.o."


def test_currency_symbols_and_case_are_understood() -> None:
    """A model may write eur or a euro sign for EUR."""
    assert read(currency="eur").currency == "EUR"
    assert read(currency="€").currency == "EUR"
    assert read(currency="Kč").currency == "CZK"


def test_document_types_are_normalised() -> None:
    """`Credit note` is a credit_note, and a missing type is an invoice."""
    assert read(document_type="Credit note").document_type == "credit_note"
    assert read(document_type=None).document_type == "invoice"


def test_field_paths_list_every_field_in_reading_order() -> None:
    """The header, then each line item's four fields, the subtotal, each VAT line's three, the total."""
    paths = field_paths(read())
    assert paths[:6] == ["document_type", "vendor", "invoice_number", "issue_date", "due_date", "currency"]
    assert "line_items.0.unit_price" in paths
    assert paths[-4:] == ["vat.0.rate", "vat.0.base", "vat.0.amount", "total"]


def test_a_field_reads_back_as_the_api_writes_it() -> None:
    """Amounts have two places, quantities none they do not need, dates are ISO."""
    invoice = read()
    assert get_field(invoice, "total") == "8954.00"
    assert get_field(invoice, "line_items.0.quantity") == "4"
    assert get_field(invoice, "line_items.0.unit_price") == "1850.00"
    assert get_field(invoice, "issue_date") == "2026-09-14"
    assert get_field(invoice, "vat.0.rate") == "21.00"
    assert get_field(read(due_date=None), "due_date") is None


@pytest.mark.parametrize(
    "path", ["", "nope", "TOTAL", "line_items.9.total", "line_items.0.colour", "vat.0", "a.b.c", "total.0"]
)
def test_an_unknown_path_is_refused(path: str) -> None:
    """Only the invoice's own fields have paths."""
    with pytest.raises(FieldPathError):
        get_field(read(), path)
    with pytest.raises(FieldPathError):
        set_field(read(), path, "1")


def test_an_edit_replaces_one_field_and_checks_the_text() -> None:
    """The new total is read like a model's, the old invoice is untouched, and nonsense is refused."""
    original = read()
    edited = set_field(original, "total", "8 954,50")
    assert edited.total == Decimal("8954.50")
    assert original.total == Decimal("8954.00")
    assert set_field(original, "line_items.0.description", "Bags").line_items[0].description == "Bags"
    assert set_field(original, "due_date", "").due_date is None
    with pytest.raises(FieldPathError):
        set_field(original, "total", "lots")
    with pytest.raises(FieldPathError):
        set_field(original, "issue_date", "yesterday")
