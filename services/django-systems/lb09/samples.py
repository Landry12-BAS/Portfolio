"""The curated sample meetings the board opens on: the golden set's samples, with their committed audio.

A sample is a scripted meeting marked `sample: true` in evals/lb09/golden.yaml (lb09/golden.py), spoken into
data/seed/lb09/audio by `just tts-lb09`. Running a sample decodes that committed file through the same
pipeline as a visitor's recording, so what the demo shows is what the pipeline does. The manifest beside the
audio says how long each file runs, which the API reports so the page can show a length before anything plays.
"""

from dataclasses import dataclass
from functools import cache

from lb09.golden import read_golden_set
from lb09.scripts import read_scripts
from lb09.tts import audio_dir, read_manifest


@dataclass(frozen=True)
class Sample:
    """One curated meeting: its key, its title, what it is about, its audio file and how long it runs."""

    key: str
    title: str
    about: str
    file: str
    seconds: float
    speakers: int


@cache
def samples() -> dict[str, Sample]:
    """Read the samples once per process: the golden set names them, the scripts and the manifest describe them."""
    golden = read_golden_set()
    scripts = read_scripts()
    manifest = read_manifest()
    found: dict[str, Sample] = {}
    for case in golden.samples():
        script = scripts[case.meeting]
        entry = manifest.meetings[case.meeting]
        found[case.meeting] = Sample(
            key=case.meeting,
            title=script.title,
            about=script.about,
            file=entry.file,
            seconds=entry.seconds,
            speakers=len(script.speakers),
        )
    return found


def sample_audio(key: str) -> bytes:
    """Return a sample's committed audio, as the pipeline decodes it."""
    return (audio_dir() / samples()[key].file).read_bytes()
