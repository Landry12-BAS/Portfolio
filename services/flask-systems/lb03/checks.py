"""The deterministic checks: code owns the arithmetic, the model owns none of it.

An extracted invoice is held to these checks in a fixed order. They use `Decimal` only and the
one-cent rule of lb03/money.py, and they never change the invoice: a check that fails is reported with
the numbers that disagree, and the document either goes back for one targeted repair that names exactly
the failed checks, or is returned with the failure listed. Nothing here, and nothing after it, "fixes" a
total by recomputing it, because a document that does not add up is a finding, not a typo.

    required_fields   a vendor, a number, an issue date, a currency, a total and at least one line item
    dates_valid       the issue date is not in the future (and not before 2000); the due date is not before it
    currency_known    the currency is one of the seven Basalt & Bean trades in
    signs_agree       the amounts are all positive or all negative, as a credit note may print them
    line_math         quantity times unit price is the line's total
    line_items_sum    the line totals add up to the subtotal (to the total, when prices include VAT)
    vat_math          each VAT amount is its base times its rate
    vat_bases         the VAT bases add up to the subtotal
    total_reconciles  subtotal plus VAT is the total

Two more checks need more than the invoice: `fields_on_page` (a warning: every amount and name was found
on the document, which lb03/boxes.py knows) and `not_duplicate` (an error: the document is not one this
visitor, or the samples, already hold, which lb03/duplicates.py knows). They are results of the same shape.
"""

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from enum import StrEnum
from typing import Literal

from lb03.invoice import CURRENCIES, ExtractedInvoice, LineItem, VatLine
from lb03.money import amount_text, cents, same_amount, vat_amount

# The earliest issue date taken as real: an invoice dated before this was misread (a two-digit year, an OCR slip).
EARLIEST_ISSUE_DATE = date(2000, 1, 1)


class CheckId(StrEnum):
    """The name of each check: what the API reports, what the board's words are keyed by, what a repair names."""

    REQUIRED_FIELDS = "required_fields"
    DATES_VALID = "dates_valid"
    CURRENCY_KNOWN = "currency_known"
    SIGNS_AGREE = "signs_agree"
    LINE_MATH = "line_math"
    LINE_ITEMS_SUM = "line_items_sum"
    VAT_MATH = "vat_math"
    VAT_BASES = "vat_bases"
    TOTAL_RECONCILES = "total_reconciles"
    FIELDS_ON_PAGE = "fields_on_page"
    NOT_DUPLICATE = "not_duplicate"


class Severity(StrEnum):
    """Whether a failed check stops the export (an error) or only asks for a look (a warning)."""

    ERROR = "error"
    WARNING = "warning"


type Status = Literal["passed", "failed", "skipped"]

# Which checks a model may be asked to repair: the ones about reading the document again. A duplicate, and a
# field that isn't on the page, are not something a second reading fixes.
REPAIRABLE = frozenset(
    {
        CheckId.REQUIRED_FIELDS,
        CheckId.DATES_VALID,
        CheckId.CURRENCY_KNOWN,
        CheckId.SIGNS_AGREE,
        CheckId.LINE_MATH,
        CheckId.LINE_ITEMS_SUM,
        CheckId.VAT_MATH,
        CheckId.VAT_BASES,
        CheckId.TOTAL_RECONCILES,
    }
)


@dataclass(frozen=True)
class CheckResult:
    """One check's verdict: what was checked, what the code computed against what the document says, and where.

    `message` is a plain English sentence built from the numbers (never from the document's words), for the
    repair request and the logs; the board writes its own sentence in the visitor's language from `id`,
    `expected` and `actual`. `fields` are the paths of the fields the check is about, which the board lights up.
    """

    id: CheckId
    status: Status
    severity: Severity = Severity.ERROR
    message: str = ""
    fields: tuple[str, ...] = field(default_factory=tuple)
    expected: str | None = None
    actual: str | None = None

    @property
    def failed(self) -> bool:
        """Tell whether the check ran and the document did not pass it."""
        return self.status == "failed"


