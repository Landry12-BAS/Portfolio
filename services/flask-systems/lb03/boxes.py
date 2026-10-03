"""Which words on the page a field came from: the rule that turns an extracted value into a box on the document.

The model gives a value (`1040.60`, `2026-04-12`, `Bohemia Packaging s.r.o.`); OCR gives words with boxes. This
module finds, for each field, the words that print it, so the board can light that box. The rule, in full:

1. **Rows.** The page is turned upright by the median angle of the words' top edges, and the words are grouped
   into rows by their height on it, left to right inside a row. Adjacent words of a row, with a gap no wider
   than one and a half word-heights, form a *window* of one to a few words: `1` and `040,60` are one window.
2. **Match quality**, from 0 to 1, for a window against a field's value, by what kind of field it is:
   - *Amount, quantity, rate:* the window's text, joined, is read as a number in any of the ways people write
     one (money.py `amount_candidates`); if the value is among the meanings, quality is 1. The same digits with
     the opposite sign give 0.9. A number of at least four digits with exactly one digit out gives 0.6, so a
     single misread digit still points at the right place, and says it is unsure. A missing or an extra digit
     is not a near miss: `7.40` beside a column is not the `27.40` it would be if a digit were dropped.
   - *Date:* the value is written every way a document writes a date (ISO, dots, slashes, month names, the
     Czech form) and the window is compared with those; equal gives 1. A date with one digit read as a letter
     (`12.04.2O26`) gives 0.9; a date with a different digit is another date and is not found.
   - *Currency:* the code or one of its symbols (`EUR`, `€`) gives 1.
   - *Text* (vendor, number, description): both sides are lower-cased, stripped of accents and punctuation, and
     compared by the ratio of matching characters (`difflib`); 0.8 or more is accepted. A window that is only the
     start of a long description (at least six characters, half of it) gives 0.9 times the share it covers, so
     a description wrapped over two lines is still found by its first line.
3. **Confidence** of a placement is the mean OCR confidence of its words times its match quality, so a
   perfect match on a faint word and a poor match on a crisp one are both told apart from a sure thing.
4. **Which window** when a value is printed more than once, which is the usual case (the total is in a summary
   box and at the foot; the quantity `1` is everywhere). Each word may serve one field only, and fields claim in
   this order: the header (number, dates, currency, vendor: the topmost best match); the total (the lowest) and
   the subtotal (the lowest above the total); the line items, top to bottom, each after the one before: the
   description first, then its quantity, unit price and total from the *same row* (or the one below), the total
   the rightmost word, so that a unit price equal to the row total gets the left word and the total the right;
   and the VAT rows, after the last line item, the rate first and the base and amount from its row.
5. A field with no window of at least the accepted quality has **no box**. The board says the value was not
   found on the page, which is itself worth knowing: it may be misread, absent, or made up.

The rule is a heuristic and the measurement says how well it does (`just ocr-lb03`, the README). It needs no
model and runs in the service process on the words the worker returned.
"""

import math
import statistics
import unicodedata
from collections.abc import Callable, Collection, Sequence
from dataclasses import dataclass, replace
from datetime import date
from decimal import Decimal
from difflib import SequenceMatcher

from lb03.checks import CheckId, CheckResult, Severity, passed, skipped
from lb03.invoice import ExtractedInvoice, LineItem, VatLine, field_paths, get_field
from lb03.money import amount_candidates, amount_text, cents
from lb03.ocr.protocol import OcrWord, Quad

