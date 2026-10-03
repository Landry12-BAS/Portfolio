"""A transcript as the pipeline keeps it: stretches of speech with their seconds, cleaned of what Whisper makes up.

Whichever transcriber ran (lb09/transcribers.py), its answer becomes a list of `Segment`s here, and the
same cleaning is applied before any model reads it: a segment the model doubted (invented over silence, or
with a low average log-probability) is dropped, a segment repeated again and again (a decoding loop) is kept
twice at most, a transcript past the caps is cut, and empty text goes. The caps are in lb09/limits.py.
"""

from dataclasses import dataclass

from lb09.limits import (
    LOW_CONFIDENCE_LOGPROB,
    MAX_REPEATED_SEGMENTS,
    MAX_SEGMENTS,
    MAX_TRANSCRIPT_CHARS,
    NO_SPEECH_PROBABILITY,
)
from lb09.textnorm import fold


@dataclass(frozen=True)
class Segment:
    """One stretch of speech: its place, the seconds it starts and ends at, and its words."""

    position: int
    start: float
    end: float
    text: str


@dataclass(frozen=True)
class RawSegment:
    """A segment as a transcriber reports it, with the model's doubts when it reports them."""

    start: float
    end: float
    text: str
    no_speech_prob: float | None = None
    avg_logprob: float | None = None


@dataclass(frozen=True)
class Transcript:
    """What a transcriber heard: the language, the model that ran, and the segments, cleaned."""

    language: str
    model: str
    segments: list[Segment]

    def text(self) -> str:
        """Return the whole transcript as one string, segments separated by a space."""
        return " ".join(segment.text for segment in self.segments)


def is_doubtful(raw: RawSegment) -> bool:
    """Tell whether the model was unsure enough of a segment for it to be dropped."""
    if raw.no_speech_prob is not None and raw.no_speech_prob > NO_SPEECH_PROBABILITY:
        return True
    return raw.avg_logprob is not None and raw.avg_logprob < LOW_CONFIDENCE_LOGPROB


def clean(raw_segments: list[RawSegment]) -> list[Segment]:
    """Turn a transcriber's segments into the pipeline's: doubtful ones dropped, loops cut, caps applied."""
    kept: list[Segment] = []
    characters = 0
    repeats = 0
    for raw in raw_segments:
        text = " ".join(raw.text.split())
        if not text or is_doubtful(raw):
            continue
        if kept and fold(kept[-1].text) == fold(text):
            repeats += 1
            if repeats >= MAX_REPEATED_SEGMENTS:
                continue
        else:
            repeats = 0
        if len(kept) >= MAX_SEGMENTS or characters + len(text) > MAX_TRANSCRIPT_CHARS:
            break
        kept.append(
            Segment(position=len(kept), start=round(raw.start, 3), end=round(max(raw.end, raw.start), 3), text=text)
        )
        characters += len(text) + 1
    return kept