def passed(check: CheckId, fields: tuple[str, ...] = ()) -> CheckResult:
    """Make the result of a check the document passed."""
    return CheckResult(check, "passed", fields=fields)


def skipped(check: CheckId, message: str) -> CheckResult:
    """Make the result of a check that could not run for want of numbers, saying which."""
    return CheckResult(check, "skipped", message=message)


def failed(
    check: CheckId, message: str, fields: tuple[str, ...], expected: str | None = None, actual: str | None = None
) -> CheckResult:
    """Make the result of a check the document failed."""
    return CheckResult(check, "failed", message=message, fields=fields, expected=expected, actual=actual)


def check_required_fields(invoice: ExtractedInvoice) -> CheckResult:
    """Require a vendor, a number, an issue date, a currency, a total and at least one line item."""
    missing = [
        path
        for path, value in (
            ("vendor", invoice.vendor),
            ("invoice_number", invoice.invoice_number),
            ("issue_date", invoice.issue_date),
            ("currency", invoice.currency),
            ("total", invoice.total),
        )
        if value is None
    ]
    if not invoice.line_items:
        missing.append("line_items")
    if missing:
        return failed(CheckId.REQUIRED_FIELDS, f"These fields are missing: {', '.join(missing)}.", tuple(missing))
    return passed(CheckId.REQUIRED_FIELDS)


def check_dates(invoice: ExtractedInvoice, today: date) -> CheckResult:
    """Require an issue date that is not in the future, and a due date that is not before it."""
    if invoice.issue_date is None:
        return skipped(CheckId.DATES_VALID, "There is no issue date to check.")
    issue = invoice.issue_date
    if issue > today:
        return failed(
            CheckId.DATES_VALID,
            f"The issue date {issue.isoformat()} is in the future.",
            ("issue_date",),
            expected=f"on or before {today.isoformat()}",
            actual=issue.isoformat(),
        )
    if issue < EARLIEST_ISSUE_DATE:
        return failed(
            CheckId.DATES_VALID,
            f"The issue date {issue.isoformat()} is before {EARLIEST_ISSUE_DATE.year}.",
            ("issue_date",),
            expected=f"{EARLIEST_ISSUE_DATE.isoformat()} or later",
            actual=issue.isoformat(),
        )
    if invoice.due_date is not None and invoice.due_date < issue:
        return failed(
            CheckId.DATES_VALID,
            f"The due date {invoice.due_date.isoformat()} is before the issue date {issue.isoformat()}.",
            ("due_date",),
            expected=f"{issue.isoformat()} or later",
            actual=invoice.due_date.isoformat(),
        )
    return passed(CheckId.DATES_VALID, ("issue_date", "due_date"))


def check_currency(invoice: ExtractedInvoice) -> CheckResult:
    """Require a currency from the short list of those Basalt & Bean trades in."""
    if invoice.currency is None:
        return skipped(CheckId.CURRENCY_KNOWN, "There is no currency to check.")
    if invoice.currency not in CURRENCIES:
        return failed(
            CheckId.CURRENCY_KNOWN,
            f"The currency {invoice.currency} is not one of {', '.join(CURRENCIES)}.",
            ("currency",),
            expected=", ".join(CURRENCIES),
            actual=invoice.currency,
        )
    return passed(CheckId.CURRENCY_KNOWN, ("currency",))


def printed_amounts(invoice: ExtractedInvoice) -> list[Decimal]:
    """Collect every amount the invoice prints: the line totals, the subtotal, the VAT amounts and the total."""
    amounts = [item.total for item in invoice.line_items]
    amounts.append(invoice.subtotal)
    amounts.extend(line.amount for line in invoice.vat)
    amounts.append(invoice.total)
    return [amount for amount in amounts if amount is not None]