# The least quality a window needs for a text or a date to count as printing the field.
MIN_TEXT_QUALITY = 0.8
DATE_NEAR_MISS_QUALITY = 0.9
# What a number with the opposite sign, and a number one digit out, are worth. Near misses need this many digits.
OPPOSITE_SIGN_QUALITY = 0.9
NEAR_MISS_QUALITY = 0.6
MIN_NEAR_MISS_DIGITS = 4
# A description cut off at a line's end counts for this much of the share of the description it covers.
PARTIAL_TEXT_WEIGHT = 0.9
MIN_PARTIAL_CHARACTERS = 6
# How many words a window may have, by the kind of value; and how wide a gap may be, in word-heights, inside a window.
MAX_AMOUNT_WORDS = 3
MAX_DATE_WORDS = 4
MAX_TEXT_WORDS = 8
GAP_IN_HEIGHTS = 1.5
# Two words are on one row when their centres are no further apart than this share of the taller one's height.
ROW_SHARE = 0.55
MONTHS = ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")
LONG_MONTHS = (
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
)
CURRENCY_MARKS = {
    "EUR": {"eur", "€", "euro"},
    "CZK": {"czk", "kč", "kc"},
    "USD": {"usd", "$"},
    "GBP": {"gbp", "£"},
    "PLN": {"pln", "zł", "zl"},
    "CHF": {"chf"},
    "HUF": {"huf", "ft"},
}
# The multiplication sign a quantity may carry (`2 x`), made with chr() so the source holds no lookalike characters.
MULTIPLICATION_SIGN = chr(0x00D7)
type Matcher = Callable[[Sequence["Item"]], float]


@dataclass(frozen=True)
class PageWords:
    """The words OCR read from one page, in the order it gave them."""

    number: int
    words: Sequence[OcrWord]


@dataclass(frozen=True)
class Placement:
    """Where a field is printed: its page, the four corners of the words, and how sure the service is."""

    path: str
    page: int
    quad: Quad
    confidence: float
    match: float


@dataclass(frozen=True)
class Item:
    """One OCR word with what the rule needs of it: its upright centre, its height and the row it sits in."""

    page: int
    text: str
    confidence: float
    quad: Quad
    x: float
    y: float
    width: float
    height: float
    row: int = 0


@dataclass(frozen=True)
class Candidate:
    """A window of adjacent words in one row, and how well it matches a value."""

    items: tuple[Item, ...]
    quality: float

    @property
    def order(self) -> tuple[int, int, float]:
        """Return where the window starts in reading order: page, row, then how far right."""
        return (self.items[0].page, self.items[0].row, self.items[0].x)

    @property
    def row(self) -> tuple[int, int]:
        """Return the page and row the window is in."""
        return (self.items[0].page, self.items[0].row)


def normalise(text: str) -> str:
    """Lower-case a text, drop accents and punctuation, and collapse spaces, so two spellings of it compare equal."""
    decomposed = unicodedata.normalize("NFKD", text.casefold())
    letters = "".join(
        character if character.isalnum() else " " for character in decomposed if not unicodedata.combining(character)
    )
    return " ".join(letters.split())


def digits_of(text: str) -> str:
    """Keep only the digits of a text."""
    return "".join(character for character in text if character.isdigit())


def one_digit_substituted(left: str, right: str) -> bool:
    """Tell whether two digit strings of the same length differ in exactly one digit."""
    return len(left) == len(right) and sum(a != b for a, b in zip(left, right, strict=True)) == 1


def page_angle(words: Sequence[OcrWord]) -> float:
    """Return the median angle of the long words' top edges, in radians: how far the page is turned."""
    angles = []
    for word in words:
        left, top, right, top_right = word.quad[0], word.quad[1], word.quad[2], word.quad[3]
        height = math.hypot(word.quad[6] - left, word.quad[7] - top)
        if math.hypot(right - left, top_right - top) > 2 * max(height, 1e-6):
            angles.append(math.atan2(top_right - top, right - left))
    return statistics.median(angles) if angles else 0.0


def upright_items(page: PageWords) -> list[Item]:
    """Make the page's words into items with centres measured on the page turned upright, and group them into rows."""
    angle = page_angle(page.words)
    cosine, sine = math.cos(angle), math.sin(angle)
    raw = []
    for word in page.words:
        xs, ys = word.quad[0::2], word.quad[1::2]
        centre_x, centre_y = sum(xs) / 4, sum(ys) / 4
        upright_x = centre_x * cosine + centre_y * sine
        upright_y = -centre_x * sine + centre_y * cosine
        height = math.hypot(word.quad[6] - word.quad[0], word.quad[7] - word.quad[1])
        width = math.hypot(word.quad[2] - word.quad[0], word.quad[3] - word.quad[1])
        raw.append((upright_y, upright_x, width, height, word))
    raw.sort(key=lambda entry: entry[0])
    items: list[Item] = []
    row = -1
    row_y = -math.inf
    row_height = 0.0
    for upright_y, upright_x, width, height, word in raw:
        if row < 0 or abs(upright_y - row_y) > ROW_SHARE * max(height, row_height):
            row += 1
            row_y, row_height = upright_y, height
        items.append(Item(page.number, word.text, word.confidence, word.quad, upright_x, upright_y, width, height, row))
    return sorted(items, key=lambda item: (item.row, item.x))


