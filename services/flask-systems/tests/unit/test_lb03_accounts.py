"""The chart of accounts and the journal entries: a strict reader, balanced entries for every golden document."""

import random
from decimal import Decimal
from pathlib import Path

import pytest

from core.data_files import DataFileError
from lb03.accounts import ChartOfAccounts, EntryError, JournalEntry, post, read_chart, share_out
from lb03.golden import SEED_DIRECTORY, GoldenCase, printed_as_reply, read_golden_set
from lb03.invoice import ExtractedInvoice

CHART_TEXT = """
version: 1
accounts:
  - { code: "1010", name: "Cash", kind: asset }
  - { code: "1400", name: "Input VAT", kind: asset }
  - { code: "2100", name: "Payable", kind: liability }
  - { code: "5010", name: "Coffee", kind: expense }
  - { code: "5090", name: "Other", kind: expense }
  - { code: "5900", name: "Rounding", kind: expense }
payable: "2100"
cash: "1010"
input_vat: "1400"
rounding: "5900"
default_expense: "5090"
rules:
  - { account: "5010", keywords: ["coffee"] }
"""


def chart() -> ChartOfAccounts:
    """Read the real chart of accounts the service posts to."""
    return read_chart(SEED_DIRECTORY)


def golden_invoice(case: GoldenCase) -> ExtractedInvoice:
    """Make the invoice a perfect model would read from a golden document."""
    assert case.printed is not None
    return ExtractedInvoice.from_reply(printed_as_reply(case.printed))


def write_chart(tmp_path: Path, text: str) -> Path:
    """Write a chart-of-accounts file into a folder and return the folder."""
    (tmp_path / "chart_of_accounts.yaml").write_text(text, encoding="utf-8")
    return tmp_path


def lines_of(entry: JournalEntry) -> dict[str, tuple[Decimal, Decimal]]:
    """Return an entry's lines as account -> (debit, credit)."""
    return {line.account: (line.debit, line.credit) for line in entry.lines}


def test_the_real_chart_is_read_and_every_account_it_points_at_exists() -> None:
    """The committed chart passes the strict reader: payable, cash, VAT, rounding and the default are real accounts."""
    loaded = chart()
    codes = {account.code for account in loaded.accounts}
    assert {loaded.payable, loaded.cash, loaded.input_vat, loaded.rounding, loaded.default_expense} <= codes
    assert all(rule.account in codes for rule in loaded.rules)


def test_a_small_chart_is_accepted(tmp_path: Path) -> None:
    """The fixture used by the tests below is itself valid."""
    assert read_chart(write_chart(tmp_path, CHART_TEXT)).expense_for("Green coffee") == "5010"


@pytest.mark.parametrize(
    ("change", "reason"),
    [
        ('payable: "2100"', 'payable: "5010"'),
        ('cash: "1010"', 'cash: "2100"'),
        ('rounding: "5900"', 'rounding: "1010"'),
        ('default_expense: "5090"', 'default_expense: "9999"'),
        ('{ account: "5010", keywords: ["coffee"] }', '{ account: "2100", keywords: ["coffee"] }'),
        ('{ account: "5010", keywords: ["coffee"] }', '{ account: "5900", keywords: ["coffee"] }'),
        ('{ account: "5010", keywords: ["coffee"] }', '{ account: "5010", keywords: [] }'),
        ('{ code: "5090", name: "Other", kind: expense }', '{ code: "5010", name: "Other", kind: expense }'),
        ('{ code: "1010", name: "Cash", kind: asset }', '{ code: "101", name: "Cash", kind: asset }'),
        ("version: 1", "version: 2"),
        ("version: 1", "version: 1\nsurprise: true"),
    ],
)
def test_a_chart_that_contradicts_itself_stops_the_service(tmp_path: Path, change: str, reason: str) -> None:
    """A wrong kind in a place, a missing account, a duplicate code, an empty rule or an unknown key is an error."""
    assert change in CHART_TEXT
    with pytest.raises(DataFileError):
        read_chart(write_chart(tmp_path, CHART_TEXT.replace(change, reason)))