def check_signs(invoice: ExtractedInvoice) -> CheckResult:
    """Require the printed amounts to agree in sign: all positive or all negative (zeros agree with both)."""
    amounts = [amount for amount in printed_amounts(invoice) if amount != 0]
    if len(amounts) < 2:
        return skipped(CheckId.SIGNS_AGREE, "There are too few amounts to compare.")
    if all(amount > 0 for amount in amounts) or all(amount < 0 for amount in amounts):
        return passed(CheckId.SIGNS_AGREE)
    return failed(CheckId.SIGNS_AGREE, "Some amounts are positive and some negative.", ("total",))


def check_line_math(invoice: ExtractedInvoice) -> CheckResult:
    """Require quantity times unit price to be the line total, for every line that prints all three."""
    checked = 0
    for index, item in enumerate(invoice.line_items):
        if item.quantity is None or item.unit_price is None or item.total is None:
            continue
        checked += 1
        product = cents(item.quantity * item.unit_price)
        if not same_amount(product, item.total):
            return failed(
                CheckId.LINE_MATH,
                f"Line {index + 1}: {item.quantity} times {item.unit_price} is {amount_text(product)}, "
                f"but the line total is {amount_text(item.total)}.",
                (f"line_items.{index}.total",),
                expected=amount_text(product),
                actual=amount_text(item.total),
            )
    if checked == 0:
        return skipped(CheckId.LINE_MATH, "No line prints a quantity, a unit price and a total.")
    return passed(CheckId.LINE_MATH)


def line_totals(items: list[LineItem]) -> list[Decimal] | None:
    """Return every line's total, or None when any line has none."""
    totals = [item.total for item in items]
    if not totals or any(total is None for total in totals):
        return None
    return [total for total in totals if total is not None]


def check_line_items_sum(invoice: ExtractedInvoice) -> CheckResult:
    """Require the line totals to add up to the subtotal, or to the total when the prices include VAT."""
    totals = line_totals(invoice.line_items)
    gross = invoice.prices_include_vat is True
    target = invoice.total if gross else invoice.subtotal
    path = "total" if gross else "subtotal"
    if totals is None:
        return skipped(CheckId.LINE_ITEMS_SUM, "Not every line prints a total.")
    if target is None:
        return skipped(CheckId.LINE_ITEMS_SUM, f"There is no {path} to compare the lines with.")
    added = sum(totals, Decimal(0))
    if not same_amount(added, target):
        return failed(
            CheckId.LINE_ITEMS_SUM,
            f"The line totals add up to {amount_text(added)}, but the {path} is {amount_text(target)}.",
            (path, *(f"line_items.{index}.total" for index in range(len(totals)))),
            expected=amount_text(added),
            actual=amount_text(target),
        )
    return passed(CheckId.LINE_ITEMS_SUM)


def vat_base(invoice: ExtractedInvoice, line: VatLine) -> Decimal | None:
    """Return the amount a VAT line applies to: its own base, or the subtotal when it is the only VAT line."""
    if line.base is not None:
        return line.base
    if len(invoice.vat) == 1 and invoice.prices_include_vat is not True:
        return invoice.subtotal
    return None


def check_vat_math(invoice: ExtractedInvoice) -> CheckResult:
    """Require each VAT amount to be its base times its rate, rounded to the cent (give or take one)."""
    checked = 0
    for index, line in enumerate(invoice.vat):
        base = vat_base(invoice, line)
        if line.rate is None or line.amount is None or base is None:
            continue
        checked += 1
        expected = vat_amount(base, line.rate)
        if not same_amount(expected, line.amount):
            return failed(
                CheckId.VAT_MATH,
                f"VAT line {index + 1}: {line.rate}% of {amount_text(base)} is {amount_text(expected)}, "
                f"but the VAT is {amount_text(line.amount)}.",
                (f"vat.{index}.amount",),
                expected=amount_text(expected),
                actual=amount_text(line.amount),
            )
    if checked == 0:
        return skipped(CheckId.VAT_MATH, "No VAT line prints a rate, an amount and what it applies to.")
    return passed(CheckId.VAT_MATH)


