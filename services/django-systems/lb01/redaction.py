"""Removes the personal data a customer types into a ticket before any model reads it.

Customers paste email addresses, phone numbers, bank details and even card numbers into
support tickets. None of it helps a draft, so each is replaced with a label such as
[email] before the ticket reaches the gateway. The original stays on the ticket for the
person at the agent console, and is deleted with it after 24 hours. Order and tracking
numbers are kept: the order tool needs them.

The patterns are simple and bounded, so a hostile ticket can't make them backtrack out
of control. Names and street addresses can't be found reliably by a pattern, so they
stay; only providers that never train on inputs read visitor tickets (routing.yaml).
"""

import re
from collections import Counter
from dataclasses import dataclass

# An email address.
EMAIL = re.compile(r"[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}")
# An IBAN whose account part is all digits, as Czech and Slovak ones are: a country code,
# two check digits, then groups of four digits. Letters in the account part would also
# match tracking numbers such as VP481920337CZ, which must stay.
IBAN = re.compile(r"\b[A-Z]{2}\d{2}(?: ?\d{4}){2,7}(?: ?\d{1,4})?\b")
# Something shaped like a card number: 13 to 19 digits, perhaps grouped by spaces or hyphens.
CARD_SHAPED = re.compile(r"(?<![\w-])\d(?:[ -]?\d){12,18}(?![\w-])")
# A phone number: an optional international prefix, then 9 or 10 digits in groups of three.
PHONE = re.compile(r"(?<![\w+-])(?:(?:\+|00)\d{1,3}[ .-]?)?\d{3}[ .-]?\d{3}[ .-]?\d{3,4}(?![\w-])")


@dataclass(frozen=True)
class Redaction:
    """A ticket's text with its personal data replaced, and how many of each kind were found."""

    text: str
    found: dict[str, int]


def redact(text: str) -> Redaction:
    """Replace email addresses, IBANs, card numbers and phone numbers with labels such as [email]."""
    found: Counter[str] = Counter()
    text = replace_each(EMAIL, text, "email", found)
    text = replace_each(IBAN, text, "iban", found)
    text = replace_cards(text, found)
    text = replace_each(PHONE, text, "phone", found)
    return Redaction(text=text, found={label: count for label, count in found.items() if count})


def replace_each(pattern: re.Pattern[str], text: str, label: str, found: Counter[str]) -> str:
    """Replace every match of `pattern` with `[label]`, counting them in `found`."""
    replaced, count = pattern.subn(f"[{label}]", text)
    found[label] += count
    return replaced


def replace_cards(text: str, found: Counter[str]) -> str:
    """Replace the card-shaped numbers that pass the Luhn check, which real card numbers do."""
    pieces: list[str] = []
    last = 0
    for match in CARD_SHAPED.finditer(text):
        if passes_luhn(match.group()):
            pieces.append(text[last : match.start()])
            pieces.append("[card]")
            found["card"] += 1
            last = match.end()
    pieces.append(text[last:])
    return "".join(pieces)


def passes_luhn(number: str) -> bool:
    """Tell whether a number's digits pass the Luhn checksum that card numbers carry."""
    digits = [int(character) for character in number if character.isdigit()]
    total = 0
    for position, digit in enumerate(reversed(digits)):
        if position % 2 == 1:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
    return total % 10 == 0
