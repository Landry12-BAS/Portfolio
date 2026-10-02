"""What the pipeline finds in a meeting, as plain values: labelled segments and the items with their spans.

The database rows (lb09/models.py) are saved from these, the golden set's grader reads them
(lb09/golden_eval.py), and the exports are made from them, so what is graded is what a visitor sees.
"""

from dataclasses import dataclass
from typing import Literal

type ItemKind = Literal["decision", "action"]


@dataclass(frozen=True)
class LabelledSegment:
    """One stretch of speech: its place in the transcript, its start and end, its words and who is inferred to say it.

    `speaker` numbers the voices the labelling found, from 0, and `label` is what the page shows: a name the speaker
    gave themselves, or "Speaker 1", "Speaker 2". The label is inferred from the words, never matched to a voice.
    """

    position: int
    start: float
    end: float
    text: str
    speaker: int
    label: str


@dataclass(frozen=True)
class FoundItem:
    """A decision or an action the meeting holds, with the verbatim words that show it and where they were said.

    `start` and `end` are derived by the code from the segments the evidence falls in, never given by a model.
    """

    kind: ItemKind
    text: str
    owner: str | None
    deadline: str | None
    evidence: str
    start: float
    end: float
    first_segment: int
    last_segment: int


@dataclass(frozen=True)
class MeetingResult:
    """The labelled transcript of a meeting, and the items that passed every check.

    `dropped` counts the items the model gave that did not: no evidence found in the transcript, a repeat, or an
    instruction to the assistant. A meeting says how many it dropped, so the page never hides them.
    """

    segments: list[LabelledSegment]
    items: list[FoundItem]
    dropped: int