def windows(items: Sequence[Item], most_words: int) -> list[tuple[Item, ...]]:
    """List every run of one to `most_words` adjacent words of one row, with no wide gap between neighbours."""
    found: list[tuple[Item, ...]] = []
    for start in range(len(items)):
        run = [items[start]]
        found.append(tuple(run))
        for follower in items[start + 1 :]:
            last = run[-1]
            edge_gap = follower.x - last.x - (last.width + follower.width) / 2
            if follower.page != last.page or follower.row != last.row:
                break
            if edge_gap > GAP_IN_HEIGHTS * max(last.height, follower.height, 1e-6):
                break
            run.append(follower)
            found.append(tuple(run))
            if len(run) >= most_words:
                break
    return found


def text_matcher(value: str) -> Matcher:
    """Match a window against a text by the ratio of matching characters, with credit for a cut-off start."""
    wanted = normalise(value)

    def match(words: Sequence[Item]) -> float:
        """Return the quality of a window as the printing of the text."""
        got = normalise(" ".join(word.text for word in words))
        if not got or not wanted:
            return 0.0
        ratio = SequenceMatcher(None, wanted, got, autojunk=False).ratio()
        if ratio >= MIN_TEXT_QUALITY:
            return ratio
        cut_off = len(got) >= MIN_PARTIAL_CHARACTERS and wanted.startswith(got) and 2 * len(got) >= len(wanted)
        return PARTIAL_TEXT_WEIGHT * len(got) / len(wanted) if cut_off else 0.0

    return match


def is_split_thousands(words: Sequence[Item]) -> bool:
    """Tell whether a window of several words is one number written with a space as its thousands mark."""
    texts = [word.text for word in words]
    first, rest = texts[0].lstrip("-+(€$£"), texts[1:]
    leading = first.isdigit() and 1 <= len(first) <= 3
    middle = all(part.isdigit() and len(part) == 3 for part in rest[:-1])
    last = rest[-1].rstrip(")")
    ends = len(digits_of(last)) >= 3 and last[:3].isdigit()
    return leading and middle and ends


def amount_matcher(value: Decimal) -> Matcher:
    """Match a window against a number, however it is written, with partial credit for a sign or a digit out."""
    wanted = cents(value)

    def match(words: Sequence[Item]) -> float:
        """Return the quality of a window as the printing of the number."""
        if len(words) > 1 and not is_split_thousands(words):
            return 0.0
        text = "".join(word.text for word in words).replace("x", "").replace(MULTIPLICATION_SIGN, "")
        meanings = {cents(candidate) for candidate in amount_candidates(text)}
        if wanted in meanings:
            return 1.0
        if -wanted in meanings:
            return OPPOSITE_SIGN_QUALITY
        digits, wanted_digits = digits_of(text), digits_of(amount_text(abs(wanted)))
        if len(wanted_digits) >= MIN_NEAR_MISS_DIGITS and one_digit_substituted(digits, wanted_digits):
            return NEAR_MISS_QUALITY
        return 0.0

    return match


def date_texts(value: date) -> set[str]:
    """Write a date every way a document might print it, normalised for comparing."""
    day, month, year = value.day, value.month, value.year
    month_short, month_long = MONTHS[month - 1], LONG_MONTHS[month - 1]
    forms = {
        f"{year}-{month:02d}-{day:02d}",
        f"{day:02d}.{month:02d}.{year}",
        f"{day}.{month}.{year}",
        f"{day}. {month}. {year}",
        f"{day:02d}/{month:02d}/{year}",
        f"{day}/{month}/{year}",
        f"{month:02d}/{day:02d}/{year}",
        f"{day} {month_short} {year}",
        f"{day} {month_long} {year}",
        f"{day:02d} {month_short} {year}",
        f"{month_short} {day} {year}",
        f"{month_long} {day} {year}",
        f"{year}/{month:02d}/{day:02d}",
        f"{day:02d}-{month:02d}-{year}",
    }
    return {" ".join(form.replace(",", " ").split()) for form in forms}


