"""LB-09's scripted meetings: who speaks, in which order, and what they say.

A script is the source of truth for a synthetic meeting. It is plain text in data/seed/lb09, one
file for each meeting, read with the strict reader every data file here goes through
(core/data_files.py): an unknown field is an error, and a problem names the file and the field.

Three things are made from a script, and none of them changes it:

- the committed audio, by `just tts-lb09`, which speaks each turn with an offline text-to-speech
  (lb09/tts.py);
- the golden set's expectations, which name the turns each planted decision and action is said in
  (evals/lb09/golden.yaml, lb09/golden.py);
- the transcript the offline tests and the text-only eval feed the pipeline, one segment to a turn.
"""

from pathlib import Path
from typing import Annotated, Final, Literal, Self

from django.conf import settings
from pydantic import Field, StringConstraints, model_validator

from core.data_files import DataFileError, Key, StrictEntry, read_data_file

# The voices of the offline text-to-speech (Flite), all of which write 16 kHz mono audio. A script names
# the voice of each speaker, so a meeting sounds like several people.
Voice = Literal["slt", "rms", "awb", "kal16"]
# What a turn may say: plain words and ordinary punctuation, so the speech engine reads it as written.
Spoken = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9 ,.'?!:;%-]+$", min_length=1, max_length=300)]
# How a speaker is named in a label.
PersonName = Annotated[str, StringConstraints(pattern=r"^[A-Z][a-z]{1,19}$")]
# A script, at most, is a minute of speech: this many words at Flite's pace leaves room for the pauses.
MAX_WORDS: Final = 150


class Speaker(StrictEntry):
    """One person in the meeting: the ID turns refer to, the name they are called, and the voice that speaks them."""

    id: Key
    name: PersonName
    voice: Voice


class Turn(StrictEntry):
    """One thing a speaker says. `overlap` is how many seconds it starts before the turn before it ends."""

    speaker: Key
    text: Spoken
    overlap: float = Field(default=0.0, ge=0.0, le=3.0)


class Script(StrictEntry):
    """A whole scripted meeting."""

    key: Key
    title: Annotated[str, StringConstraints(min_length=3, max_length=60)]
    language: Literal["en"]
    about: Annotated[str, StringConstraints(strip_whitespace=True, min_length=10, max_length=300)]
    speakers: list[Speaker] = Field(min_length=2, max_length=6)
    turns: list[Turn] = Field(min_length=4, max_length=20)

    @model_validator(mode="after")
    def _check_cast(self) -> Self:
        """Require distinct speakers, turns by people who exist, everyone speaking and no overlap at the start."""
        ids = [speaker.id for speaker in self.speakers]
        names = [speaker.name for speaker in self.speakers]
        if len(set(ids)) != len(ids) or len(set(names)) != len(names):
            raise ValueError("every speaker needs an ID and a name of their own")
        unknown = {turn.speaker for turn in self.turns} - set(ids)
        if unknown:
            raise ValueError(f"turns by speakers who are not in the cast: {', '.join(sorted(unknown))}")
        silent = set(ids) - {turn.speaker for turn in self.turns}
        if silent:
            raise ValueError(f"speakers who never speak: {', '.join(sorted(silent))}")
        if self.turns[0].overlap:
            raise ValueError("the first turn has nothing to overlap")
        return self

    @model_validator(mode="after")
    def _check_length(self) -> Self:
        """Keep the meeting inside a minute of speech."""
        words = sum(len(turn.text.split()) for turn in self.turns)
        if words > MAX_WORDS:
            raise ValueError(f"{words} words is more than the {MAX_WORDS} a minute-long recording holds")
        return self

    def speaker(self, speaker_id: str) -> Speaker:
        """Return the speaker with this ID."""
        for speaker in self.speakers:
            if speaker.id == speaker_id:
                return speaker
        raise KeyError(speaker_id)

    def words(self) -> int:
        """Count the words the meeting says."""
        return sum(len(turn.text.split()) for turn in self.turns)


def scripts_dir() -> Path:
    """Return the folder the scripts live in: `lb09` under the seed folder."""
    return settings.SEED_DIR / "lb09"


def read_script(path: Path) -> Script:
    """Read and check one script, whose file name must be its key, so a script is found by its name."""
    script = read_data_file(path, Script)
    if path.stem != script.key:
        raise DataFileError(f"{path} holds the script {script.key!r}: name the file after its key")
    return script


def read_scripts(directory: Path | None = None) -> dict[str, Script]:
    """Read every script in the folder, by key, in alphabetical order of file name."""
    folder = directory or scripts_dir()
    scripts: dict[str, Script] = {}
    for path in sorted(folder.glob("*.yaml")):
        script = read_script(path)
        scripts[script.key] = script
    return scripts
