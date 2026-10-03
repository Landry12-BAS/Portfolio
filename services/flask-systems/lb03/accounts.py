"""The chart of accounts, and the journal entry a checked document becomes.

`data/seed/lb03/chart_of_accounts.yaml` is read by a strict reader (an unknown field, a code that is not an account,
an account of the wrong kind for its place are all errors that stop the service from starting, naming the file).
A document that passed its checks is posted by code, never by a model:

- every line goes to the first rule whose keyword its description contains, or to the default expense account;
- on a supplier invoice, the expenses and the input VAT are debited and the payable is credited by the total;
- on a till receipt, the cash account is credited instead of the payable;
- on a credit note, the same entry is turned round: the payable is debited, the expenses and the VAT credited;
- a document whose line prices already hold the VAT (a receipt) has the VAT taken out of the expenses, shared
  among them in proportion to their gross amounts, cent by cent, so the entry still adds up;
- a difference of a cent between the lines and the total, which printed rounding can honestly leave, goes to the
  rounding account. A larger difference is not rounding and is refused: such a document failed its checks and is
  not posted.

Everything here is `Decimal`, in the currency the document is in: there is no conversion.
"""

from dataclasses import dataclass
from datetime import date
from decimal import ROUND_FLOOR, Decimal
from pathlib import Path
from typing import Annotated, Literal, Self

from pydantic import Field, StringConstraints, model_validator

from core.data_files import StrictEntry, read_data_file
from lb03.invoice import ExtractedInvoice
from lb03.money import CENT, TOLERANCE, cents

CHART_FILE = "chart_of_accounts.yaml"
type AccountKind = Literal["asset", "liability", "expense"]
type Code = Annotated[str, StringConstraints(pattern=r"^[0-9]{4}$")]
type Keyword = Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=40, to_lower=True)]


class EntryError(Exception):
    """A document can't be posted: its numbers don't make a balanced entry."""


class Account(StrictEntry):
    """One account of the chart: its four-digit code, its name and what kind it is."""

    code: Code
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=60)]
    kind: AccountKind


class Rule(StrictEntry):
    """A rule that sends a line to an account when its description holds one of the keywords."""

    account: Code
    keywords: list[Keyword] = Field(min_length=1, max_length=20)


class ChartOfAccounts(StrictEntry):
    """The whole chart: the accounts, where each side of an entry goes, and the rules for the expense accounts."""

    version: Literal[1]
    accounts: list[Account] = Field(min_length=5, max_length=60)
    payable: Code
    cash: Code
    input_vat: Code
    rounding: Code
    default_expense: Code
    rules: list[Rule] = Field(min_length=1, max_length=40)

    @model_validator(mode="after")
    def _check_references(self) -> Self:
        """Require unique codes, and every account the chart points at to exist and be of the right kind."""
        codes = [account.code for account in self.accounts]
        if len(set(codes)) != len(codes):
            raise ValueError("an account code appears twice")
        kinds = {account.code: account.kind for account in self.accounts}
        wanted: dict[str, tuple[str, AccountKind]] = {
            "payable": (self.payable, "liability"),
            "cash": (self.cash, "asset"),
            "input_vat": (self.input_vat, "asset"),
            "rounding": (self.rounding, "expense"),
            "default_expense": (self.default_expense, "expense"),
        }
        for place, (code, kind) in wanted.items():
            if kinds.get(code) != kind:
                raise ValueError(f"{place} must be the code of a {kind} account")
        for rule in self.rules:
            if kinds.get(rule.account) != "expense" or rule.account == self.rounding:
                raise ValueError(f"the rule for {rule.account} must point at an expense account other than rounding")
        return self

    def name_of(self, code: str) -> str:
        """Return an account's name."""
        return next(account.name for account in self.accounts if account.code == code)

    def expense_for(self, description: str) -> str:
        """Return the expense account a line with this description is posted to."""
        text = description.casefold()
        for rule in self.rules:
            if any(keyword in text for keyword in rule.keywords):
                return rule.account
        return self.default_expense


def read_chart(directory: Path) -> ChartOfAccounts:
    """Read and check the chart of accounts from a seed directory."""
    return read_data_file(directory / CHART_FILE, ChartOfAccounts)


@dataclass(frozen=True)
class JournalLine:
    """One line of a journal entry: an account with an amount on one side."""

    account: str
    name: str
    debit: Decimal
    credit: Decimal
    memo: str


