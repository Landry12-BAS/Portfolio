"""Unit tests for the speaker labels: what the code keeps of the labeller's answer, and what it corrects."""

from lb09.labelling import label_segments, one_speaker
from lb09.prompts import LabelAnswer
from lb09.transcript import Segment


def segments(*texts: str) -> list[Segment]:
    """Make a segment a second long for each text."""
    return [Segment(position=i, start=float(i), end=i + 1.0, text=text) for i, text in enumerate(texts)]


def answer(speakers: list[tuple[int, str | None]], turns: list[int]) -> LabelAnswer:
    """Make a labeller's answer: the speakers with their names, and the speaker of each segment in order."""
    return LabelAnswer.model_validate(
        {
            "speakers": [{"id": id_, "name": name} for id_, name in speakers],
            "turns": [{"segment": i, "speaker": who} for i, who in enumerate(turns)],
        }
    )


def test_a_name_is_kept_only_when_that_speaker_introduces_themselves() -> None:
    """Hannah says her name and keeps it; Kevin is only addressed, so his proposed name is dropped to a label."""
    heard = segments("Good morning, this is Hannah.", "Kevin, can you do it?", "Sure, I'll do it on Sunday.")
    labelled = label_segments(heard, answer([(0, "Hannah"), (1, "Kevin")], [0, 0, 1]))
    assert [s.label for s in labelled] == ["Hannah", "Hannah", "Speaker 1"]
    assert [s.speaker for s in labelled] == [0, 0, 1]


def test_unnamed_speakers_are_numbered_in_the_order_they_first_speak() -> None:
    """Whatever ids the labeller chose, the voices are renumbered by first word, and the labels follow."""
    heard = segments("First.", "Second.", "Third.", "First again.")
    labelled = label_segments(heard, answer([(4, None), (2, None), (0, None)], [4, 2, 0, 4]))
    assert [s.speaker for s in labelled] == [0, 1, 2, 0]
    assert [s.label for s in labelled] == ["Speaker 1", "Speaker 2", "Speaker 3", "Speaker 1"]


def test_a_named_speaker_does_not_take_a_number_from_the_unnamed() -> None:
    """Named speakers are called by their names; the unnamed ones count from 1 among themselves."""
    heard = segments("Peter here.", "Hello.", "I'm David.", "Hi.")
    labelled = label_segments(heard, answer([(0, "Peter"), (1, None), (2, "David"), (3, None)], [0, 1, 2, 3]))
    assert [s.label for s in labelled] == ["Peter", "Speaker 1", "David", "Speaker 2"]


def test_a_segment_the_labeller_left_out_joins_the_one_before_it() -> None:
    """Every segment gets a speaker: an unlabelled one is given the previous segment's, or the first speaker's."""
    heard = segments("A.", "B.", "C.")
    partial = LabelAnswer.model_validate(
        {"speakers": [{"id": 0, "name": None}, {"id": 1, "name": None}], "turns": [{"segment": 1, "speaker": 1}]}
    )
    labelled = label_segments(heard, partial)
    assert [s.speaker for s in labelled] == [0, 1, 1]


def test_two_speakers_cannot_share_a_name() -> None:
    """The second speaker proposed with a name already taken stays a numbered label."""
    heard = segments("This is Hannah.", "This is Hannah too.")
    labelled = label_segments(heard, answer([(0, "Hannah"), (1, "Hannah")], [0, 1]))
    assert [s.label for s in labelled] == ["Hannah", "Speaker 1"]


def test_one_speaker_labels_everything_as_the_first_unnamed_voice() -> None:
    """The fallback when the labeller could not answer."""
    labelled = one_speaker(segments("A.", "B."))
    assert [(s.speaker, s.label) for s in labelled] == [(0, "Speaker 1"), (0, "Speaker 1")]
