"""Offline tests for LB-09's text-to-speech: the committed audio matches its manifest, and the mixing is right.

The audio is made once with Flite and committed, so these tests need no speech engine to run: they check that the
committed files are the ones the manifest describes, that each really holds speech of the length it says, and
that the code which levels, places, mixes and encodes turns does what it says, using a stand-in for the engine.
One test speaks for real, and is skipped where Flite is not installed.
"""

import io
import math
import shutil
from array import array
from pathlib import Path

import av
import pytest
from lb09 import tts
from lb09.scripts import Script, read_scripts
from lb09.timeline import estimate_turn_spans
from lb09.tts import (
    BYTES_PER_SECOND,
    SAMPLE_RATE,
    SpeechEngineError,
    audio_dir,
    check_audio,
    decoded_seconds,
    encode_mp3,
    find_flite,
    level,
    mix,
    read_manifest,
    render,
    samples_of,
)


@pytest.fixture(scope="module")
def scripts() -> dict[str, Script]:
    """Read the scripted meetings once for the module."""
    return read_scripts()


def tone(seconds: float, amplitude: int = 1000, hertz: int = 220) -> bytes:
    """Make a sine tone as 16 kHz mono 16-bit PCM."""
    count = round(seconds * SAMPLE_RATE)
    samples = array("h", (round(amplitude * math.sin(2 * math.pi * hertz * n / SAMPLE_RATE)) for n in range(count)))
    return samples.tobytes()


def rms(pcm: bytes) -> float:
    """Return the root mean square of some PCM audio."""
    samples = samples_of(pcm)
    return math.sqrt(sum(sample * sample for sample in samples) / len(samples))


def test_the_committed_audio_is_what_its_manifest_says(scripts: dict[str, Script]) -> None:
    """Every file matches its size and hash, every meeting has audio, and every turn has a time."""
    assert check_audio(scripts) == []


def test_each_meeting_is_a_recording_the_pipeline_would_accept(scripts: dict[str, Script]) -> None:
    """The audio is under a minute (the limit a visitor's recording meets too) and its turns come in order."""
    manifest = read_manifest()

    assert set(manifest.meetings) == set(scripts)
    for key, entry in manifest.meetings.items():
        assert 5.0 <= entry.seconds <= 55.0, key
        starts = [turn.start for turn in entry.turns]
        assert starts == sorted(starts), key
        assert all(turn.end > turn.start for turn in entry.turns)
        assert entry.turns[-1].end <= entry.seconds, key


def test_the_audio_really_holds_speech_of_the_length_the_manifest_says() -> None:
    """Decoding a committed file gives that many seconds, and it is not silence: a mistake in mixing would be."""
    manifest = read_manifest()
    entry = manifest.meetings["monday-roasting-plan"]
    data = (audio_dir() / entry.file).read_bytes()

    loud = 0
    samples = 0
    with av.open(io.BytesIO(data), mode="r") as container:
        for frame in container.decode(audio=0):
            pcm = bytes(frame.planes[0])[: frame.samples * 2]
            loud += sum(1 for sample in samples_of(pcm) if abs(sample) > 500)
            samples += frame.samples

    assert decoded_seconds(data) == entry.seconds
    assert samples / SAMPLE_RATE == pytest.approx(entry.seconds, abs=0.01)
    assert loud / samples > 0.05


def test_the_estimated_timeline_is_close_to_the_real_one(scripts: dict[str, Script]) -> None:
    """The offline tests run on estimated times, so they must be near what the speech engine made."""
    manifest = read_manifest()
    for key, script in scripts.items():
        estimated = estimate_turn_spans(script)[-1].end
        real = manifest.meetings[key].turns[-1].end
        assert estimated == pytest.approx(real, rel=0.12), key


def test_a_changed_audio_file_or_a_wrong_turn_count_is_caught(scripts: dict[str, Script], tmp_path: Path) -> None:
    """The manifest is a check on the files: a flipped byte, a missing file or a different script all show."""
    for name in (*(entry.file for entry in read_manifest().meetings.values()), tts.MANIFEST_NAME):
        shutil.copy(audio_dir() / name, tmp_path / name)
    victim = tmp_path / "grinder-repair.mp3"
    victim.write_bytes(victim.read_bytes()[:-1] + b"\x00")
    (tmp_path / "weekend-staffing.mp3").unlink()
    check_in = scripts["quarterly-check-in"]
    shorter = {**scripts, "quarterly-check-in": check_in.model_copy(update={"turns": check_in.turns[:-1]})}

    assert check_audio(shorter, tmp_path) == [
        "grinder-repair.mp3 is not the file the manifest describes",
        "quarterly-check-in: the manifest times 6 turns, the script has 5",
        "weekend-staffing.mp3 is not the file the manifest describes",
    ]


