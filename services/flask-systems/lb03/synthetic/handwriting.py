"""A receipt written by hand: the till receipt's layout, drawn one letter at a time in a handwriting font.

The font is Reenie Beanie (SIL Open Font License 1.1, in data/seed/lb03/fonts with its licence). Each letter
is drawn on its own, turned a few degrees and set a little off the baseline, in ink that varies from one
stroke to the next, on paper with ruled lines and a coffee ring, and then the page is photographed like any
other (lb03/synthetic/photo.py). It is the hardest document the golden set has, and the one the vision
model is there for: the OCR that ships with the service is trained on print.

The layout is the receipt's (lb03/synthetic/layout.py), measured with this font, so the amounts line up on
the right as a person who ruled a margin would have made them. The boxes come from where the letters landed.
This is development tooling.
"""

import math
from functools import cache
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray
from PIL import Image, ImageDraw, ImageFont

from lb03.golden import Printed, Render
from lb03.synthetic.layout import Page, receipt
from lb03.synthetic.words import words_of_run

PIXELS_PER_POINT = 2.6
# Reenie Beanie is small on its em square: the type is scaled up so a line reads as the size of a receipt's.
HAND_SCALE = 1.9
PAPER = (250, 246, 232)
INK = (24, 30, 92)
LINES = (196, 214, 232)


@cache
def hand_font(path: str, pixels: int) -> ImageFont.FreeTypeFont:
    """Open the handwriting font at a size in pixels, once for each size."""
    return ImageFont.truetype(path, pixels)


class HandMeasurer:
    """Measures text in the handwriting font, in the points the layout counts in."""

    def __init__(self, font_path: Path) -> None:
        """Measure with the font at this path."""
        self.font_path = str(font_path)

    def width(self, text: str, font: str, size: float) -> float:  # noqa: ARG002 - the Measurer signature
        """Return the width of `text` in points; `font` is ignored, since the whole page is one hand."""
        pixels = max(round(size * PIXELS_PER_POINT * HAND_SCALE), 4)
        return float(hand_font(self.font_path, pixels).getlength(text)) / PIXELS_PER_POINT


def paper(width: int, height: int, rng: np.random.Generator) -> Image.Image:
    """Make the sheet: warm paper, ruled lines, a margin line, a coffee ring, and a speckle."""
    canvas = Image.new("RGB", (width, height), PAPER)
    draw = ImageDraw.Draw(canvas)
    step = round(24 * PIXELS_PER_POINT / 2.6 * 1.2)
    for y in range(step * 2, height, step):
        draw.line([(0, y), (width, y)], fill=LINES, width=2)
    draw.line([(round(width * 0.075), 0), (round(width * 0.075), height)], fill=(232, 170, 170), width=2)
    centre = (round(width * rng.uniform(0.55, 0.8)), round(height * rng.uniform(0.65, 0.9)))
    radius = round(width * 0.14)
    draw.ellipse(
        [centre[0] - radius, centre[1] - radius, centre[0] + radius, centre[1] + radius],
        outline=(214, 190, 150),
        width=4,
    )
    speckle = rng.normal(0, 3, (height, width, 1))
    return Image.fromarray(np.clip(np.asarray(canvas).astype(np.float64) + speckle, 0, 255).astype(np.uint8), "RGB")


def write_letter(
    canvas: Image.Image,
    character: str,
    font: ImageFont.FreeTypeFont,
    x: float,
    baseline: float,
    rng: np.random.Generator,
) -> float:
    """Write one letter, turned a little and set off the baseline, and return how far to move on."""
    advance = float(font.getlength(character))
    if character == " ":
        return advance
    ascent, descent = font.getmetrics()
    tile = Image.new("L", (round(advance) + 24, ascent + descent + 24), 0)
    ImageDraw.Draw(tile).text((12, 12 + ascent), character, font=font, fill=255, anchor="ls")
    turned = tile.rotate(float(rng.normal(0, 2.2)), resample=Image.Resampling.BICUBIC, center=(12, 12 + ascent))
    shade = float(rng.uniform(0.82, 1.0))
    ink = tuple(round(channel * shade) for channel in INK)
    canvas.paste(ink, (round(x - 12), round(baseline - ascent - 12 + rng.normal(0, 1.4))), turned)
    return advance + float(rng.normal(0, 0.6))


def write_run(
    canvas: Image.Image, text: str, left: float, top: float, size: float, font_path: str, rng: np.random.Generator
) -> tuple[float, float, float, float]:
    """Write a run of text with its top-left corner at a position, in pixels; return the box the ink covers."""
    font = hand_font(font_path, max(round(size * PIXELS_PER_POINT * HAND_SCALE), 4))
    ascent, descent = font.getmetrics()
    baseline = top + ascent * 0.92
    x = left
    for character in text:
        x += write_letter(canvas, character, font, x, baseline + float(rng.normal(0, 0.8)), rng)
    return left - 2, baseline - ascent * 0.86, x + 2, baseline + descent * 0.6


def pen_line(draw: ImageDraw.ImageDraw, x0: float, y0: float, x1: float, y1: float, rng: np.random.Generator) -> None:
    """Draw a wobbly dashed pen line, the receipt's rule."""
    length = math.hypot(x1 - x0, y1 - y0)
    steps = max(int(length / 14), 1)
    for step in range(steps):
        start, end = step / steps, (step + 0.55) / steps
        wobble = float(rng.normal(0, 1.2))
        draw.line([(x0 + (x1 - x0) * start, y0 + wobble), (x0 + (x1 - x0) * end, y0 + wobble)], fill=INK, width=3)


def draw_handwritten(
    printed: Printed, render: Render, font_path: Path
) -> tuple[NDArray[Any], list[tuple[str, NDArray[Any]]], list[tuple[str, NDArray[Any]]]]:
    """Write the receipt by hand; return the flat page as pixels, each printed field's box and each word's box.

    Boxes are four corners in pixels, from where the letters really landed.
    """
    rng = np.random.default_rng(np.random.PCG64(render.seed))
    measurer = HandMeasurer(font_path)
    page: Page = receipt(printed, render, measurer, font="hand", bold="hand", scale=1.0)[0]
    width, height = round(page.width * PIXELS_PER_POINT), round(page.height * PIXELS_PER_POINT)
    canvas = paper(width, height, rng)
    draw = ImageDraw.Draw(canvas)
    fields: list[tuple[str, NDArray[Any]]] = []
    words: list[tuple[str, NDArray[Any]]] = []
    for rule in page.rules:
        pen_line(
            draw,
            rule.x0 * PIXELS_PER_POINT,
            rule.y0 * PIXELS_PER_POINT,
            rule.x1 * PIXELS_PER_POINT,
            rule.y1 * PIXELS_PER_POINT,
            rng,
        )
    for run in page.runs:
        left, top, right, bottom = write_run(
            canvas, run.text, run.x * PIXELS_PER_POINT, run.y * PIXELS_PER_POINT, run.size, str(font_path), rng
        )
        if run.field is not None:
            fields.append(
                (run.field, np.array([[left, top], [right, top], [right, bottom], [left, bottom]], dtype=np.float32))
            )
        for word in words_of_run(run, measurer, ink=(left / PIXELS_PER_POINT, right / PIXELS_PER_POINT)):
            x0, x1 = word.left * PIXELS_PER_POINT, (word.left + word.width) * PIXELS_PER_POINT
            words.append((word.text, np.array([[x0, top], [x1, top], [x1, bottom], [x0, bottom]], dtype=np.float32)))
    return np.asarray(canvas, dtype=np.uint8), fields, words