def date_matcher(value: date) -> Matcher:
    """Match a window against a date written in any of the usual ways.

    A near miss is a date of which one digit was read as a letter (a zero as `O`, a one as `l`): that is what
    OCR does. A date that differs in a digit from the one asked for is another date, and is not found.
    """
    forms = date_texts(value)

    def match(words: Sequence[Item]) -> float:
        """Return the quality of a window as the printing of the date."""
        got = " ".join(" ".join(word.text.casefold() for word in words).replace(",", " ").split())
        if got in forms:
            return 1.0
        for form in forms:
            differing = [(want, have) for want, have in zip(form, got, strict=False) if want != have]
            if (
                len(form) == len(got)
                and len(differing) == 1
                and differing[0][0].isdigit()
                and not differing[0][1].isdigit()
            ):
                return DATE_NEAR_MISS_QUALITY
        return 0.0

    return match


def currency_matcher(code: str) -> Matcher:
    """Match a window against a currency, by its code or its symbol."""
    marks = CURRENCY_MARKS.get(code, {code.casefold()})

    def match(words: Sequence[Item]) -> float:
        """Return 1 when the window is one of the marks of the currency."""
        return 1.0 if len(words) == 1 and words[0].text.casefold().strip(".,:") in marks else 0.0

    return match


def rate_matcher(value: Decimal) -> Matcher:
    """Match a window against a VAT rate, written `21%`, `21 %` or `21,00 %`."""
    inner = amount_matcher(value)

    def match(words: Sequence[Item]) -> float:
        """Return the quality of a window as the printing of the rate, its percent sign set aside."""
        stripped = tuple(replace(word, text=word.text.replace("%", "")) for word in words if word.text.replace("%", ""))
        return inner(stripped) if stripped else 0.0

    return match


class Locator:
    """Holds the words of a document by rows and which of them a field has already taken."""

    def __init__(self, pages: Sequence[PageWords]) -> None:
        """Group every page's words into rows."""
        self.items = [item for page in pages for item in upright_items(page)]
        self.claimed: set[tuple[int, str, tuple[float, ...]]] = set()
        self.windows_by_size: dict[int, list[tuple[Item, ...]]] = {}

    def is_free(self, window: tuple[Item, ...]) -> bool:
        """Tell whether none of a window's words belongs to a field already placed."""
        return all(self.key(item) not in self.claimed for item in window)

    @staticmethod
    def key(item: Item) -> tuple[int, str, tuple[float, ...]]:
        """Name a word by its page, text and corners, which is unique enough to tell two words apart."""
        return (item.page, item.text, item.quad)

    def candidates(self, matcher: Matcher, most_words: int, *, minimum: float = 0.5) -> list[Candidate]:
        """List the free windows that match, best first within the order of the page."""
        if most_words not in self.windows_by_size:
            self.windows_by_size[most_words] = windows(self.items, most_words)
        found = []
        for window in self.windows_by_size[most_words]:
            if not self.is_free(window):
                continue
            quality = matcher(window)
            if quality >= minimum:
                found.append(Candidate(window, quality))
        return found

    def take(self, path: str, candidate: Candidate) -> Placement:
        """Give a window to a field: nobody else may use its words, and its box is the first word to the last."""
        for item in candidate.items:
            self.claimed.add(self.key(item))
        first, last = candidate.items[0], candidate.items[-1]
        quad: Quad = (
            first.quad[0],
            first.quad[1],
            last.quad[2],
            last.quad[3],
            last.quad[4],
            last.quad[5],
            first.quad[6],
            first.quad[7],
        )
        mean = sum(item.confidence for item in candidate.items) / len(candidate.items)
        return Placement(path, first.page, quad, round(mean * candidate.quality, 4), round(candidate.quality, 4))


def best(candidates: Sequence[Candidate], *, latest: bool = False) -> Candidate | None:
    """Pick the best quality, then the first in reading order (the last when `latest`), then the longer window."""
    if not candidates:
        return None
    top = max(candidate.quality for candidate in candidates)
    leaders = [candidate for candidate in candidates if candidate.quality >= top - 1e-9]
    if latest:
        return max(leaders, key=lambda candidate: (candidate.order, len(candidate.items)))
    return min(leaders, key=lambda candidate: (candidate.order, -len(candidate.items)))


