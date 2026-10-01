"""Tests for LB-02's own wording: every receipt exists in English and Czech, and none can go out with a hole."""

import re
import string
from datetime import UTC, datetime

import pytest

from lb02.messages import (
    EN_DASH,
    MODEL_WRITES_IN_OTHER_LANGUAGES,
    NO_BREAK_SPACE,
    TEMPLATES,
    Receipt,
    guests,
    has_wording,
    render,
    typeset_czech,
    when_text,
)

FACTS = {
    "offering": "Cupping session",
    "when": f"Fri 2 Oct, 14:30{EN_DASH}15:30",
    "party": "2 guests",
    "minutes": 5,
    "code": "K7QW-39XD",
    "to": "jana@example.test",
    "limit": 30,
}


def placeholders(wording: str) -> set[str]:
    """List the facts a piece of wording asks for."""
    return {field for _, field, _, _ in string.Formatter().parse(wording) if field}


@pytest.mark.parametrize("language", ["en", "cs"])
def test_every_receipt_has_wording_in_english_and_czech(language: str) -> None:
    """No receipt is missing from either language."""
    assert set(TEMPLATES[language]) == set(Receipt)


def test_both_languages_ask_for_the_same_facts() -> None:
    """A Czech receipt needs exactly what the English one does, so a caller can fill either."""
    for receipt in Receipt:
        assert placeholders(TEMPLATES["en"][receipt]) == placeholders(TEMPLATES["cs"][receipt]), receipt


@pytest.mark.parametrize("language", ["en", "cs", "de"])
def test_every_receipt_renders_with_its_facts(language: str) -> None:
    """With the facts given, each receipt becomes plain text with nothing left unfilled."""
    for receipt in Receipt:
        text = render(receipt, language, **FACTS)
        assert text
        assert "{" not in text
        assert "}" not in text


def test_a_receipt_with_a_missing_fact_fails_instead_of_going_out_with_a_hole() -> None:
    """The booking receipt can't be written without the code."""
    facts = {name: value for name, value in FACTS.items() if name != "code"}

    with pytest.raises(KeyError):
        render(Receipt.BOOKING_CONFIRMED, "en", **facts)


def test_the_confirmation_says_the_email_is_never_sent() -> None:
    """Both languages tell the visitor that the demo sends no real email, and carry the code."""
    english = render(Receipt.BOOKING_CONFIRMED, "en", **FACTS)
    czech = render(Receipt.BOOKING_CONFIRMED, "cs", **FACTS)

    assert "never sends real email" in english
    assert "neposílá" in czech
    assert "K7QW-39XD" in english
    assert "K7QW-39XD" in czech


def test_a_language_without_wording_gets_english_or_leaves_the_receipt_to_the_model() -> None:
    """Notices fall back to English; the receipts that state a booking fact are the model's to write."""
    assert render(Receipt.INJECTION_REFUSED, "de") == TEMPLATES["en"][Receipt.INJECTION_REFUSED]
    for receipt in Receipt:
        assert has_wording(receipt, "cs")
        assert has_wording(receipt, "en")
        assert has_wording(receipt, "de") is (receipt not in MODEL_WRITES_IN_OTHER_LANGUAGES)


def test_czech_text_never_ends_a_line_on_a_one_letter_word() -> None:
    """A space after k, s, v, z, a, i, o or u becomes a non-breaking space, in any case."""
    assert typeset_czech("jdu k lékaři a v pátek s kamarády") == (
        f"jdu k{NO_BREAK_SPACE}lékaři a{NO_BREAK_SPACE}v{NO_BREAK_SPACE}pátek s{NO_BREAK_SPACE}kamarády"
    )
    assert typeset_czech("V pátek") == f"V{NO_BREAK_SPACE}pátek"
    assert typeset_czech("na stole") == "na stole"


def test_every_czech_receipt_leaves_no_one_letter_word_before_a_plain_space() -> None:
    """After typesetting, no one-letter word is followed by an ordinary space."""
    for receipt in Receipt:
        text = render(receipt, "cs", **FACTS)
        assert not re.search(r"(?<!\w)[KkSsVvZzAaIiOoUu] ", text), receipt


@pytest.mark.parametrize(
    ("count", "english", "czech"),
    [(1, "1 guest", "1 osobu"), (2, "2 guests", "2 osoby"), (4, "4 guests", "4 osoby"), (5, "5 guests", "5 osob")],
)
def test_party_sizes_use_each_languages_plural(count: int, english: str, czech: str) -> None:
    """One, two to four, and five or more, as Czech counts them."""
    assert guests(count, "en") == english
    assert guests(count, "cs") == czech


def test_times_are_written_on_the_roasterys_clock_in_each_language() -> None:
    """08:00 UTC in October is 10:00 in Prague; Czech names the day and the month as Czech does."""
    start = datetime(2026, 10, 2, 12, 30, tzinfo=UTC)
    end = datetime(2026, 10, 2, 13, 30, tzinfo=UTC)

    assert when_text(start, end, "en") == f"Fri 2 Oct, 14:30{EN_DASH}15:30"
    assert when_text(start, end, "cs") == f"pá 2. 10., 14:30{EN_DASH}15:30"
    assert when_text(start, end, "de") == when_text(start, end, "en")
