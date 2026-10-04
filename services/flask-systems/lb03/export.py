"""CSV exports of a checked document: its lines, and its journal entry.

A visitor opens these in a spreadsheet, so what is in a cell can be a formula. A description that begins with `=`,
`+`, `-` or `@` (or a tab or a carriage return) is read by Excel and LibreOffice as a formula, which can call out
to the network or run a command: `=HYPERLINK("http://evil.example/x","Click")` is a sentence an invoice may
print. Every cell of free text (a vendor, a number, a description, a memo) is therefore written with an apostrophe
in front when it begins that way, which spreadsheets show as plain text and drop. The comparison is made after
Unicode normalisation (NFKC), so a full-width equals sign is caught too. Cells that are numbers or dates are made here
from `Decimal` and `date`, and cannot hold text.

The files are UTF-8 with a byte order mark, which is how Excel is told that the Czech letters are Czech letters, CRLF
lines, and every cell that needs it quoted by Python's own `csv` writer.
"""

import csv
import io
import re
import unicodedata
from decimal import Decimal

from lb03.accounts import JournalEntry
from lb03.invoice import ExtractedInvoice
from lb03.money import amount_text, quantity_text

BYTE_ORDER_MARK = chr(0xFEFF)
CSV_MEDIA_TYPE = "text/csv; charset=utf-8"
# The characters a spreadsheet reads as the start of a formula.
FORMULA_STARTS = ("=", "+", "-", "@", "\t", "\r")
LINE_COLUMNS = (
    "vendor",
    "invoice_number",
    "document_type",
    "issue_date",
    "due_date",
    "currency",
    "line",
    "description",
    "quantity",
    "unit_price",
    "line_total",
    "subtotal",
    "vat_total",
    "total",
)
JOURNAL_COLUMNS = ("date", "reference", "account", "account_name", "debit", "credit", "currency", "memo")


def safe_cell(text: str | None) -> str:
    """Make a cell of free text safe to open in a spreadsheet: control characters out, formulas turned into text."""
    if not text:
        return ""
    flat = re.sub(r"[\r\n]+", " ", text)
    cleaned = "".join(character for character in flat if character.isprintable() or character == "\t")
    leading = unicodedata.normalize("NFKC", cleaned.lstrip())[:1]
    if cleaned.startswith(FORMULA_STARTS) or leading in {"=", "+", "-", "@"}:
        return f"'{cleaned}"
    return cleaned


def write_csv(header: tuple[str, ...], rows: list[list[str]]) -> str:
    """Write a CSV document with a byte order mark: the header, then the rows."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow(header)
    writer.writerows(rows)
    return BYTE_ORDER_MARK + buffer.getvalue()


def lines_csv(invoice: ExtractedInvoice) -> str:
    """Write the document's line items as a CSV, one row each, with the document's header and totals on every row."""
    vat_total = sum((line.amount for line in invoice.vat if line.amount is not None), Decimal(0))
    rows = []
    for number, item in enumerate(invoice.line_items, start=1):
        rows.append(
            [
                safe_cell(invoice.vendor),
                safe_cell(invoice.invoice_number),
                invoice.document_type,
                invoice.issue_date.isoformat() if invoice.issue_date else "",
                invoice.due_date.isoformat() if invoice.due_date else "",
                invoice.currency or "",
                str(number),
                safe_cell(item.description),
                quantity_text(item.quantity) if item.quantity is not None else "",
                amount_text(item.unit_price) if item.unit_price is not None else "",
                amount_text(item.total) if item.total is not None else "",
                amount_text(invoice.subtotal) if invoice.subtotal is not None else "",
                amount_text(vat_total) if invoice.vat else "",
                amount_text(invoice.total) if invoice.total is not None else "",
            ]
        )
    return write_csv(LINE_COLUMNS, rows)


def journal_csv(entry: JournalEntry) -> str:
    """Write a journal entry as a CSV, one row per line, in the order of the entry."""
    rows = [
        [
            entry.day.isoformat(),
            safe_cell(entry.reference),
            line.account,
            line.name,
            amount_text(line.debit) if line.debit else "",
            amount_text(line.credit) if line.credit else "",
            entry.currency,
            safe_cell(line.memo),
        ]
        for line in entry.lines
    ]
    return write_csv(JOURNAL_COLUMNS, rows)