def test_a_missing_chart_is_an_error_that_names_the_file(tmp_path: Path) -> None:
    """No chart, no posting: the reader says which file is missing."""
    with pytest.raises(DataFileError, match=r"chart_of_accounts\.yaml"):
        read_chart(tmp_path)


def test_every_description_in_the_golden_set_has_an_expense_account() -> None:
    """Each of the 72 lines the synthetic documents print goes to an account that exists and is an expense."""
    loaded = chart()
    kinds = {account.code: account.kind for account in loaded.accounts}
    for case in read_golden_set().cases:
        if case.printed is None:
            continue
        for line in case.printed.line_items:
            assert kinds[loaded.expense_for(line.description)] == "expense", line.description


@pytest.mark.parametrize(
    ("description", "code"),
    [
        ("Green coffee Ethiopia Guji, 60 kg bag", "5010"),
        ("Kraft coffee bag 250 g, box of 500", "5020"),
        ("Jute sack, empty (100)", "5020"),
        ("Whole milk 3.5% fat, 1 L (crate of 12)", "5030"),
        ("Freight Hamburg to Brno (pallet)", "5040"),
        ("Diesel (litres)", "5045"),
        ("Espresso machine service, 2 groups (hours)", "5050"),
        ("Ceramic cappuccino cup 180 ml (box of 36)", "5060"),
        ("Tiramisu", "5070"),
        ("Something nobody wrote a rule for", "5090"),
    ],
)
def test_lines_go_to_the_first_rule_that_matches(description: str, code: str) -> None:
    """The keyword rules send a line to the expense account that fits, in the order the rules are written."""
    assert chart().expense_for(description) == code


def test_a_supplier_invoice_debits_the_expenses_and_the_vat_and_credits_the_payable() -> None:
    """The clean sample: two lines, 21% VAT, a payable for the total, and the entry adds up to the cent."""
    case = read_golden_set().case("bohemia-packaging-2026-0412")
    invoice = golden_invoice(case)
    entry = post(invoice, chart())
    assert entry.balanced
    assert entry.currency == "CZK"
    assert entry.day == invoice.issue_date
    assert "Bohemia Packaging" in entry.reference
    posted = lines_of(entry)
    assert posted["2100"] == (Decimal(0), Decimal("10406.00"))
    assert posted["1400"][0] == sum(line.amount for line in invoice.vat)  # type: ignore[misc]
    assert entry.total_debit == entry.total_credit == Decimal("10406.00")


def test_a_credit_note_turns_the_entry_round() -> None:
    """The payable is debited and the expenses and the VAT are credited, for a credit note printed either way round."""
    for identifier in ("credit-hanse-2026-c031", "credit-bohemia-2026-c007"):
        invoice = golden_invoice(read_golden_set().case(identifier))
        entry = post(invoice, chart())
        posted = lines_of(entry)
        assert entry.balanced
        assert posted["2100"][0] == abs(invoice.total)  # type: ignore[arg-type]
        assert posted["2100"][1] == 0
        assert posted["1400"][0] == 0
        assert posted["1400"][1] > 0


def test_a_till_receipt_credits_the_cash_and_takes_the_vat_out_of_prices_that_hold_it() -> None:
    """A handwritten receipt with prices that include VAT: cash is credited, and the expenses are the net."""
    invoice = golden_invoice(read_golden_set().case("hand-pasta-fresca-0023"))
    assert invoice.prices_include_vat is True
    entry = post(invoice, chart())
    posted = lines_of(entry)
    assert entry.balanced
    assert "2100" not in posted
    assert posted["1010"] == (Decimal(0), Decimal("34.00"))
    expenses = sum(debit for account, (debit, _) in posted.items() if account.startswith("5"))
    assert expenses + posted["1400"][0] == Decimal("34.00")
    assert expenses < Decimal("34.00")


