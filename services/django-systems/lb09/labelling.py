"""Speaker labels, inferred from the words and checked by the code.

Whisper does not tell voices apart, so the labeller model proposes which segments one voice said and the
name a speaker gave themselves. The code trusts neither blindly: a name is kept only when a segment of that
speaker really introduces it ("this is Hannah", "I'm David"; lb09/textnorm.py), no two speakers may share a
name, every segment gets exactly one speaker, and the speakers without a name are numbered "Speaker 1",
"Speaker 2" in the order they first speak. The API and the page say the labels are inferred from the text,
never matched to a voice.
"""

from lb09.prompts import LabelAnswer
from lb09.results import LabelledSegment
from lb09.textnorm import fold, introduces_themselves
from lb09.transcript import Segment


def speaker_of_each(segments: list[Segment], answer: LabelAnswer) -> list[int]:
    """Return the labeller's speaker for each segment, in order; a segment it left out joins the one before it."""
    proposed = {turn.segment: turn.speaker for turn in answer.turns}
    speakers: list[int] = []
    for segment in segments:
        previous = speakers[-1] if speakers else min(speaker.id for speaker in answer.speakers)
        speakers.append(proposed.get(segment.position, previous))
    return speakers


def verified_names(segments: list[Segment], speakers: list[int], answer: LabelAnswer) -> dict[int, str]:
    """Keep each proposed name only when that speaker introduces themselves by it, and never twice."""
    names: dict[int, str] = {}
    taken: set[str] = set()
    for speaker in answer.speakers:
        if speaker.name is None or fold(speaker.name) in taken:
            continue
        own_segments = [segment for segment, who in zip(segments, speakers, strict=True) if who == speaker.id]
        if any(introduces_themselves(segment.text, speaker.name) for segment in own_segments):
            names[speaker.id] = speaker.name
            taken.add(fold(speaker.name))
    return names


def label_segments(segments: list[Segment], answer: LabelAnswer) -> list[LabelledSegment]:
    """Turn the labeller's answer into labelled segments, with the voices renumbered in order of first word."""
    proposed = speaker_of_each(segments, answer)
    names = verified_names(segments, proposed, answer)
    order: dict[int, int] = {}
    for who in proposed:
        order.setdefault(who, len(order))
    labels: dict[int, str] = {}
    unnamed = 0
    for who in order:
        if who in names:
            labels[who] = names[who]
        else:
            unnamed += 1
            labels[who] = f"Speaker {unnamed}"
    return [
        LabelledSegment(
            position=segment.position,
            start=segment.start,
            end=segment.end,
            text=segment.text,
            speaker=order[who],
            label=labels[who],
        )
        for segment, who in zip(segments, proposed, strict=True)
    ]


def one_speaker(segments: list[Segment]) -> list[LabelledSegment]:
    """Label every segment as the one unnamed speaker, for when the labeller could not answer."""
    return [
        LabelledSegment(position=s.position, start=s.start, end=s.end, text=s.text, speaker=0, label="Speaker 1")
        for s in segments
    ]
