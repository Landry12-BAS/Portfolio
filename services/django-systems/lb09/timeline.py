"""When each turn of a scripted meeting is spoken, in seconds from the start of its audio.

The committed audio's real timeline comes from the speech engine and is written down beside it
(data/seed/lb09/audio/manifest.yaml). Where there is no audio, such as in the offline tests and the
text-only eval, the timeline is estimated from the words at the pace Flite speaks, with the same pauses
and overlaps the audio is made with, so both give a transcript the same shape.
"""

from dataclasses import dataclass
from typing import Final

from lb09.scripts import Script

# Flite speaks about 170 words a minute (measured on the six scripts).
WORDS_PER_SECOND: Final = 2.85
# The silence before the first word, between two turns, and after the last.
LEAD_SECONDS: Final = 0.3
PAUSE_SECONDS: Final = 0.4
TAIL_SECONDS: Final = 0.3
# Even "Sure." takes this long.
MIN_TURN_SECONDS: Final = 0.5


@dataclass(frozen=True)
class TurnSpan:
    """The seconds one turn is spoken: from its first sound to its last."""

    start: float
    end: float


def estimated_turn_seconds(text: str) -> float:
    """Estimate how long a turn takes to say, from its words."""
    return max(MIN_TURN_SECONDS, len(text.split()) / WORDS_PER_SECOND)


def lay_out_turns(durations: list[float], overlaps: list[float]) -> list[TurnSpan]:
    """Place turns one after another, each starting after a pause or, for an overlap, before the last one ends."""
    spans: list[TurnSpan] = []
    for duration, overlap in zip(durations, overlaps, strict=True):
        if not spans:
            start = LEAD_SECONDS
        elif overlap:
            start = max(0.0, spans[-1].end - overlap)
        else:
            start = max(span.end for span in spans) + PAUSE_SECONDS
        spans.append(TurnSpan(start=round(start, 3), end=round(start + duration, 3)))
    return spans


def estimate_turn_spans(script: Script) -> list[TurnSpan]:
    """Estimate when each turn of a script is spoken."""
    durations = [estimated_turn_seconds(turn.text) for turn in script.turns]
    return lay_out_turns(durations, [turn.overlap for turn in script.turns])


def total_seconds(spans: list[TurnSpan]) -> float:
    """Return how long the audio runs: to the end of its last sound, plus the silence after it."""
    return round(max(span.end for span in spans) + TAIL_SECONDS, 3)