def rightmost(candidates: Sequence[Candidate]) -> Candidate | None:
    """Pick the best quality, and among equals the one furthest right on its row; None when there are none."""
    if not candidates:
        return None
    return max(candidates, key=lambda candidate: (candidate.quality, candidate.order[2]))


def place_header(locator: Locator, invoice: ExtractedInvoice, found: dict[str, Placement]) -> None:
    """Place the number, the dates, the currency and the vendor: the topmost best match of each."""
    if invoice.invoice_number:
        place(locator, found, "invoice_number", text_matcher(invoice.invoice_number), MAX_TEXT_WORDS)
    if invoice.issue_date:
        place(
            locator,
            found,
            "issue_date",
            date_matcher(invoice.issue_date),
            MAX_DATE_WORDS,
            minimum=DATE_NEAR_MISS_QUALITY,
        )
    if invoice.due_date:
        place(
            locator, found, "due_date", date_matcher(invoice.due_date), MAX_DATE_WORDS, minimum=DATE_NEAR_MISS_QUALITY
        )
    if invoice.currency:
        place(locator, found, "currency", currency_matcher(invoice.currency), 1)
    if invoice.vendor:
        place(locator, found, "vendor", text_matcher(invoice.vendor), MAX_TEXT_WORDS)


def place(
    locator: Locator,
    found: dict[str, Placement],
    path: str,
    matcher: Matcher,
    most_words: int,
    *,
    minimum: float = 0.5,
    latest: bool = False,
    before: tuple[int, int] | None = None,
) -> Candidate | None:
    """Find the best free window for one field, give it to the field, and return it (None when there is none)."""
    candidates = locator.candidates(matcher, most_words, minimum=minimum)
    if before is not None:
        candidates = [candidate for candidate in candidates if candidate.row < before] or candidates
    chosen = best(candidates, latest=latest)
    if chosen is not None:
        found[path] = locator.take(path, chosen)
    return chosen


def place_total(locator: Locator, invoice: ExtractedInvoice, found: dict[str, Placement]) -> Candidate | None:
    """Place the total: the lowest match on the document. Returns the window, so the subtotal can go above it."""
    if invoice.total is None:
        return None
    return place(locator, found, "total", amount_matcher(invoice.total), MAX_AMOUNT_WORDS, latest=True)


def place_subtotal(
    locator: Locator, invoice: ExtractedInvoice, found: dict[str, Placement], total: Candidate | None
) -> None:
    """Place the subtotal: the lowest match above the total, among the words the rows and the VAT did not take."""
    if invoice.subtotal is None:
        return
    before = total.row if total is not None else None
    place(locator, found, "subtotal", amount_matcher(invoice.subtotal), MAX_AMOUNT_WORDS, latest=True, before=before)


def row_candidates(candidates: Sequence[Candidate], row: tuple[int, int] | None) -> list[Candidate]:
    """Keep the windows in one row, or in the row below it when the row has none; with no row, keep them all."""
    if row is None:
        return list(candidates)
    same = [candidate for candidate in candidates if candidate.row == row]
    if same:
        return same
    below = (row[0], row[1] + 1)
    return [candidate for candidate in candidates if candidate.row == below]


def place_numbers(
    locator: Locator,
    found: dict[str, Placement],
    prefix: str,
    numbers: Sequence[tuple[str, Decimal | None]],
    row: tuple[int, int] | None,
    after: tuple[int, int] | None,
) -> tuple[int, int] | None:
    """Place a row's numbers in the order given, each in the row (or the one below), after the row before.

    With a row, the best match furthest right is taken, so the order the caller gives (total, unit price,
    quantity) hands the right-most word to the total. With no row, the first match after the row before is taken.
    Returns the last row a number was found in, which anchors the next row only when the row itself was not found.
    """
    used = None
    for name, value in numbers:
        if value is None:
            continue
        candidates = locator.candidates(amount_matcher(value), MAX_AMOUNT_WORDS)
        candidates = [candidate for candidate in candidates if after is None or candidate.row > after]
        in_row = row_candidates(candidates, row)
        chosen = rightmost(in_row) if row else best(in_row)
        if chosen is not None:
            found[f"{prefix}.{name}"] = locator.take(f"{prefix}.{name}", chosen)
            used = chosen.row if used is None else max(used, chosen.row)
    return used


