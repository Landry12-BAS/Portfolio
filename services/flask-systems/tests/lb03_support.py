"""Helpers LB-03's tests share: made-up OCR pages, and a fake of the gateway's injection check.

A page is rows of words at heights and positions, laid out like a document, so a test can set up one situation
(a total printed twice, a page turned a few degrees) and say what must come of it without running OCR.
"""

import asyncio
import io
import math
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from PIL import Image

from lb03.boxes import PageWords
from lb03.invoice import ExtractedInvoice
from lb03.money import amount_text, quantity_text
from lb03.ocr.pool import OcrError, PageReading, Reading
from lb03.ocr.protocol import OcrWord, SandboxReport
from lb_common.gateway import GuardVerdict

ROW_HEIGHT = 0.012
LETTER_WIDTH = 0.011


def quad_at(x: float, y: float, width: float, height: float = ROW_HEIGHT, tilt: float = 0.0) -> tuple[float, ...]:
    """Make the four corners of a box at a position, turned about the page's origin by `tilt` radians."""
    corners = [(x, y), (x + width, y), (x + width, y + height), (x, y + height)]
    cosine, sine = math.cos(tilt), math.sin(tilt)
    turned = [(cx * cosine - cy * sine, cx * sine + cy * cosine) for cx, cy in corners]
    return tuple(round(value, 6) for corner in turned for value in corner)


def row(y: float, *cells: tuple[str, float], confidence: float = 0.99, tilt: float = 0.0) -> list[OcrWord]:
    """Make a row of words: each cell is a text and its left edge, and its width follows from its length."""
    return [
        OcrWord(
            text=text,
            confidence=confidence,
            quad=quad_at(x, y, LETTER_WIDTH * len(text), tilt=tilt),
            line=0,
        )
        for text, x in cells
    ]


def sentence(y: float, x: float, text: str, confidence: float = 0.99) -> list[OcrWord]:
    """Make the words of a sentence printed in one line, each a space (a few thousandths) after the one before."""
    cells = []
    for word in text.split():
        cells.append((word, x))
        x += LETTER_WIDTH * len(word) + 0.006
    return row(y, *cells, confidence=confidence)


def page(*rows: list[OcrWord], number: int = 1) -> PageWords:
    """Gather rows of words into a page."""
    return PageWords(number, [word for line in rows for word in line])


def verdict(flagged: bool = False, score: float = 0.01) -> GuardVerdict:
    """Make the gateway's answer to an injection check: flagged or not, with the classifier's score."""
    return GuardVerdict(flagged=flagged, score=score, threshold=0.9, segments=1)


@dataclass
class FakeGuard:
    """Stands in for the gateway's injection check: answers from a script, and remembers every text it was asked about.

    A scripted answer that is an exception is raised, as the gateway's errors are. With no script left it says
    the text is clean.
    """

    answers: list[GuardVerdict | Exception] = field(default_factory=list)
    texts: list[str] = field(default_factory=list)

    def check(self, text: str) -> GuardVerdict:
        """Return the next scripted verdict (or raise it), remembering the text."""
        self.texts.append(text)
        if not self.answers:
            return verdict()
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


def invoice_page(invoice: ExtractedInvoice, number: int = 1) -> PageWords:
    """Lay an invoice out as a perfect OCR would read it: header rows, a table, a subtotal, the VAT and the total.

    Every value the invoice holds is printed once in its own place, so the box rule finds all of them; a test that
    wants a value missing from the page changes the invoice after laying it out.
    """
    rows: list[list[OcrWord]] = []
    if invoice.vendor:
        rows.append(sentence(0.05, 0.07, invoice.vendor))
    if invoice.invoice_number:
        rows.append(row(0.09, ("Invoice", 0.60), ("no.", 0.69), (invoice.invoice_number, 0.75)))
    if invoice.issue_date:
        rows.append(row(0.12, ("Issued", 0.60), (invoice.issue_date.isoformat(), 0.75)))
    if invoice.due_date:
        rows.append(row(0.14, ("Due", 0.60), (invoice.due_date.isoformat(), 0.75)))
    if invoice.currency:
        rows.append(row(0.16, ("Currency", 0.60), (invoice.currency, 0.75)))
    rows.append(row(0.30, ("Description", 0.07), ("Qty", 0.55), ("Unit", 0.67), ("Total", 0.85)))
    y = 0.34
    for item in invoice.line_items:
        cells: list[tuple[str, float]] = []
        if item.quantity is not None:
            cells.append((quantity_text(item.quantity), 0.56))
        if item.unit_price is not None:
            cells.append((amount_text(item.unit_price), 0.67))
        if item.total is not None:
            cells.append((amount_text(item.total), 0.86))
        rows.append(sentence(y, 0.07, item.description) + row(y, *cells))
        y += 0.03
    y += 0.02
    if invoice.subtotal is not None:
        rows.append(row(y, ("Subtotal", 0.70), (amount_text(invoice.subtotal), 0.85)))
        y += 0.03
    for line in invoice.vat:
        cells = [("VAT", 0.07)]
        if line.rate is not None:
            cells.append((f"{quantity_text(line.rate)}%", 0.20))
        if line.base is not None:
            cells.append((amount_text(line.base), 0.30))
        if line.amount is not None:
            cells.append((amount_text(line.amount), 0.45))
        rows.append(row(y, *cells))
        y += 0.03
    if invoice.total is not None:
        rows.append(row(y, ("Total", 0.70), (amount_text(invoice.total), 0.85)))
    return page(*rows, number=number)


def tiny_jpeg() -> bytes:
    """Make a small real JPEG, which is what a page picture is."""
    buffer = io.BytesIO()
    Image.new("RGB", (60, 80), "white").save(buffer, "JPEG")
    return buffer.getvalue()


@dataclass
class FakeReader:
    """Stands in for the OCR pool: returns the pages it is given, after a delay, or raises the error it is given.

    It awaits `on_start` first, as the pool does once it has a free worker, so the queue step and the state
    change to `ocr` happen where they do in production.
    """

    pages: list[PageWords]
    kind: str = "pdf"
    delay: float = 0.0
    error: OcrError | None = None
    with_picture: bool = False
    seen: list[bytes] = field(default_factory=list)

    async def read(self, data: bytes, on_start: Callable[[], Awaitable[None]] | None = None) -> Reading:
        """Pretend to read a file: note it, announce the start, wait, then answer."""
        self.seen.append(data)
        if on_start is not None:
            await on_start()
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error is not None:
            raise self.error
        pages = tuple(
            PageReading(number=page.number, width=1000, height=1400, words=tuple(page.words), picture=tiny_jpeg())
            for page in self.pages
        )
        return Reading(
            kind=self.kind,
            pages=pages,
            model_picture=tiny_jpeg() if self.with_picture else None,
            sandbox=SandboxReport(rlimits=True, no_new_privileges=True, seccomp=True, landlock_abi=7),
            worker_ms=round(self.delay * 1000),
            wall_ms=round(self.delay * 1000),
        )
