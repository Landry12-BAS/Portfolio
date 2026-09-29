"""Reading the numbers and codes out of a text, the same way in English and in Czech.

The golden set grades a reply by the numbers it must state, and the claim check refuses
a sentence whose numbers its sources don't hold. Both read numbers here, so 1,000 and
1 000 are the same number, 09 is 9, and an order or tracking code stays one token.
"""

import re

# A thousands separator inside a number: the comma in 1,000, or the space in 1 000.
THOUSANDS_SEPARATOR = re.compile(r"(?<=\d)[,\u00a0\u202f ](?=\d{3}(?!\d))")
# The order and tracking codes a text may quote, then plain numbers.
NUMBER_OR_CODE = re.compile(r"BB-\d{4}|VP\d{9}CZ|KC-\d{5}|\d+")


def without_thousands_separators(text: str) -> str:
    """Write every number in a text without thousands separators, so 1,000 and 1 000 both read 1000."""
    return THOUSANDS_SEPARATOR.sub("", text)


def numbers_and_codes(text: str) -> set[str]:
    """Collect the numbers and codes in a text: 1,000 and 1 000 read as 1000, and 09 as 9."""
    found: set[str] = set()
    for token in NUMBER_OR_CODE.findall(without_thousands_separators(text)):
        found.add(str(int(token)) if token.isdigit() else token)
    return found
