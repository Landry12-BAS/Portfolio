"""Tests for LB-03's money: Decimal rounding, the one-cent rule, and reading amounts as people write them."""

from decimal import Decimal

import pytest

from lb03.money import (
    amount_candidates,
    amount_text,
    cents,
    parse_amount,
    quantity_text,
    same_amount,
    to_decimal,
    vat_amount,
)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("1040.60", {"1040.60"}),
        ("1,040.60", {"1040.60"}),
        ("1.040,60", {"1040.60"}),
        ("1 040,60", {"1040.60"}),
        ("1" + chr(0x00A0) + "040,60", {"1040.60"}),
        ("1'040.60", {"1040.60"}),
        ("EUR 1040.60", {"1040.60"}),
        ("1040.60EUR", {"1040.60"}),
        ("$1,040.60", {"1040.60"}),
        ("1 040,60 Kč", {"1040.60"}),
        ("-250.00", {"-250.00"}),
        (chr(0x2212) + "250,00", {"-250.00"}),
        ("(250.00)", {"-250.00"}),
        ("1040", {"1040"}),
        ("0,5", {"0.5"}),
        ("1.234.567,89", {"1234567.89"}),
        ("1,234,567", {"1234567"}),
    ],
)
def test_amounts_are_read_in_every_common_form(text: str, expected: set[str]) -> None:
    """Whatever grouping and decimal mark a document uses, the same value is read."""
    assert amount_candidates(text) == {Decimal(value) for value in expected}


def test_a_token_that_could_mean_two_values_means_both() -> None:
    """1.040 is 1.04 or 1,040: both are offered, and parse_amount refuses to guess."""
    assert amount_candidates("1.040") == {Decimal("1.040"), Decimal("1040")}
    assert parse_amount("1.040") is None
    assert parse_amount("1.04") == Decimal("1.04")


@pytest.mark.parametrize(
    "text",
    [
        "",
        "   ",
        "abc",
        "A12",
        "2026-09-14",
        "12/34",
        "1..2",
        "1.,2",
        "1,2,3x4",
        "12 AB 34",
        "1" * 40,
        "9" * 13,
        ".5",
        "5.",
    ],
)
def test_tokens_that_are_not_amounts_are_refused(text: str) -> None:
    """Letters among the digits, dates, malformed separators, huge numbers and bare marks are no amounts."""
    assert amount_candidates(text) == frozenset()


def test_grouping_must_be_in_threes() -> None:
    """1.23.456 is not a number written with dots as thousands marks."""
    assert amount_candidates("1.23.456") == frozenset()
    assert amount_candidates("12.345.678") == {Decimal("12345678")}


def test_rounding_is_half_up_to_the_cent() -> None:
    """The rounding rule is the accountant's: half a cent goes up, on either side of zero's neighbour."""
    assert cents(Decimal("0.005")) == Decimal("0.01")
    assert cents(Decimal("0.004")) == Decimal("0.00")
    assert cents(Decimal("2.675")) == Decimal("2.68")


def test_vat_is_base_times_rate_rounded_to_the_cent() -> None:
    """21% of 7,400 is 1,554, and 7% of 12.34 is 0.8638, which rounds to 0.86."""
    assert vat_amount(Decimal("7400.00"), Decimal("21")) == Decimal("1554.00")
    assert vat_amount(Decimal("12.34"), Decimal("7")) == Decimal("0.86")
    assert vat_amount(Decimal("100"), Decimal("0")) == Decimal("0.00")


def test_amounts_within_one_cent_are_the_same() -> None:
    """The one-cent tolerance accepts a cent either way and refuses two."""
    assert same_amount(Decimal("10.00"), Decimal("10.01"))
    assert same_amount(Decimal("10.00"), Decimal("9.99"))
    assert not same_amount(Decimal("10.00"), Decimal("10.02"))


def test_floats_are_never_involved() -> None:
    """The classic float failure, 0.1 + 0.2, is exact in Decimal and the check sees it as equal."""
    assert same_amount(Decimal("0.1") + Decimal("0.2"), Decimal("0.3"))
    assert 0.1 + 0.2 != 0.3


def test_amount_text_is_the_one_wire_form() -> None:
    """Amounts are written with two places and a dot, quantities without trailing zeros."""
    assert amount_text(Decimal("1040.6")) == "1040.60"
    assert amount_text(Decimal("-0.5")) == "-0.50"
    assert quantity_text(Decimal("4.000")) == "4"
    assert quantity_text(Decimal("0.750")) == "0.75"
    assert quantity_text(Decimal("1E+2")) == "100"


@pytest.mark.parametrize(
    ("value", "expected"),
    [(1040, "1040"), (1040.6, "1040.6"), ("1 040,60", "1040.60"), (Decimal("12.5"), "12.5"), ("-3", "-3")],
)
def test_what_a_model_wrote_becomes_a_decimal(value: object, expected: str) -> None:
    """A model's number, string or float is read as the decimal it prints, never through a binary float."""
    assert to_decimal(value) == Decimal(expected)


@pytest.mark.parametrize("value", [True, None, [], {}, "abc", "1.040", float("nan"), float("inf"), 10**13, "9" * 14])
def test_what_is_not_an_amount_is_refused(value: object) -> None:
    """Booleans, containers, ambiguous or malformed text, NaN, infinity and absurd sizes are not amounts."""
    with pytest.raises(ValueError, match="amount"):
        to_decimal(value)
