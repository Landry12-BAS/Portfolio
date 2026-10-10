"""Making the scripted meetings into audio, with an offline text-to-speech.

`just tts-lb09` speaks each script in data/seed/lb09 with Flite (Carnegie Mellon's small speech engine, a
permissive licence, installed with `apt-get install flite` or `brew install flite`), one voice for each speaker.
It makes no network call: the voices are inside the program. The turns are levelled to one loudness, placed one
after another with pauses (or on top of each other, where a script says a turn overlaps the one before), mixed
and encoded as MP3, and written to data/seed/lb09/audio with a manifest. The manifest records what the audio is
(its size, its hash, its length as a decoder measures it) and when each turn is spoken, which is what the golden
set's time spans are graded against.

The scripts are the source of truth, and the audio is made from them: a recording that cannot be made here (no
Flite on the machine) leaves the committed audio as it was. The audio is committed, so nobody needs Flite to run
the site or the tests; a test checks that each file still matches the manifest it was made with.
"""

import hashlib
import io
import math
import shutil
import subprocess
import sys
import tempfile
import wave
from array import array
from dataclasses import dataclass
from pathlib import Path
from typing import Final

import av
import yaml
from pydantic import Field

from core.data_files import StrictEntry, read_data_file
from lb09.scripts import Script, Voice, scripts_dir
from lb09.timeline import TurnSpan, lay_out_turns, total_seconds

# The audio every Flite voice writes, and the format everything after it uses.
SAMPLE_RATE: Final = 16_000
BYTES_PER_SAMPLE: Final = 2
BYTES_PER_SECOND: Final = SAMPLE_RATE * BYTES_PER_SAMPLE
# Each turn is scaled to this loudness (root mean square, of 32,767), so no voice drowns another.
TARGET_RMS: Final = 3_000.0
# The MP3's bitrate: speech needs little, and the file is committed.
MP3_BITRATE: Final = 32_000
# How long the speech engine may take for one turn.
SPEAK_TIMEOUT_SECONDS: Final = 60
# The manifest sits beside the audio it describes.
MANIFEST_NAME: Final = "manifest.yaml"
MANIFEST_HEADER: Final = (
    "# Made by `just tts-lb09` from the scripts in data/seed/lb09: do not edit by hand.\n"
    "# It says what each committed audio file is, and when each turn of its script is spoken.\n"
)


class SpeechEngineError(Exception):
    """The speech engine is missing or failed, so no audio could be made."""


class TurnTiming(StrictEntry):
    """When one turn is spoken: the seconds from the start of the audio to its first and last sound."""

    start: float = Field(ge=0.0)
    end: float = Field(gt=0.0)