def check_vat_bases(invoice: ExtractedInvoice) -> CheckResult:
    """Require the VAT bases to add up to the subtotal, or base plus VAT to the total when prices include VAT."""
    if not invoice.vat or any(line.base is None for line in invoice.vat):
        return skipped(CheckId.VAT_BASES, "Not every VAT line prints what it applies to.")
    gross = invoice.prices_include_vat is True
    target = invoice.total if gross else invoice.subtotal
    path = "total" if gross else "subtotal"
    if target is None or (gross and any(line.amount is None for line in invoice.vat)):
        return skipped(CheckId.VAT_BASES, f"There is no {path} to compare the VAT bases with.")
    added = sum((line.base or Decimal(0) for line in invoice.vat), Decimal(0))
    if gross:
        added += sum((line.amount or Decimal(0) for line in invoice.vat), Decimal(0))
    if not same_amount(added, target):
        return failed(
            CheckId.VAT_BASES,
            f"The VAT lines apply to {amount_text(added)}, but the {path} is {amount_text(target)}.",
            (path, *(f"vat.{index}.base" for index in range(len(invoice.vat)))),
            expected=amount_text(added),
            actual=amount_text(target),
        )
    return passed(CheckId.VAT_BASES)


def check_total(invoice: ExtractedInvoice) -> CheckResult:
    """Require the subtotal plus the VAT to be the total: the line totals stand in for a subtotal the document omits."""
    if invoice.total is None:
        return skipped(CheckId.TOTAL_RECONCILES, "There is no total to check.")
    if invoice.prices_include_vat is True and invoice.subtotal is None:
        return skipped(CheckId.TOTAL_RECONCILES, "The prices include VAT and there is no subtotal.")
    base = invoice.subtotal
    if base is None:
        totals = line_totals(invoice.line_items)
        base = sum(totals, Decimal(0)) if totals is not None else None
    if base is None:
        return skipped(CheckId.TOTAL_RECONCILES, "There is no subtotal, and not every line prints a total.")
    if any(line.amount is None for line in invoice.vat):
        return skipped(CheckId.TOTAL_RECONCILES, "A VAT line prints no amount.")
    expected = base + sum((line.amount or Decimal(0) for line in invoice.vat), Decimal(0))
    if not same_amount(expected, invoice.total):
        return failed(
            CheckId.TOTAL_RECONCILES,
            f"The subtotal and the VAT come to {amount_text(expected)}, but the total is {amount_text(invoice.total)}.",
            ("total",),
            expected=amount_text(expected),
            actual=amount_text(invoice.total),
        )
    return passed(CheckId.TOTAL_RECONCILES)


def run_checks(invoice: ExtractedInvoice, today: date) -> list[CheckResult]:
    """Run every check that needs only the invoice, in the fixed order of the module's list, as of `today`."""
    return [
        check_required_fields(invoice),
        check_dates(invoice, today),
        check_currency(invoice),
        check_signs(invoice),
        check_line_math(invoice),
        check_line_items_sum(invoice),
        check_vat_math(invoice),
        check_vat_bases(invoice),
        check_total(invoice),
    ]


def failures(results: list[CheckResult], only: frozenset[CheckId] | None = None) -> list[CheckResult]:
    """Return the checks that failed, optionally only among the given ones."""
    return [result for result in results if result.failed and (only is None or result.id in only)]


def blocks_export(results: list[CheckResult]) -> bool:
    """Tell whether any failed check is an error: a document with one is not exported."""
    return any(result.failed and result.severity is Severity.ERROR for result in results)


def repair_request(failed_checks: list[CheckResult]) -> str:
    """Write what a model is told when its answer failed checks: each check by name, with the numbers that disagree.

    The text holds only the checks' names, field paths and amounts, which are all derived from the
    model's own answer by code, never words from the document, so it cannot carry an injection back in.
    """
    lines = ["These checks failed on your answer:"]
    for result in failed_checks:
        lines.append(f"- {result.id.value}: {result.message} (fields: {', '.join(result.fields)})")
    lines.append(
        "Read the document again and answer with the complete corrected JSON object. "
        "Change only what the document supports. If the document itself does not add up, keep what it prints."
    )
    return "\n".join(lines)
