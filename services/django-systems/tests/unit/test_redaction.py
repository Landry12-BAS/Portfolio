"""Tests for lb01.redaction: personal data leaves a ticket before a model reads it; order data stays."""

import time

import pytest

from lb01.redaction import passes_luhn, redact


@pytest.mark.parametrize(
    ("text", "expected", "label"),
    [
        ("Write to sam.carter@example.com please.", "Write to [email] please.", "email"),
        ("Call +420 777 123 456 today.", "Call [phone] today.", "phone"),
        ("Call 777123456 or 777 123 456.", "Call [phone] or [phone].", "phone"),
        ("Or 00421 905 123 456.", "Or [phone].", "phone"),
        ("Card 4111 1111 1111 1111 was charged.", "Card [card] was charged.", "card"),
        ("Card 4111-1111-1111-1111.", "Card [card].", "card"),
        ("Refund to CZ65 0800 0000 1920 0014 5399.", "Refund to [iban].", "iban"),
    ],
)
def test_personal_data_is_replaced_by_a_label(text: str, expected: str, label: str) -> None:
    """Each kind of personal data becomes its label, and is counted."""
    redaction = redact(text)

    assert redaction.text == expected
    assert redaction.found[label] >= 1


@pytest.mark.parametrize(
    "text",
    [
        "Order BB-1040 hasn't arrived.",
        "Tracking VP481920337CZ, or KC-58213 by courier.",
        "I paid 1 490 Kč, 1,639 CZK with delivery, on 2026-09-28.",
        "The bag says roasted 12. 8. 2026.",
        "A 16-digit number that fails the checksum: 1234 5678 9012 3456.",
    ],
)
def test_order_data_and_ordinary_numbers_stay(text: str) -> None:
    """Order and tracking numbers, prices, dates and numbers that aren't card numbers are kept."""
    redaction = redact(text)

    assert redaction.text == text
    assert redaction.found == {}


def test_only_the_kinds_found_are_counted() -> None:
    """The counts name what was found, for the trace, and nothing else."""
    assert redact("Mail a@b.cz or c@d.cz, call 777 123 456.").found == {"email": 2, "phone": 1}


def test_luhn_tells_card_numbers_from_other_numbers() -> None:
    """A real test card number passes; the same digits with one changed don't."""
    assert passes_luhn("4111 1111 1111 1111")
    assert not passes_luhn("4111 1111 1111 1112")


def test_a_hostile_ticket_cant_make_redaction_slow() -> None:
    """Long runs of near-matches finish quickly: no pattern backtracks out of control."""
    hostile = ("1 " * 20_000) + ("a." * 20_000) + ("+" * 20_000)

    started = time.perf_counter()
    redact(hostile)

    assert time.perf_counter() - started < 2
