"""The CSV exports: what a spreadsheet will do with a cell, and the shape of the lines and the journal."""

import csv
import io
from decimal import Decimal

import pytest

from lb03.accounts import post, read_chart
from lb03.export import (
    BYTE_ORDER_MARK,
    CSV_MEDIA_TYPE,
    JOURNAL_COLUMNS,
    LINE_COLUMNS,
    journal_csv,
    lines_csv,
    safe_cell,
)
from lb03.golden import SEED_DIRECTORY, GoldenCase, printed_as_reply, read_golden_set
from lb03.invoice import ExtractedInvoice


def golden_invoice(case: GoldenCase) -> ExtractedInvoice:
    """Make the invoice a perfect model would read from a golden document."""
    assert case.printed is not None
    return ExtractedInvoice.from_reply(printed_as_reply(case.printed))


def parse(text: str) -> list[list[str]]:
    """Read a CSV text the way a spreadsheet would, without its byte order mark."""
    assert text.startswith(BYTE_ORDER_MARK)
    return list(csv.reader(io.StringIO(text.removeprefix(BYTE_ORDER_MARK))))


@pytest.mark.parametrize(
    "text",
    [
        '=HYPERLINK("http://evil.example/x","Click")',
        "@SUM(A1:A9)",
        "+1 free coffee",
        "-2 discount",
        "=cmd|' /C calc'!A0",
        "\t=1+1",
        "\r=1+1",
        chr(0xFF1D) + "1+1",
        chr(0xFF0B) + "1+1",
        "  =1+1",
    ],
)
def test_text_that_a_spreadsheet_would_read_as_a_formula_is_made_plain_text(text: str) -> None:
    """An apostrophe goes in front, so the cell shows the words and runs nothing."""
    safe = safe_cell(text)
    assert safe.startswith("'")
    assert safe[1:].replace("\r", " ").replace("\n", " ").strip() != ""


@pytest.mark.parametrize(
    "text",
    [
        "Green coffee Ethiopia Guji, 60 kg bag",
        "Fast <b>Roast</b> Supplies & Co",
        "Kraft coffee bag 250 g",
        "2026-0412",
        "10 % off",
    ],
)
def test_ordinary_text_is_left_alone(text: str) -> None:
    """A cell that cannot start a formula is written as it is, markup included: the file is text, not a page."""
    assert safe_cell(text) == text


def test_newlines_and_control_characters_cannot_split_a_cell_or_a_row() -> None:
    """A description with line breaks stays one cell, and control characters are dropped."""
    assert safe_cell("two\nlines\r\nhere") == "two lines here"
    assert safe_cell("bell\x07 and null\x00") == "bell and null"
    assert safe_cell(None) == ""
    assert safe_cell("") == ""


def test_the_lines_csv_of_a_hostile_invoice_holds_no_live_formula() -> None:
    """The golden invoice whose descriptions are formulas exports with every one of them as text."""
    case = read_golden_set().case("hostile-markup-fast-roast")
    rows = parse(lines_csv(golden_invoice(case)))
    assert tuple(rows[0]) == LINE_COLUMNS
    descriptions = [row[LINE_COLUMNS.index("description")] for row in rows[1:]]
    assert any(description.startswith("'=HYPERLINK") for description in descriptions)
    assert any(description.startswith("'@SUM") for description in descriptions)
    assert any(description.startswith("'+1 free") for description in descriptions)
    assert any(description.startswith("'-2 discount") for description in descriptions)
    for row in rows[1:]:
        for cell in row:
            assert not cell.startswith(("=", "@", "+")), cell
    assert rows[1][LINE_COLUMNS.index("vendor")] == "Fast <b>Roast</b> Supplies & Co"


def test_the_lines_csv_has_a_row_for_each_line_with_the_documents_header_and_totals() -> None:
    """One row per line item, each carrying the vendor, number, dates, currency and the document's totals."""
    invoice = golden_invoice(read_golden_set().case("bohemia-packaging-2026-0412"))
    text = lines_csv(invoice)
    rows = parse(text)
    assert text.startswith(BYTE_ORDER_MARK)
    assert "\r\n" in text
    assert len(rows) == 1 + len(invoice.line_items)
    first = dict(zip(rows[0], rows[1], strict=True))
    assert first["vendor"] == "Bohemia Packaging s.r.o."
    assert first["invoice_number"] == invoice.invoice_number
    assert first["issue_date"] == invoice.issue_date.isoformat()  # type: ignore[union-attr]
    assert first["currency"] == "CZK"
    assert first["line"] == "1"
    assert Decimal(first["line_total"]) == invoice.line_items[0].total
    assert Decimal(first["total"]) == invoice.total
    assert Decimal(first["vat_total"]) == sum(line.amount for line in invoice.vat)  # type: ignore[misc]


def test_the_journal_csv_balances_and_has_one_side_per_line() -> None:
    """Each line has a debit or a credit and not both, and the file's debits and credits are equal."""
    case = read_golden_set().case("hanse-green-2026-4417")
    entry = post(golden_invoice(case), read_chart(SEED_DIRECTORY))
    rows = parse(journal_csv(entry))
    assert tuple(rows[0]) == JOURNAL_COLUMNS
    debits = Decimal(0)
    credited = Decimal(0)
    for row in rows[1:]:
        values = dict(zip(rows[0], row, strict=True))
        assert (values["debit"] == "") != (values["credit"] == "")
        debits += Decimal(values["debit"] or 0)
        credited += Decimal(values["credit"] or 0)
        assert values["currency"] == "EUR"
        assert values["date"] == entry.day.isoformat()
    assert debits == credited == Decimal("3689.06")


def test_the_media_type_says_utf_8() -> None:
    """The response is sent as UTF-8 text."""
    assert CSV_MEDIA_TYPE == "text/csv; charset=utf-8"


def test_a_credit_notes_journal_csv_credits_the_expenses() -> None:
    """The turned-round entry reaches the file: the payable on the debit side."""
    entry = post(golden_invoice(read_golden_set().case("credit-hanse-2026-c031")), read_chart(SEED_DIRECTORY))
    rows = parse(journal_csv(entry))
    payable = next(dict(zip(rows[0], row, strict=True)) for row in rows[1:] if row[2] == "2100")
    assert payable["debit"] != ""
    assert payable["credit"] == ""
