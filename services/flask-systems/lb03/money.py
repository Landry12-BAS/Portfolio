"""Money as `Decimal`, never as a float: rounding, the one-cent rule, and reading amounts as people write them.

Every amount LB-03 holds is a `Decimal`. A float cannot hold 0.1 exactly, and an invoice that adds up
on paper must add up in the check, so the arithmetic never goes through one. The rules, stated once:

- An amount is compared at the cent: both sides are rounded half-up to two places first.
- Two amounts are the same when they differ by no more than one cent (`TOLERANCE`). Printed amounts are
  rounded one at a time (each line, each VAT line), so a total can honestly differ by a cent from the
  sum of its parts. The planted errors of the golden set are at least ten cents out.
- A VAT amount is its base times the rate over a hundred, rounded half-up to the cent.

Amounts arrive as text from a model, or from OCR, in whatever form the document printed them:
`1 040,60`, `1.040,60 EUR`, `$1,040.60`, `-250.00`, `(250.00)`. `amount_candidates` reads such a token
and says which values it can mean; a token like `1.040` can mean 1.04 or 1,040, so it can mean both.
"""

import math
import unicodedata
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

# One cent, and the difference two amounts may have and still count as equal.
CENT = Decimal("0.01")
TOLERANCE = CENT
# No amount of a supplier invoice reaches a trillion; a larger number is a misreading, not money.
LARGEST_AMOUNT = Decimal(10) ** 12
# The longest token read as an amount: the number, its separators and a currency mark.
MAX_AMOUNT_CHARS = 28
# Characters that group digits: a space, a no-break space, a narrow no-break space or an apostrophe. They
# are made with chr() because Ruff, rightly, refuses to let lookalikes sit in the source as plain characters.
NO_BREAK_SPACE = chr(0x00A0)
NARROW_NO_BREAK_SPACE = chr(0x202F)
RIGHT_QUOTE = chr(0x2019)
GROUPING = frozenset({" ", NO_BREAK_SPACE, NARROW_NO_BREAK_SPACE, "'", RIGHT_QUOTE})
# Characters a minus sign is written with: hyphen-minus, the minus sign, an en dash.
MINUS_SIGN = chr(0x2212)
EN_DASH = chr(0x2013)
MINUS_SIGNS = frozenset({"-", MINUS_SIGN, EN_DASH})
DIGITS = frozenset("0123456789")
# Short names a currency is written with besides its ISO code and its symbol, in lower case.
CURRENCY_NAMES = frozenset({"kc", "k\u010d", "z\u0142", "zl", "ft", "kr", "eur", "czk", "usd", "gbp"})


def cents(value: Decimal) -> Decimal:
    """Round an amount half-up to two decimal places."""
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def vat_amount(base: Decimal, rate: Decimal) -> Decimal:
    """Return the VAT on `base` at `rate` percent, rounded half-up to the cent."""
    return cents(base * rate / Decimal(100))


def same_amount(left: Decimal, right: Decimal) -> bool:
    """Tell whether two amounts are equal at the cent, give or take the one-cent tolerance."""
    return abs(cents(left) - cents(right)) <= TOLERANCE


def amount_text(value: Decimal) -> str:
    """Write an amount with two decimals and a dot, such as `1040.60`: the one form the API and the exports use."""
    return f"{cents(value):f}"


def quantity_text(value: Decimal) -> str:
    """Write a quantity without trailing zeros, such as `4` or `0.75`."""
    text = f"{value.normalize():f}"
    return text if "." not in text else text.rstrip("0").rstrip(".")


def _is_edge_mark(character: str) -> bool:
    """Tell whether a character may sit beside an amount: a letter, a currency symbol or a space."""
    return character.isalpha() or character.isspace() or unicodedata.category(character) == "Sc"


def _split_marks(text: str) -> tuple[str, str, str]:
    """Split a token into the marks before the number, the rest, and the marks after it."""
    start, end = 0, len(text)
    while start < end and _is_edge_mark(text[start]):
        start += 1
    while end > start and _is_edge_mark(text[end - 1]):
        end -= 1
    return text[:start], text[start:end], text[end:]


def _marks_ok(marks: str) -> bool:
    """Tell whether what sits beside a number is only a currency: symbols, an ISO code, or a known short name.

    A lone letter (`A12`) or a word is an identifier, not a currency, so a token that carries one is no amount.
    """
    words = marks.split()
    if len(words) > 2:
        return False
    for word in words:
        symbols = all(unicodedata.category(character) == "Sc" for character in word)
        iso_code = len(word) == 3 and word.isascii() and word.isupper()
        if not (symbols or iso_code or word.lower().rstrip(".") in CURRENCY_NAMES):
            return False
    return True


