"""Offline tests for LB-09's scripted meetings: the six in data/seed/lb09 are valid, and a bad script is refused.

The scripts are the source of truth for the committed audio and for the golden set's turns, so a mistake in one
would shift every item that points at it. Nothing here needs a database, a speech engine or a model.
"""

from pathlib import Path
from typing import Any

import pytest
import yaml
from lb09.scripts import MAX_WORDS, Script, read_script, read_scripts, scripts_dir
from lb09.timeline import TAIL_SECONDS, estimate_turn_spans, lay_out_turns, total_seconds

from core.data_files import DataFileError


@pytest.fixture(scope="module")
def scripts() -> dict[str, Script]:
    """Read every scripted meeting once for the module."""
    return read_scripts()


def valid_script() -> dict[str, Any]:
    """Return a small valid script as a plain dict, for tests to break one field of."""
    return {
        "key": "tiny-meeting",
        "title": "Tiny meeting",
        "language": "en",
        "about": "A meeting that is only here to be broken.",
        "speakers": [
            {"id": "ann", "name": "Ann", "voice": "slt"},
            {"id": "bob", "name": "Bob", "voice": "rms"},
        ],
        "turns": [
            {"speaker": "ann", "text": "Good morning."},
            {"speaker": "bob", "text": "Good morning, Ann."},
            {"speaker": "ann", "text": "Let's begin."},
            {"speaker": "bob", "text": "Yes."},
        ],
    }


def write_script(directory: Path, content: dict[str, Any], name: str = "tiny-meeting") -> Path:
    """Write a script file and return its path."""
    path = directory / f"{name}.yaml"
    path.write_text(yaml.safe_dump(content), encoding="utf-8")
    return path


def test_the_six_meetings_are_there_and_named_after_their_files(scripts: dict[str, Script]) -> None:
    """The Monday roasting plan and five others, each found by its key."""
    assert set(scripts) == {
        "monday-roasting-plan",
        "quarterly-check-in",
        "weekend-staffing",
        "newsletter-draft",
        "tasting-notes-overlap",
        "grinder-repair",
    }
    assert {path.stem for path in scripts_dir().glob("*.yaml")} == set(scripts)


def test_every_meeting_fits_a_minute_of_speech(scripts: dict[str, Script]) -> None:
    """The datasheet's recording is at most 60 seconds, and the audio must leave room for pauses and a tail."""
    for script in scripts.values():
        assert script.words() <= MAX_WORDS
        assert total_seconds(estimate_turn_spans(script)) <= 55.0, script.key


def test_a_meeting_with_overlap_has_turns_that_start_before_the_last_ends(scripts: dict[str, Script]) -> None:
    """Overlapping talk is a script's own doing, so the audio and the transcript can model it."""
    script = scripts["tasting-notes-overlap"]
    spans = estimate_turn_spans(script)

    overlapping = [index for index, turn in enumerate(script.turns) if turn.overlap]
    assert overlapping == [1, 2]
    for index in overlapping:
        assert spans[index].start < spans[index - 1].end


def test_turns_without_overlap_are_laid_out_one_after_another_with_pauses() -> None:
    """Each turn starts a pause after the last sound, and an overlap starts before the previous turn ends."""
    spans = lay_out_turns([2.0, 1.0, 3.0], [0.0, 0.0, 0.5])

    assert [(span.start, span.end) for span in spans] == [(0.3, 2.3), (2.7, 3.7), (3.2, 6.2)]
    assert total_seconds(spans) == pytest.approx(6.2 + TAIL_SECONDS)


def test_a_script_must_be_named_after_its_key(tmp_path: Path) -> None:
    """A script is found by its name, so the file and the key cannot disagree."""
    path = write_script(tmp_path, valid_script(), name="another-name")

    with pytest.raises(DataFileError, match="name the file after its key"):
        read_script(path)


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda s: s.update(extra="field"), "extra"),
        (lambda s: s["turns"][1].update(speaker="carol"), "not in the cast"),
        (lambda s: [turn.update(speaker="ann") for turn in s["turns"]], "never speak"),
        (lambda s: s["turns"][0].update(overlap=1.0), "nothing to overlap"),
        (lambda s: s["speakers"][1].update(name="Ann"), "of their own"),
        (lambda s: s["turns"][0].update(text="Say <b>this</b>"), "pattern"),
        (lambda s: s["turns"][0].update(text="word " * 200), "at most 300 characters"),
        (lambda s: s["speakers"][0].update(voice="alloy"), "slt"),
        (lambda s: s["turns"][0].update(overlap=9.0), "less than or equal to 3"),
        (lambda s: s.update(language="cs"), "en"),
        (lambda s: s["turns"].pop(), "at least 4"),
    ],
)
def test_a_script_that_breaks_a_rule_is_refused_with_its_file_named(tmp_path: Path, change: Any, message: str) -> None:
    """The reader is strict: an unknown field, a stranger in the cast, unsafe text or a silent speaker all stop it."""
    content = valid_script()
    change(content)
    path = write_script(tmp_path, content)

    with pytest.raises(DataFileError, match=message) as caught:
        read_script(path)

    assert "tiny-meeting.yaml" in str(caught.value)


def test_a_script_with_more_words_than_a_minute_holds_is_refused(tmp_path: Path) -> None:
    """Fifteen long turns would run past the recording limit, so they never reach the speech engine."""
    content = valid_script()
    content["turns"] = [{"speaker": "ann" if index % 2 == 0 else "bob", "text": "word " * 20} for index in range(10)]

    with pytest.raises(DataFileError, match="more than the"):
        read_script(write_script(tmp_path, content))
