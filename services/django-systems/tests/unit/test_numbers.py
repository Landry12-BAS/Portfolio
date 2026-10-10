"""Tests for lb01.numbers: numbers and codes read the same in English and Czech."""

from lb01.numbers import numbers_and_codes


def test_both_languages_number_styles_read_the_same() -> None:
    """1,000 and 1 000 read as 1000, codes stay whole, and digits inside words still count."""
    found = numbers_and_codes("Free from 1,000 CZK (1\u00a0000 Kč). Order BB-1041, VP481937721CZ, a 24-month warranty.")

    assert found == {"1000", "BB-1041", "VP481937721CZ", "24"}


def test_leading_zeros_dont_make_a_different_number() -> None:
    """An ISO date's 09 and a reply's 9 are the same day of the month."""
    assert numbers_and_codes("delivered 2026-09-05") == numbers_and_codes("delivered on 5. 9. 2026")


def test_a_text_without_numbers_has_none() -> None:
    """Words alone hold no numbers."""
    assert numbers_and_codes("Thank you for writing to us.") == set()
