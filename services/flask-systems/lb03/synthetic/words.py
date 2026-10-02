"""The words of a synthetic document, each with its own box: the ground truth the OCR measurement counts against.

A layout places runs of text (lb03/synthetic/layout.py), and a run may hold several words. OCR is judged
word by word, so a run is cut at its spaces, and each word gets the slice of the run's box it covers,
measured with the same font that drew the run. For a photograph the slices are carried through the same
geometric steps as the field boxes (lb03/synthetic/photo.py), so a word's ground-truth box on a crumpled,
tilted receipt is as exact as on the flat page. This is development tooling; the service never imports it.
"""

from dataclasses import dataclass

from lb03.synthetic.layout import Measurer, Run


@dataclass(frozen=True)
class WordBox:
    """One printed word and the box it covers: its left edge, top edge, width and height, in the page's own units."""

    text: str
    left: float
    top: float
    width: float
    height: float


def words_of_run(run: Run, measurer: Measurer, ink: tuple[float, float] | None = None) -> list[WordBox]:
    """Cut a run at its spaces, giving each word the part of the run's box it covers.

    `ink`, when it is given, is the left and right edge the run really covers (handwriting wanders off the
    measured width), and the slices are stretched to fit it.
    """
    left, width = (run.x, run.width) if ink is None else (ink[0], ink[1] - ink[0])
    measured = measurer.width(run.text, run.font, run.size)
    stretch = width / measured if measured > 0 else 1.0
    boxes = []
    position = 0
    for token in run.text.split():
        start = run.text.index(token, position)
        position = start + len(token)
        before = measurer.width(run.text[:start], run.font, run.size)
        inside = measurer.width(token, run.font, run.size)
        boxes.append(WordBox(token, left + before * stretch, run.y, inside * stretch, run.height))
    return boxes