def place_line_item(
    locator: Locator, found: dict[str, Placement], index: int, item: LineItem, after: tuple[int, int] | None
) -> tuple[int, int] | None:
    """Place one line item's description and numbers; return its row, for the next item to start below."""
    prefix = f"line_items.{index}"
    row = None
    if item.description:
        candidates = locator.candidates(text_matcher(item.description), MAX_TEXT_WORDS)
        candidates = [candidate for candidate in candidates if after is None or candidate.row > after]
        chosen = best(candidates)
        if chosen is not None:
            found[f"{prefix}.description"] = locator.take(f"{prefix}.description", chosen)
            row = chosen.row
    numbers = (("total", item.total), ("unit_price", item.unit_price), ("quantity", item.quantity))
    used = place_numbers(locator, found, prefix, numbers, row, after)
    return row or used or after


def place_vat_row(
    locator: Locator, found: dict[str, Placement], index: int, line: VatLine, after: tuple[int, int] | None
) -> tuple[int, int] | None:
    """Place one VAT row: its rate first, then its base and amount from the row the rate is in."""
    prefix = f"vat.{index}"
    row = None
    if line.rate is not None:
        candidates = locator.candidates(rate_matcher(line.rate), MAX_AMOUNT_WORDS)
        candidates = [candidate for candidate in candidates if after is None or candidate.row > after]
        chosen = best(candidates)
        if chosen is not None:
            found[f"{prefix}.rate"] = locator.take(f"{prefix}.rate", chosen)
            row = chosen.row
    used = place_numbers(locator, found, prefix, (("amount", line.amount), ("base", line.base)), row, after)
    return row or used or after


def place_fields(invoice: ExtractedInvoice, pages: Sequence[PageWords]) -> dict[str, Placement]:
    """Find the box of every field of the invoice that is printed on the pages; a field not found has no entry.

    The order is the rule: the header, the total, the line items, the VAT rows, and last the subtotal, which is
    often the same number as a VAT base and is told apart from it only because the rows had their turn first.
    """
    locator = Locator(pages)
    found: dict[str, Placement] = {}
    place_header(locator, invoice, found)
    total = place_total(locator, invoice, found)
    anchor: tuple[int, int] | None = None
    for index, item in enumerate(invoice.line_items):
        anchor = place_line_item(locator, found, index, item, anchor)
    for index, line in enumerate(invoice.vat):
        anchor = place_vat_row(locator, found, index, line, anchor)
    place_subtotal(locator, invoice, found, total)
    return found


# The fields that are not printed as such: the kind of document is a label the model chose, so no box is expected.
UNPRINTED_FIELDS = frozenset({"document_type"})


def expected_paths(invoice: ExtractedInvoice) -> list[str]:
    """List the paths of the fields `place_fields` looks for: those that hold a value and are printed on the page."""
    return [path for path in field_paths(invoice) if path not in UNPRINTED_FIELDS and get_field(invoice, path)]


def check_fields_on_page(
    invoice: ExtractedInvoice, placed: Collection[str], confirmed: Collection[str] = ()
) -> CheckResult:
    """Make the `fields_on_page` warning: which values the invoice holds that were not found among the page's words.

    A value that is not on the page may be misread, absent, or made up by the model, which is worth a look but
    does not stop an export, so this is a warning. A field the visitor typed in by hand is `confirmed` by them,
    and counts as found: it is the visitor's word, not the model's.
    """
    expected = expected_paths(invoice)
    if not expected:
        return skipped(CheckId.FIELDS_ON_PAGE, "The invoice holds no values to look for on the page.")
    missing = [path for path in expected if path not in placed and path not in confirmed]
    if not missing:
        return passed(CheckId.FIELDS_ON_PAGE)
    return CheckResult(
        CheckId.FIELDS_ON_PAGE,
        "failed",
        severity=Severity.WARNING,
        message=f"{len(missing)} of {len(expected)} values were not found among the words read from the page.",
        fields=tuple(missing),
        expected=f"{len(expected)} values on the page",
        actual=f"{len(expected) - len(missing)} found",
    )