def _sign_and_core(text: str) -> tuple[bool, str] | None:
    """Split a token into whether it is negative and its digits with separators, or None when it is no amount.

    A minus in front, or the whole number in parentheses (an accountant's way of writing a negative),
    makes it negative. Beside the number only a currency may stand, and inside it only digits, separators
    and grouping marks, or the token is refused.
    """
    negative = False
    stripped = text.strip()
    for _ in range(3):
        lead, body, trail = _split_marks(stripped)
        if not (_marks_ok(lead) and _marks_ok(trail)):
            return None
        stripped = body
        if stripped.startswith("(") and stripped.endswith(")"):
            negative = True
            stripped = stripped[1:-1].strip()
        elif stripped and stripped[0] in MINUS_SIGNS:
            negative = True
            stripped = stripped[1:].strip()
        else:
            break
    if not stripped or stripped[0] not in DIGITS or stripped[-1] not in DIGITS:
        return None
    if any(character not in DIGITS and character not in ".," and character not in GROUPING for character in stripped):
        return None
    return negative, "".join(character for character in stripped if character not in GROUPING)


def _grouped_ok(integer: str, separator: str) -> bool:
    """Tell whether an integer part grouped with `separator` has groups of three digits after the first."""
    groups = integer.split(separator)
    return 1 <= len(groups[0]) <= 3 and all(len(group) == 3 for group in groups[1:])


def _values_of(core: str) -> set[Decimal]:
    """Read the digits and separators of an amount: the values it can mean, none for a malformed one."""
    if ".." in core or ",," in core or ".," in core or ",." in core:
        return set()
    has_dot, has_comma = "." in core, "," in core
    try:
        if has_dot and has_comma:
            last = max(core.rfind("."), core.rfind(","))
            decimal_mark, grouping_mark = core[last], "," if core[last] == "." else "."
            integer, fraction = core[:last], core[last + 1 :]
            if decimal_mark in integer or not _grouped_ok(integer, grouping_mark):
                return set()
            return {Decimal(f"{integer.replace(grouping_mark, '')}.{fraction}")}
        if has_dot or has_comma:
            mark = "." if has_dot else ","
            if core.count(mark) > 1:
                return {Decimal(core.replace(mark, ""))} if _grouped_ok(core, mark) else set()
            integer, fraction = core.split(mark)
            if len(fraction) == 3 and 1 <= len(integer) <= 3:
                return {Decimal(integer + fraction), Decimal(f"{integer}.{fraction}")}
            return {Decimal(f"{integer}.{fraction}")}
        return {Decimal(core)}
    except InvalidOperation:
        return set()


def amount_candidates(text: str) -> frozenset[Decimal]:
    """Return every value a token can mean as an amount: none when it is no amount, two when it is ambiguous.

    `1.040,60` is 1040.60 and `1,040.60` is the same, `1 040,60` and `$1040.60` too, `(250.00)` and
    `-250.00` are both minus 250. `1.040` could be one and a bit or one thousand and forty, so it is
    both. A token with letters among its digits (`A12`, `2026-09-14`) is no amount. Values over a
    trillion are refused as misreadings.
    """
    if not 1 <= len(text.strip()) <= MAX_AMOUNT_CHARS:
        return frozenset()
    split = _sign_and_core(text)
    if split is None:
        return frozenset()
    negative, core = split
    values = _values_of(core)
    if negative:
        values = {-value for value in values}
    return frozenset(value for value in values if abs(value) < LARGEST_AMOUNT)


def parse_amount(text: str) -> Decimal | None:
    """Read one amount from text, or return None when it is no amount or could mean two values."""
    candidates = amount_candidates(text)
    if len(candidates) != 1:
        return None
    return next(iter(candidates))


def to_decimal(value: object) -> Decimal:
    """Turn what a model wrote for an amount (a number or a string) into a Decimal, or raise ValueError.

    A float is read through its shortest text (`1040.6`), not its binary value. A string is read as an
    amount in any of the forms above, and refused when it could mean two. A boolean is not an amount.
    """
    if isinstance(value, bool):
        raise ValueError("A true or false value is not an amount.")
    if isinstance(value, int):
        parsed: Decimal | None = Decimal(value)
    elif isinstance(value, float):
        parsed = parse_amount(repr(value)) if math.isfinite(value) else None
    elif isinstance(value, Decimal):
        parsed = value if value.is_finite() else None
    elif isinstance(value, str):
        parsed = parse_amount(value)
    else:
        parsed = None
    if parsed is None or abs(parsed) >= LARGEST_AMOUNT:
        raise ValueError("This is not an amount.")
    return parsed
