"""Reading the words off a page picture with RapidOCR: text, where it is, and how sure the recogniser is.

RapidOCR runs PaddleOCR's detection and recognition models on ONNX Runtime, on the CPU, and its wheel
carries the models (PP-OCRv6 small for detecting and recognising, and the angle classifier), so nothing is
fetched at run time. This module points the engine at those files by path and so never reaches for the
download code, which would need the network the worker doesn't have.

The models read English and digits well. They do not read Czech letters with a hook or an acute (the
recogniser's alphabet has none of them): they drop the letter, so `Čeština` comes out as `etina`. That is a
property of the bundled models, measured and written in the README, and it is why the vision model sees the
photograph too. The words come back one by one with a box each (RapidOCR's word boxes, split from the line
box in proportion to the characters recognised) and a confidence, and every box is turned into four corners
as shares of the page, which is the form the rest of LB-03 counts in.
"""

import unicodedata
from collections.abc import Sequence
from pathlib import Path
from typing import cast

import numpy as np
import rapidocr
from PIL import Image
from rapidocr import RapidOCR
from rapidocr.utils.output import RapidOCROutput

from lb03.ocr.protocol import MAX_WORD_CHARS, MAX_WORDS_PER_PAGE, OcrWord, Quad

# The recogniser's own cut-off for a line of text. Lower than RapidOCR's 0.5, so a faint or handwritten line is
# kept and carries its low confidence to the board, which says so, instead of vanishing.
TEXT_SCORE = 0.3
MODEL_FILES = {
    "Det.model_path": "PP-OCRv6_det_small.onnx",
    "Cls.model_path": "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
    "Rec.model_path": "PP-OCRv6_rec_small.onnx",
}
# The categories of the characters a word made of nothing else may have: dashes, other punctuation, brackets, currency.
KEPT_SYMBOL_CATEGORIES = frozenset({"Pd", "Po", "Ps", "Pe", "Pc", "Sc"})
# Corners further than this outside the page are not a word on it.
CORNER_RANGE = (-0.5, 1.5)


def bundled_models() -> Path:
    """Return the folder inside the RapidOCR wheel where its models are."""
    return Path(rapidocr.__file__).resolve().parent / "models"


def build_engine(threads: int) -> RapidOCR:
    """Make the OCR engine from the models in the wheel, with no logging, word boxes, and a limited thread pool."""
    models = bundled_models()
    parameters: dict[str, object] = {
        "Global.log_level": "error",
        "Global.return_word_box": True,
        "Global.text_score": TEXT_SCORE,
        "EngineConfig.onnxruntime.intra_op_num_threads": threads,
        "EngineConfig.onnxruntime.inter_op_num_threads": 1,
    }
    for name, file in MODEL_FILES.items():
        path = models / file
        if not path.is_file():
            raise FileNotFoundError(file)
        parameters[name] = str(path)
    return RapidOCR(params=parameters)


def is_meaningful(word: str) -> bool:
    """Say whether a recognised word is text: it holds a letter or a digit, or is only punctuation or a currency sign.

    A speck of dust or a fold in the paper is sometimes read as a block or a bullet; that is not a word.
    """
    if any(character.isalnum() for character in word):
        return True
    return all(unicodedata.category(character) in KEPT_SYMBOL_CATEGORIES for character in word)


def clean_word(text: str) -> str:
    """Make a recognised word safe to keep: printable characters only, trimmed, and not longer than a word may be."""
    cleaned = "".join(character for character in text if character.isprintable()).strip()[:MAX_WORD_CHARS]
    return cleaned if is_meaningful(cleaned) else ""


def quad_of(box: object, width: int, height: int) -> Quad | None:
    """Turn a four-point box in pixels into eight shares of the page, or None when it is not a usable box."""
    points = np.asarray(box, dtype=np.float64)
    if points.shape != (4, 2) or not np.isfinite(points).all():
        return None
    shares = (points / np.array([width, height])).round(5)
    if shares.min() < CORNER_RANGE[0] or shares.max() > CORNER_RANGE[1]:
        return None
    x0, y0, x1, y1, x2, y2, x3, y3 = (float(value) for value in shares.reshape(-1))
    return (x0, y0, x1, y1, x2, y2, x3, y3)


def word_lines(found: RapidOCROutput) -> Sequence[Sequence[tuple[str, float, object]]]:
    """Return the words RapidOCR found as lines of (text, confidence, box).

    RapidOCR's own annotation describes one line, but the attribute holds every line. A blank page is a result
    with no text at all (its `word_results` is then a placeholder of one empty line), so it gives no lines.
    """
    if found.txts is None:
        return ()
    return cast("Sequence[Sequence[tuple[str, float, object]]]", found.word_results)


def read_words(engine: RapidOCR, image: Image.Image) -> list[OcrWord]:
    """Read every word off a page picture, in reading order, each with its box, confidence and line number."""
    width, height = image.size
    found = engine(np.asarray(image.convert("RGB"))[:, :, ::-1].copy())
    if not isinstance(found, RapidOCROutput):
        return []
    words: list[OcrWord] = []
    for line_number, line in enumerate(word_lines(found)):
        for text, score, box in line:
            quad = quad_of(box, width, height)
            cleaned = clean_word(str(text))
            if quad is None or not cleaned:
                continue
            confidence = min(max(float(score), 0.0), 1.0)
            words.append(OcrWord(text=cleaned, confidence=confidence, quad=quad, line=line_number))
            if len(words) >= MAX_WORDS_PER_PAGE:
                return words
    return words