def test_leveling_brings_a_quiet_and_a_loud_voice_to_the_same_loudness() -> None:
    """Each turn is scaled to one loudness, so no speaker drowns another."""
    quiet, loud = tone(1.0, amplitude=300), tone(1.0, amplitude=9000)

    assert rms(level(quiet)) == pytest.approx(tts.TARGET_RMS, rel=0.02)
    assert rms(level(loud)) == pytest.approx(tts.TARGET_RMS, rel=0.02)
    assert level(bytes(1000)) == bytes(1000)
    assert level(b"") == b""


def test_leveling_clips_instead_of_wrapping_around() -> None:
    """A sample pushed past the loudest value stays at it, never wraps to the other side."""
    spiky = array("h", [0] * 100 + [30000, -30000] + [0] * 100).tobytes()

    result = samples_of(level(spiky, target=20000.0))

    assert max(result) == 32767
    assert min(result) == -32768


def test_mixing_adds_overlapping_voices_and_leaves_silence_elsewhere() -> None:
    """Two parts that overlap are summed where they meet; the track is as long as asked."""
    first = array("h", [1000] * SAMPLE_RATE).tobytes()
    second = array("h", [500] * SAMPLE_RATE).tobytes()

    mixed = samples_of(mix([(0.0, first), (0.5, second)], seconds=2.0))

    assert len(mixed) == 2 * SAMPLE_RATE
    assert mixed[SAMPLE_RATE // 4] == 1000
    assert mixed[int(SAMPLE_RATE * 0.75)] == 1500
    assert mixed[int(SAMPLE_RATE * 1.25)] == 500
    assert mixed[int(SAMPLE_RATE * 1.75)] == 0


def test_mixing_clips_a_sum_that_is_too_loud() -> None:
    """Two loud voices on top of each other are limited, not wrapped."""
    loud = array("h", [30000] * 100).tobytes()

    mixed = samples_of(mix([(0.0, loud), (0.0, loud)], seconds=0.01))

    assert set(mixed[:100]) == {32767}
    assert set(mixed[100:]) == {0}


def test_encoding_to_mp3_and_decoding_again_keeps_the_length() -> None:
    """A tone goes in as PCM and comes out of a decoder as audio of about the same length, in a file much smaller."""
    pcm = tone(3.0)

    mp3 = encode_mp3(pcm)

    assert decoded_seconds(mp3) == pytest.approx(3.0, abs=0.15)
    # 32 kilobits a second against 256 for the PCM is eight times smaller.
    assert len(mp3) < len(pcm) / 6


def test_a_script_is_rendered_turn_by_turn_with_pauses_and_overlaps(
    scripts: dict[str, Script], monkeypatch: pytest.MonkeyPatch
) -> None:
    """With a stand-in engine that speaks a tone as long as the words, the timeline and the mix are laid out right."""
    spoken: list[tuple[str, str]] = []

    def stand_in(text: str, voice: str, _flite: str) -> bytes:
        """Speak a tone that lasts a quarter second a word, and note what was asked."""
        spoken.append((voice, text))
        return tone(0.25 * len(text.split()))

    monkeypatch.setattr(tts, "speak", stand_in)
    script = scripts["tasting-notes-overlap"]

    rendered = render(script, "flite")

    assert [voice for voice, _ in spoken] == ["slt", "rms", "awb", "slt"]
    assert [text for _, text in spoken] == [turn.text for turn in script.turns]
    spans = rendered.spans
    assert spans[1].start == pytest.approx(spans[0].end - 1.2, abs=0.002)
    assert spans[2].start == pytest.approx(spans[1].end - 1.0, abs=0.002)
    assert len(rendered.pcm) / BYTES_PER_SECOND == pytest.approx(spans[-1].end + 0.3, abs=0.01)
    # Where the first two turns overlap, both voices are in the mix, so it is louder there than in the first turn alone.
    start = round((spans[0].end - 0.9) * SAMPLE_RATE)
    overlapped = rms(rendered.pcm[start * 2 : (start + 4000) * 2])
    alone = rms(rendered.pcm[round(0.5 * SAMPLE_RATE) * 2 : round(1.0 * SAMPLE_RATE) * 2])
    assert overlapped > alone * 1.1


def test_a_machine_without_flite_is_told_how_to_get_it(monkeypatch: pytest.MonkeyPatch) -> None:
    """The command stops with the way to install the engine, and changes no committed file."""
    monkeypatch.setattr(shutil, "which", lambda _name: None)

    with pytest.raises(SpeechEngineError, match="apt-get install flite"):
        find_flite()


@pytest.mark.skipif(shutil.which("flite") is None, reason="Flite is not installed here")
def test_flite_speaks_every_voice_the_scripts_may_use_at_16_khz() -> None:
    """With the real engine: each voice makes audio of a plausible length, so the voices in the schema all exist."""
    flite = find_flite()
    for voice in ("slt", "rms", "awb", "kal16"):
        seconds = len(tts.speak("Good morning everyone.", voice, flite)) / BYTES_PER_SECOND
        assert 0.8 < seconds < 3.0, voice
