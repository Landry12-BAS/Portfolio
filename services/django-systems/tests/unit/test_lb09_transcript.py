"""Unit tests for the cleaning every transcript gets before a model reads it."""

from lb09.limits import MAX_SEGMENTS, MAX_TRANSCRIPT_CHARS
from lb09.transcript import RawSegment, clean


def raw(text: str, start: float = 0.0, no_speech: float | None = None, logprob: float | None = None) -> RawSegment:
    """Make a raw segment a second long."""
    return RawSegment(start=start, end=start + 1.0, text=text, no_speech_prob=no_speech, avg_logprob=logprob)


def test_segments_are_kept_in_order_and_renumbered() -> None:
    """Clean segments keep their words and seconds, and are numbered from 0 in order."""
    cleaned = clean([raw("Good morning.", 0.0), raw("  Let's  plan Monday. ", 1.0)])
    assert [(s.position, s.start, s.end, s.text) for s in cleaned] == [
        (0, 0.0, 1.0, "Good morning."),
        (1, 1.0, 2.0, "Let's plan Monday."),
    ]


def test_segments_the_model_doubted_are_dropped() -> None:
    """Text invented over silence, or heard with little confidence, never reaches a model."""
    cleaned = clean(
        [raw("Thank you for watching.", 0.0, no_speech=0.9), raw("mumble", 1.0, logprob=-1.5), raw("Real words.", 2.0)]
    )
    assert [s.text for s in cleaned] == ["Real words."]


def test_a_segment_repeated_again_and_again_is_kept_twice_at_most() -> None:
    """A decoding loop repeats one line; two copies stay, the rest go, and a different line resets the count."""
    cleaned = clean([raw("Yes.", float(i)) for i in range(5)] + [raw("No.", 5.0)] + [raw("yes", 6.0)])
    assert [s.text for s in cleaned] == ["Yes.", "Yes.", "No.", "yes"]


def test_the_caps_on_segments_and_characters_hold() -> None:
    """Past the segment cap, or the character cap, the rest of the transcript is cut."""
    many = clean([raw(f"line {i}", float(i)) for i in range(MAX_SEGMENTS + 10)])
    assert len(many) == MAX_SEGMENTS
    long_lines = clean([raw("x" * 1_000, float(i)) for i in range(20)])
    assert sum(len(s.text) for s in long_lines) <= MAX_TRANSCRIPT_CHARS


def test_empty_text_and_a_segment_that_ends_before_it_starts_are_tidied() -> None:
    """Blank segments go, and an end before the start becomes the start."""
    cleaned = clean([raw("   ", 0.0), RawSegment(start=2.0, end=1.0, text="Backwards.")])
    assert len(cleaned) == 1
    assert (cleaned[0].start, cleaned[0].end) == (2.0, 2.0)