def test_every_valid_golden_document_posts_to_a_balanced_entry() -> None:
    """The whole golden set that is meant to be valid: each makes an entry whose debits equal its credits exactly."""
    posted = 0
    for case in read_golden_set().cases:
        if case.expect.outcome != "valid" or case.printed is None:
            continue
        entry = post(golden_invoice(case), chart())
        assert entry.balanced, case.id
        assert entry.total_debit == abs(case.printed.total), case.id
        posted += 1
    assert posted >= 30


def test_a_cent_of_printed_rounding_goes_to_the_rounding_account_either_way() -> None:
    """Lines and VAT a cent short of the total are rounded up with a debit; a cent over, down with a credit."""
    base = {
        "document_type": "invoice",
        "vendor": "Acme",
        "invoice_number": "1",
        "issue_date": "2026-09-01",
        "currency": "CZK",
        "line_items": [{"description": "Green coffee", "quantity": "1", "unit_price": "100.00", "total": "100.00"}],
        "vat": [{"rate": "21", "base": "100.00", "amount": "21.00"}],
    }
    short = post(ExtractedInvoice.model_validate({**base, "total": "121.01"}), chart())
    over = post(ExtractedInvoice.model_validate({**base, "total": "120.99"}), chart())
    assert lines_of(short)["5900"] == (Decimal("0.01"), Decimal(0))
    assert lines_of(over)["5900"] == (Decimal(0), Decimal("0.01"))
    assert short.balanced
    assert over.balanced


def test_a_difference_larger_than_rounding_is_refused() -> None:
    """Two cents out is not rounding: such a document failed its checks and is not posted."""
    invoice = ExtractedInvoice.model_validate(
        {
            "document_type": "invoice",
            "vendor": "Acme",
            "invoice_number": "1",
            "issue_date": "2026-09-01",
            "currency": "CZK",
            "line_items": [{"description": "Green coffee", "quantity": "1", "unit_price": "100.00", "total": "100.00"}],
            "vat": [{"rate": "21", "base": "100.00", "amount": "21.00"}],
            "total": "121.02",
        }
    )
    with pytest.raises(EntryError):
        post(invoice, chart())


def test_a_planted_error_that_breaks_the_total_is_not_posted() -> None:
    """The planted total error of the golden set makes an entry that cannot balance, so no entry is made."""
    invoice = golden_invoice(read_golden_set().case("planted-total-hanse-2026-4700"))
    with pytest.raises(EntryError):
        post(invoice, chart())


def test_a_document_without_a_total_or_a_line_total_is_refused() -> None:
    """Posting needs the numbers: a missing total, or a line with no total, is an error and not a guess."""
    no_total = ExtractedInvoice.model_validate({"issue_date": "2026-09-01", "line_items": [{"total": "1.00"}]})
    with pytest.raises(EntryError):
        post(no_total, chart())
    no_line_total = ExtractedInvoice.model_validate(
        {"total": "1.00", "issue_date": "2026-09-01", "line_items": [{"description": "x"}]}
    )
    with pytest.raises(EntryError):
        post(no_line_total, chart())


def test_sharing_an_amount_among_accounts_always_adds_up_to_the_cent() -> None:
    """However the weights fall, the shares are whole cents and sum to the amount exactly."""
    generator = random.Random(2026)  # noqa: S311 - a seeded generator for test data, not for security
    for _ in range(300):
        weights = {str(code): Decimal(generator.randint(1, 100_000)) / 100 for code in range(generator.randint(1, 6))}
        if not weights:
            continue
        total = Decimal(generator.randint(1, 5_000_000)) / 100
        shares = share_out(total, weights)
        assert sum(shares.values()) == total
        assert all(share == share.quantize(Decimal("0.01")) for share in shares.values())
        assert all(share >= 0 for share in shares.values())


def test_sharing_among_nothing_is_an_error() -> None:
    """With no weights there is nothing to share the amount among."""
    with pytest.raises(EntryError):
        share_out(Decimal("10.00"), {})