@dataclass(frozen=True)
class JournalEntry:
    """A balanced entry: its date, the reference it is booked under, the currency, and its lines."""

    day: date
    reference: str
    currency: str
    lines: tuple[JournalLine, ...]

    @property
    def total_debit(self) -> Decimal:
        """Return the sum of the debits."""
        return sum((line.debit for line in self.lines), Decimal(0))

    @property
    def total_credit(self) -> Decimal:
        """Return the sum of the credits."""
        return sum((line.credit for line in self.lines), Decimal(0))

    @property
    def balanced(self) -> bool:
        """Tell whether the debits and the credits are exactly equal."""
        return self.total_debit == self.total_credit


def share_out(total: Decimal, weights: dict[str, Decimal]) -> dict[str, Decimal]:
    """Split an amount among accounts in proportion to their weights, to the cent, the remainders going to the largest.

    The shares always add up to `total` exactly: each gets its proportion rounded down to the cent, and what
    is left over is handed out a cent at a time to the accounts with the biggest remainders.
    """
    weight_sum = sum(weights.values(), Decimal(0))
    if weight_sum <= 0:
        raise EntryError("There is nothing to share the amount among.")
    exact = {code: total * weight / weight_sum for code, weight in weights.items()}
    shares = {code: value.quantize(CENT, rounding=ROUND_FLOOR) for code, value in exact.items()}
    leftover = int((total - sum(shares.values(), Decimal(0))) / CENT)
    by_remainder = sorted(exact, key=lambda code: exact[code] - shares[code], reverse=True)
    for code in by_remainder[:leftover]:
        shares[code] += CENT
    return shares


def expense_amounts(invoice: ExtractedInvoice, chart: ChartOfAccounts, vat_total: Decimal) -> dict[str, Decimal]:
    """Add up the expenses by account: the lines' totals, or, when the prices hold VAT, their share of the net total."""
    gross: dict[str, Decimal] = {}
    for item in invoice.line_items:
        if item.total is None:
            raise EntryError("A line has no total, so it can't be posted.")
        code = chart.expense_for(item.description)
        gross[code] = gross.get(code, Decimal(0)) + abs(item.total)
    if invoice.prices_include_vat:
        if invoice.total is None:
            raise EntryError("The document has no total.")
        return share_out(abs(invoice.total) - vat_total, gross)
    return {code: cents(amount) for code, amount in gross.items()}


def post(invoice: ExtractedInvoice, chart: ChartOfAccounts) -> JournalEntry:
    """Make the balanced journal entry of a document that passed its checks; `EntryError` when it can't balance."""
    if invoice.total is None or invoice.issue_date is None:
        raise EntryError("The document has no total or no date.")
    vat_total = sum((abs(line.amount) for line in invoice.vat if line.amount is not None), Decimal(0))
    expenses = expense_amounts(invoice, chart, vat_total)
    gross = cents(abs(invoice.total))
    difference = gross - sum(expenses.values(), Decimal(0)) - vat_total
    if abs(difference) > TOLERANCE:
        raise EntryError("The lines and the VAT do not add up to the total, so the entry would not balance.")
    reference = f"{invoice.vendor or 'Unknown vendor'} {invoice.invoice_number or ''}".strip()
    # The side of an ordinary document; a credit note takes the other.
    credit_note = invoice.document_type == "credit_note"
    owed = chart.cash if invoice.document_type == "receipt" else chart.payable
    sides: list[tuple[str, Decimal]] = sorted(expenses.items())
    if vat_total:
        sides.append((chart.input_vat, vat_total))
    lines = [line_of(chart, code, amount, reference, credit_note) for code, amount in sides]
    if difference:
        # Rounding goes with the expenses when the lines fall short of the total, and against them when they exceed it.
        lines.append(line_of(chart, chart.rounding, abs(difference), reference, credit_note != (difference < 0)))
    lines.append(line_of(chart, owed, gross, reference, not credit_note))
    entry = JournalEntry(invoice.issue_date, reference, invoice.currency or "", tuple(lines))
    if not entry.balanced:
        raise EntryError("The entry does not balance.")
    return entry


def line_of(chart: ChartOfAccounts, code: str, amount: Decimal, memo: str, credit: bool) -> JournalLine:
    """Make one line: the amount on the credit side when `credit`, otherwise on the debit side."""
    return JournalLine(
        account=code,
        name=chart.name_of(code),
        debit=Decimal(0) if credit else amount,
        credit=amount if credit else Decimal(0),
        memo=memo,
    )