class AudioEntry(StrictEntry):
    """One meeting's audio file: what it is, so a changed or damaged file is noticed, and when each turn is spoken."""

    file: str = Field(pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*\.mp3$")
    bytes: int = Field(gt=0)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    # The length a decoder measures, which includes the encoder's padding.
    seconds: float = Field(gt=0.0, le=60.0)
    turns: list[TurnTiming] = Field(min_length=1)


class Manifest(StrictEntry):
    """Everything about the committed audio: the engine that spoke it, and each meeting's file and timeline."""

    engine: str = Field(min_length=3, max_length=60)
    sample_rate: int = Field(gt=0)
    meetings: dict[str, AudioEntry]

    def spans(self, key: str) -> list[TurnSpan]:
        """Return when each turn of a meeting is spoken."""
        return [TurnSpan(start=turn.start, end=turn.end) for turn in self.meetings[key].turns]


@dataclass(frozen=True)
class Rendered:
    """A meeting spoken: its mixed audio as 16 kHz mono PCM, and when each turn is spoken in it."""

    pcm: bytes
    spans: list[TurnSpan]


def audio_dir() -> Path:
    """Return the folder the committed audio lives in: `lb09/audio` under the seed folder."""
    return scripts_dir() / "audio"


def find_flite() -> str:
    """Return the path of the Flite program, or say how to get it."""
    found = shutil.which("flite")
    if found is None:
        raise SpeechEngineError("Flite is not installed: run `apt-get install flite` (or `brew install flite`).")
    return found


def engine_name(flite: str) -> str:
    """Return the engine and its version as it reports them, such as `flite-2.2-current`."""
    result = subprocess.run([flite, "--version"], capture_output=True, text=True, timeout=10, check=False)  # noqa: S603 - the program found on the PATH, with a fixed option
    for line in f"{result.stdout}\n{result.stderr}".splitlines():
        words = line.split()
        if words[:1] == ["version:"] and len(words) > 1:
            return words[1]
    return "flite"


def speak(text: str, voice: Voice, flite: str) -> bytes:
    """Speak one turn with one voice, and return its audio as 16 kHz mono 16-bit PCM."""
    with tempfile.TemporaryDirectory(prefix="lb09-tts-") as folder:
        words = Path(folder) / "words.txt"
        sound = Path(folder) / "sound.wav"
        words.write_text(text, encoding="utf-8")
        command = [flite, "-voice", voice, "-f", str(words), "-o", str(sound)]
        try:
            subprocess.run(command, capture_output=True, timeout=SPEAK_TIMEOUT_SECONDS, check=True)  # noqa: S603 - Flite, with a voice from a closed list and files of our own
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
            raise SpeechEngineError(f"Flite could not speak with the voice {voice}.") from error
        with wave.open(str(sound), "rb") as reader:
            format_found = (reader.getnchannels(), reader.getsampwidth(), reader.getframerate())
            if format_found != (1, BYTES_PER_SAMPLE, SAMPLE_RATE):
                raise SpeechEngineError(f"The voice {voice} does not write 16 kHz mono audio.")
            return reader.readframes(reader.getnframes())


def samples_of(pcm: bytes) -> array[int]:
    """Read PCM bytes as 16-bit samples."""
    samples: array[int] = array("h")
    samples.frombytes(pcm)
    if sys.byteorder == "big":
        samples.byteswap()
    return samples


def pcm_of(samples: array[int]) -> bytes:
    """Write 16-bit samples as little-endian PCM bytes."""
    if sys.byteorder == "big":
        samples.byteswap()
    return samples.tobytes()


def level(pcm: bytes, target: float = TARGET_RMS) -> bytes:
    """Scale audio to a loudness (its root mean square), clipping what would pass the loudest sample."""
    samples = samples_of(pcm)
    if not samples:
        return pcm
    rms = math.sqrt(sum(sample * sample for sample in samples) / len(samples))
    if rms == 0:
        return pcm
    gain = target / rms
    return pcm_of(array("h", (max(-32_768, min(32_767, round(sample * gain))) for sample in samples)))


def mix(parts: list[tuple[float, bytes]], seconds: float) -> bytes:
    """Lay audio on a silent track of this length, each part starting at its time; where parts meet, they add."""
    track = array("i", bytes(4 * round(seconds * SAMPLE_RATE)))
    for start, pcm in parts:
        offset = round(start * SAMPLE_RATE)
        for index, sample in enumerate(samples_of(pcm)):
            track[offset + index] += sample
    return pcm_of(array("h", (max(-32_768, min(32_767, sample)) for sample in track)))


def render(script: Script, flite: str) -> Rendered:
    """Speak a whole script: every turn in its speaker's voice, levelled, placed and mixed into one track."""
    voices = {speaker.id: speaker.voice for speaker in script.speakers}
    spoken = [level(speak(turn.text, voices[turn.speaker], flite)) for turn in script.turns]
    spans = lay_out_turns([len(pcm) / BYTES_PER_SECOND for pcm in spoken], [turn.overlap for turn in script.turns])
    parts = [(span.start, pcm) for span, pcm in zip(spans, spoken, strict=True)]
    return Rendered(pcm=mix(parts, total_seconds(spans)), spans=spans)


def encode_mp3(pcm: bytes) -> bytes:
    """Encode 16 kHz mono PCM as MP3, which every browser plays, at a bitrate speech does not need more than."""
    buffer = io.BytesIO()
    with av.open(buffer, mode="w", format="mp3") as container:
        stream = container.add_stream("libmp3lame", rate=SAMPLE_RATE)
        stream.layout = "mono"
        stream.bit_rate = MP3_BITRATE
        frame = av.AudioFrame(format="s16", layout="mono", samples=len(pcm) // BYTES_PER_SAMPLE, align=1)
        frame.sample_rate = SAMPLE_RATE
        frame.planes[0].update(pcm)
        for packet in stream.encode(frame):
            container.mux(packet)
        for packet in stream.encode(None):
            container.mux(packet)
    return buffer.getvalue()


def decoded_seconds(data: bytes) -> float:
    """Measure an audio file the way a decoder does: by decoding it and counting the samples."""
    samples = 0
    rate = SAMPLE_RATE
    with av.open(io.BytesIO(data), mode="r") as container:
        for frame in container.decode(audio=0):
            samples += frame.samples
            rate = frame.sample_rate
    return round(samples / rate, 3)


def make_entry(key: str, rendered: Rendered) -> tuple[AudioEntry, bytes]:
    """Encode a spoken meeting and describe the file: its name, size, hash, decoded length and turn timings."""
    mp3 = encode_mp3(rendered.pcm)
    entry = AudioEntry(
        file=f"{key}.mp3",
        bytes=len(mp3),
        sha256=hashlib.sha256(mp3).hexdigest(),
        seconds=decoded_seconds(mp3),
        turns=[TurnTiming(start=span.start, end=span.end) for span in rendered.spans],
    )
    return entry, mp3


def write_manifest(manifest: Manifest, folder: Path) -> None:
    """Write the manifest beside the audio, in a stable order, so a run that changes nothing changes no file."""
    body = yaml.safe_dump(manifest.model_dump(mode="json"), sort_keys=False, default_flow_style=None, width=120)
    (folder / MANIFEST_NAME).write_text(MANIFEST_HEADER + body, encoding="utf-8")


def read_manifest(folder: Path | None = None) -> Manifest:
    """Read the manifest of the committed audio."""
    return read_data_file((folder or audio_dir()) / MANIFEST_NAME, Manifest)


def synthesise(scripts: dict[str, Script], folder: Path, flite: str) -> Manifest:
    """Speak every script, write each meeting's MP3 and the manifest into `folder`, and return the manifest."""
    folder.mkdir(parents=True, exist_ok=True)
    # A run for some meetings keeps the manifest entries of the others.
    kept = read_manifest(folder).meetings if (folder / MANIFEST_NAME).is_file() else {}
    entries: dict[str, AudioEntry] = dict(kept)
    for key, script in scripts.items():
        entry, mp3 = make_entry(key, render(script, flite))
        (folder / entry.file).write_bytes(mp3)
        entries[key] = entry
    manifest = Manifest(engine=engine_name(flite), sample_rate=SAMPLE_RATE, meetings=dict(sorted(entries.items())))
    write_manifest(manifest, folder)
    return manifest


def check_audio(scripts: dict[str, Script], folder: Path | None = None) -> list[str]:
    """Say how the committed audio and its manifest disagree with each other and the scripts; none means they agree."""
    where = folder or audio_dir()
    manifest = read_manifest(where)
    without_script = sorted(set(manifest.meetings) - set(scripts))
    problems: list[str] = [f"the manifest lists {key}, which has no script" for key in without_script]
    for key, script in scripts.items():
        entry = manifest.meetings.get(key)
        if entry is None:
            problems.append(f"{key} has no audio in the manifest")
            continue
        path = where / entry.file
        data = path.read_bytes() if path.is_file() else b""
        if hashlib.sha256(data).hexdigest() != entry.sha256 or len(data) != entry.bytes:
            problems.append(f"{entry.file} is not the file the manifest describes")
        if len(entry.turns) != len(script.turns):
            problems.append(f"{key}: the manifest times {len(entry.turns)} turns, the script has {len(script.turns)}")
    return problems
