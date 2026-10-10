"""Checking what the extractor found against the transcript, and placing each item in time, in code.

The model gives each decision and action with a verbatim quote as its evidence. Here the quote is looked
for in the transcript (folded, so punctuation and case count for nothing; lb09/textnorm.py), and the item's
time span is the span of the segments the quote falls in. The model never supplies a time. An item whose
quote cannot be found, that repeats another, whose quote is too short to be found only where it was said,
or that is an instruction spoken to an assistant, is dropped and counted, so the page can say how many
the checks removed. A segment number or a speaker label the model copied in front of a quote was never said,
so it is taken off first, and the rest must still be found word for word. An owner must be a speaker's label
or a name said in the meeting, or it is dropped to nobody: the model may not invent one.
"""

import re
from dataclasses import dataclass

from lb09.limits import MAX_ACTIONS, MAX_DECISIONS, MIN_EVIDENCE_WORDS
from lb09.prompts import ActionAnswer, DecisionAnswer, ExtractAnswer
from lb09.results import FoundItem, ItemKind, LabelledSegment
from lb09.textnorm import fold

# A sentence spoken to the assistant, which the meeting did not agree to: it addresses a bot, or tells it to
# ignore its instructions. Checked on the folded quote, where punctuation is gone.
SPOKEN_TO_ASSISTANT = re.compile(
    r"^(?:hey |ok |okay |dear )?(?:assistant|chatbot|bot|ai|siri|alexa|computer)\b"
    r"|\bignore (?:the |your |all |any )?(?:previous |above |earlier |other |rest of the )?"
    r"(?:instructions|notes|rules)\b"
)


# The number in front of a line of the transcript as the extractor reads it: "[3] Hannah: Good. Then we roast".
LINE_NUMBER = re.compile(r"\[\d{1,3}\]\s*")


@dataclass(frozen=True)
class Placed:
    """Where a quote sits in the transcript: the first and last segment it falls in."""

    first: int
    last: int


@dataclass(frozen=True)
class FoldedTranscript:
    """The transcript folded into one string, with where each segment starts and ends in it."""

    text: str
    bounds: list[tuple[int, int]]

    def segment_at(self, offset: int) -> int:
        """Return the index of the segment a character offset of the folded text falls in."""
        for index, (start, end) in enumerate(self.bounds):
            if start <= offset < end:
                return index
        return max(0, len(self.bounds) - 1)


def fold_transcript(segments: list[LabelledSegment]) -> FoldedTranscript:
    """Fold the segments into one string separated by single spaces, remembering each segment's place."""
    parts: list[str] = []
    bounds: list[tuple[int, int]] = []
    offset = 0
    for segment in segments:
        folded = fold(segment.text)
        bounds.append((offset, offset + len(folded)))
        parts.append(folded)
        offset += len(folded) + 1
    return FoldedTranscript(text=" ".join(parts), bounds=bounds)


def place_quote(quote: str, transcript: FoldedTranscript) -> Placed | None:
    """Find a quote in the transcript as whole words, and say which segments it spans; None when it is not there."""
    folded = fold(quote)
    if len(folded.split()) < MIN_EVIDENCE_WORDS:
        return None
    padded = f" {transcript.text} "
    at = padded.find(f" {folded} ")
    if at == -1:
        return None
    start = at
    end = at + len(folded) - 1
    return Placed(first=transcript.segment_at(start), last=transcript.segment_at(end))


def spoken_words(quote: str, labels: set[str]) -> str:
    """Return a quote without the segment number or the speaker label a model may copy in front of it.

    The extractor reads each line as "[3] Hannah: Good. Then we roast", and at a low reasoning effort it copied
    the label into every quote. Only a label of this transcript, written as it is, is taken off.
    """
    text = quote.strip()
    numbered = LINE_NUMBER.match(text)
    if numbered:
        text = text[numbered.end() :]
    label, colon, rest = text.partition(":")
    if colon and label.strip() in labels:
        return rest.strip()
    return text


def is_spoken_to_assistant(quote: str) -> bool:
    """Tell whether a quote is an instruction to an assistant, which no meeting agreed to."""
    return SPOKEN_TO_ASSISTANT.search(fold(quote)) is not None


def spoken_names(segments: list[LabelledSegment]) -> set[str]:
    """Collect the folded labels, and every capitalised word said, that an owner may be."""
    names = {fold(segment.label) for segment in segments}
    for segment in segments:
        for word in re.findall(r"\b[A-Z][a-z]{1,29}\b", segment.text):
            names.add(fold(word))
    return names


def checked_owner(owner: str | None, names: set[str]) -> str | None:
    """Keep an owner only when they are a label or a name the meeting said; a label keeps its spelling."""
    if owner is None:
        return None
    folded = fold(owner)
    # "Speaker 2" written with other spacing or case still names a label, and keeps the label's spelling.
    match = re.fullmatch(r"speaker (\d+)", folded)
    if match:
        return f"Speaker {match.group(1)}" if folded in names else None
    return owner.strip() if folded in names else None


@dataclass
class Checked:
    """What survived the checks, and how many items did not."""

    items: list[FoundItem]
    dropped: int


def check_items(answer: ExtractAnswer, segments: list[LabelledSegment]) -> Checked:
    """Verify every item the model gave against the transcript, place it in time, and drop what fails."""
    transcript = fold_transcript(segments)
    names = spoken_names(segments)
    labels = {segment.label for segment in segments}
    seen: set[tuple[str, str]] = set()
    checked = Checked(items=[], dropped=0)
    proposed: list[tuple[ItemKind, DecisionAnswer]] = [
        *(("decision", item) for item in answer.decisions[:MAX_DECISIONS]),
        *(("action", item) for item in answer.actions[:MAX_ACTIONS]),
    ]
    for kind, item in proposed:
        evidence = spoken_words(item.evidence, labels)
        placed = place_quote(evidence, transcript)
        key = (kind, fold(item.text))
        if placed is None or key in seen or is_spoken_to_assistant(evidence) or is_spoken_to_assistant(item.text):
            checked.dropped += 1
            continue
        seen.add(key)
        checked.items.append(found_item(kind, item, evidence, placed, segments, names))
    return checked


def found_item(
    kind: ItemKind,
    item: DecisionAnswer,
    evidence: str,
    placed: Placed,
    segments: list[LabelledSegment],
    names: set[str],
) -> FoundItem:
    """Build the item the page shows: the model's words, the words said, the checked owner, the seconds from code."""
    owner = checked_owner(item.owner, names) if isinstance(item, ActionAnswer) else None
    deadline = item.deadline if isinstance(item, ActionAnswer) else None
    return FoundItem(
        kind=kind,
        text=item.text,
        owner=owner,
        deadline=deadline,
        evidence=evidence,
        start=segments[placed.first].start,
        end=segments[placed.last].end,
        first_segment=placed.first,
        last_segment=placed.last,
    )
