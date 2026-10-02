"""Helpers LB-03's tests share: made-up OCR pages, and a fake of the gateway's injection check.

A page is rows of words at heights and positions, laid out like a document, so a test can set up one situation
(a total printed twice, a page turned a few degrees) and say what must come of it without running OCR.
"""

import math
from dataclasses import dataclass, field

from lb03.boxes import PageWords
from lb03.ocr.protocol import OcrWord
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
