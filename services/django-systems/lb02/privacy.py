"""What the concierge lets into a prompt, a transcript or a database: nothing a visitor would regret typing.

A booking asks for an email address, and a visitor may type their real one, or a phone
number, or worse. This is a demo on synthetic data (docs/SECURITY.md), so it is built never
to hold such a thing, rather than to hold it carefully:

- Every visitor message is masked before any model reads it and before it is written to
  the transcript: email addresses become [email], and any run of nine or more digits (a
  phone number, a card, an IBAN) becomes [number]. The model never sees an address, and a
  person who takes over a conversation never sees one either.
- The booking's contact address is read from the visitor's own words by this module, never
  by the model, and only an example address is kept: one at example.com, example.org or
  example.net, or at a domain ending in .test, .example, .invalid or .localhost, which
  RFC 2606 and RFC 6761 reserve so that they can never reach a mailbox. A real address is
  refused (counted, not kept), and the concierge asks for an example one.

The confirmation is a recorded mock in any case; it is never sent anywhere.
"""

import re
from dataclasses import dataclass
from typing import Final

from django.core.exceptions import ValidationError
from django.core.validators import validate_email

# An email address. The parts are bounded, so a hostile message can't make the pattern backtrack out of control.
EMAIL: Final = re.compile(r"[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}")
# A domain name: dotted labels of letters, digits and hyphens, and nothing else.
DOMAIN: Final = re.compile(r"[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}")
# Nine digits or more in a row, perhaps grouped by spaces, dots or hyphens: a phone number, a card, an IBAN.
LONG_NUMBER: Final = re.compile(r"(?<![\w-])\d(?:[ .-]?\d){8,}(?![\w-])")
# The domains the standards reserve for examples, and the top-level domains they reserve.
EXAMPLE_DOMAINS: Final = ("example.com", "example.org", "example.net")
RESERVED_SUFFIXES: Final = (".test", ".example", ".invalid", ".localhost")
# The longest email address there is.
MAX_ADDRESS_LENGTH: Final = 254


@dataclass(frozen=True)
class MaskedMessage:
    """A visitor's message as the rest of the system may see it, and what was found in it."""

    text: str
    # The first example address in the message, in lowercase, or None.
    example_address: str | None
    # How many addresses weren't example addresses: counted, refused, never kept.
    real_addresses: int
    # How many long digit runs were masked.
    numbers: int


def is_example_address(address: str) -> bool:
    """Tell whether an address is one that can never reach a mailbox: a reserved example domain, or a reserved TLD."""
    _, _, domain = address.lower().rpartition("@")
    if not DOMAIN.fullmatch(domain):
        return False
    if domain in EXAMPLE_DOMAINS or any(domain.endswith(f".{base}") for base in EXAMPLE_DOMAINS):
        return True
    return domain.endswith(RESERVED_SUFFIXES)


def is_well_formed(address: str) -> bool:
    """Tell whether an address is one the database's email field would accept."""
    if len(address) > MAX_ADDRESS_LENGTH:
        return False
    try:
        validate_email(address)
    except ValidationError:
        return False
    return True


def mask(text: str) -> MaskedMessage:
    """Replace the addresses and long numbers in a message with labels, and report what was in it.

    The first example address is returned for the booking to keep, and a second one is
    masked and ignored. Every address that isn't an example address is counted as real.
    """
    example_address: str | None = None
    real = 0

    def replace(match: re.Match[str]) -> str:
        """Count an address, keep the first example one, and put a label where it was."""
        nonlocal example_address, real
        address = match.group().lower()
        if is_example_address(address) and is_well_formed(address):
            example_address = example_address or address
        else:
            real += 1
        return "[email]"

    without_addresses = EMAIL.sub(replace, text)
    without_numbers, numbers = LONG_NUMBER.subn("[number]", without_addresses)
    return MaskedMessage(text=without_numbers, example_address=example_address, real_addresses=real, numbers=numbers)
