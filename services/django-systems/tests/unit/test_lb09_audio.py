"""Unit tests for how LB-09 takes audio in: the containers it knows, the byte cap, and the bounded decoder.

The decoder runs in a child process on real files: the committed sample (measured against its manifest), a
WAV made here that is too long, one that is too short, bytes that are no audio at all, and a deadline so
short the child can't even start, which is how a decoder bomb is stopped.
"""

import struct
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
from lb09 import decode_child
from lb09.audio import AudioRefusedError, Container, check_upload, decode_recording, measure, sniff_container
from lb09.limits import MAX_RECORDING_SECONDS, MAX_UPLOAD_BYTES
from lb09.tts import audio_dir, read_manifest

from lb_common.audio import wav_from_pcm

# One second of 16 kHz mono 16-bit silence.
SILENT_SECOND = bytes(32_000)


def wav_of_silence(seconds: float, rate: int = 16_000) -> bytes:
    """Make a WAV of silence of the given length, at 16 kHz or another rate the decoder must resample."""
    if rate == 16_000:
        return wav_from_pcm(bytes(int(seconds * 32_000)))
    pcm = bytes(int(seconds * rate * 2))
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + len(pcm),
        b"WAVE",
        b"fmt ",
        16,
        1,
        1,
        rate,
        rate * 2,
        2,
        16,
        b"data",
        len(pcm),
    )
    return header + pcm


@pytest.mark.parametrize(
    ("head", "container"),
    [
        (b"\x1a\x45\xdf\xa3" + bytes(20), Container.WEBM),
        (b"OggS" + bytes(20), Container.OGG),
        (b"\x00\x00\x00\x18ftypisom" + bytes(20), Container.MP4),
        (wav_from_pcm(SILENT_SECOND)[:44], Container.WAV),
        (b"ID3\x04" + bytes(20), Container.MP3),
        (b"\xff\xfb\x90\x00" + bytes(20), Container.MP3),
    ],
)
def test_the_known_containers_are_told_by_their_first_bytes(head: bytes, container: Container) -> None:
    """Each container a browser's recorder, or a sample, writes is recognised from its magic bytes."""
    assert sniff_container(head) is container


@pytest.mark.parametrize("head", [b"", b"GIF89a", b"%PDF-1.7", b"<html>", b"\x00" * 30, b"RIFF\x00\x00\x00\x00AVI "])
def test_anything_else_is_not_audio(head: bytes) -> None:
    """Text, images, documents and other RIFF files are not containers the recorder takes."""
    assert sniff_container(head) is None


def test_the_upload_check_refuses_an_oversize_body_before_looking_at_it() -> None:
    """A body past the byte cap is refused as too big, whatever it starts with."""
    with pytest.raises(AudioRefusedError) as refused:
        check_upload(b"OggS" + bytes(MAX_UPLOAD_BYTES))
    assert refused.value.reason == "too_big"


def test_the_upload_check_refuses_an_unknown_container() -> None:
    """Bytes in no known container are refused as undecodable, and never reach the decoder."""
    with pytest.raises(AudioRefusedError) as refused:
        check_upload(b"not audio at all")
    assert refused.value.reason == "undecodable"
    assert check_upload(wav_from_pcm(SILENT_SECOND)) is Container.WAV


def test_the_committed_sample_decodes_to_the_length_its_manifest_records() -> None:
    """The decoder measures the sample from its samples, and agrees with the manifest to the hundredth."""
    manifest = read_manifest()
    entry = manifest.meetings["grinder-repair"]
    decoded = decode_recording(audio_dir() / entry.file)
    assert abs(decoded.seconds - entry.seconds) < 0.01
    assert len(decoded.pcm) == round(decoded.seconds * 32_000)


def test_a_recording_at_another_rate_is_resampled_to_16_khz(tmp_path: Path) -> None:
    """A 44.1 kHz WAV comes out as 16 kHz mono PCM of the same length."""
    path = tmp_path / "studio.wav"
    path.write_bytes(wav_of_silence(2.0, rate=44_100))
    decoded = decode_recording(path)
    assert abs(decoded.seconds - 2.0) < 0.01


def test_the_decoder_child_gets_none_of_the_workers_secrets(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The child's whole environment is its import path and three Python settings, and it still decodes from any folder.

    The worker holds the database and Redis passwords and the gateway's service key in its environment. The decoder
    child is where a visitor's bytes meet a native decoder, so a file that took it over must find none of them: the
    test gives the parent canaries, spies on the environment the child is started with, and decodes a real file.
    """
    monkeypatch.setenv("LB_PG_PASSWORD_LB09", "canary-database-password")
    monkeypatch.setenv("LB_REDIS_URL", "redis://:canary-redis-password@redis:6379/0")
    monkeypatch.setenv("LB_GATEWAY_SERVICE_KEY", "canary-gateway-key")
    seen: list[dict[str, str]] = []
    real_run = subprocess.run

    def spy(command: list[str], **options: Any) -> subprocess.CompletedProcess[bytes]:
        """Remember the environment the child was started with, then start it."""
        seen.append(options["env"])
        return real_run(command, **options)

    monkeypatch.setattr("lb09.audio.subprocess.run", spy)
    path = tmp_path / "quiet.wav"
    path.write_bytes(wav_of_silence(1.0))
    # The child is imported by its module path, which has to work from a folder that is not the service's.
    monkeypatch.chdir(tmp_path)

    decoded = decode_recording(path)

    assert abs(decoded.seconds - 1.0) < 0.01
    assert len(seen) == 1
    assert set(seen[0]) == {"PYTHONPATH", "PYTHONDONTWRITEBYTECODE", "PYTHONNOUSERSITE", "PYTHONUTF8"}
    assert "canary" not in " ".join(seen[0].values())


def test_the_decoder_is_pinned_to_the_sniffed_container_and_never_probes(tmp_path: Path) -> None:
    """A file whose first bytes say one container is decoded only with that container's demuxer.

    FFmpeg's own probing would let an upload that passes the container check (mp3 here, by its ID3 tag) be
    decoded as whatever FFmpeg detects, reaching a demuxer the gate never meant (concat, sdp, hls, dash).
    So the child is handed the sniffed container and opens the recording only with that demuxer: the real
    mp3 sample decodes as mp3, is refused when the demuxer is forced wrong, and an unknown container is refused.
    """
    sample = audio_dir() / read_manifest().meetings["grinder-repair"].file
    output = tmp_path / "out.pcm"

    def run(container: str) -> int:
        """Run the decode child on the sample, telling it the container, and return its exit code."""
        output.unlink(missing_ok=True)
        command = [
            sys.executable,
            "-m",
            decode_child.__name__,
            str(sample),
            str(output),
            "62",
            "10",
            str(1024**3),
            container,
        ]
        return subprocess.run(command, capture_output=True, timeout=30, check=False).returncode  # noqa: S603

    assert run("mp3") in (decode_child.WHOLE, decode_child.CUT)
    assert output.stat().st_size > 0
    # The same bytes, told they are a WAV: the mp3 is not fed to the wav demuxer, so nothing is decoded.
    assert run("wav") == decode_child.UNREADABLE
    # A container the child does not know is refused before the decoder starts.
    assert run("io.open") == decode_child.UNREADABLE


def test_a_body_that_sniffs_as_one_container_but_holds_another_is_refused(tmp_path: Path) -> None:
    """An ID3 tag (sniffed as mp3) in front of a real Ogg/Opus recording is refused, never silently decoded.

    With FFmpeg left to probe, such a file decodes as Ogg though the gate accepted it as mp3; pinning the
    decoder to the sniffed container refuses the mismatch, so the container the gate approved is the only
    one the decoder will read.
    """
    ogg = ogg_opus_of_tone(tmp_path / "real.ogg", seconds=3.0)
    smuggled = tmp_path / "smuggled.audio"
    smuggled.write_bytes(b"ID3\x04\x00\x00\x00\x00\x00\x00" + ogg)
    assert check_upload(smuggled.read_bytes()) is Container.MP3
    with pytest.raises(AudioRefusedError) as refused:
        decode_recording(smuggled)
    assert refused.value.reason == "undecodable"


def ogg_opus_of_tone(path: Path, seconds: float) -> bytes:
    """Write a short Ogg/Opus recording of a tone and return its bytes, for a container-confusion test."""
    import math
    from fractions import Fraction

    import av
    import numpy

    with av.open(str(path), mode="w", format="ogg") as output:
        stream = output.add_stream("libopus", rate=48_000, layout="mono")
        for start in range(0, int(seconds * 48_000), 960):
            moment = (numpy.arange(start, start + 960) / 48_000).astype(numpy.float32)
            frame = av.AudioFrame.from_ndarray(
                (0.3 * numpy.sin(2 * math.pi * 220 * moment)).reshape(1, -1), format="flt", layout="mono"
            )
            frame.sample_rate = 48_000
            frame.pts = start
            frame.time_base = Fraction(1, 48_000)
            for packet in stream.encode(frame):
                output.mux(packet)
        for packet in stream.encode(None):
            output.mux(packet)
    return path.read_bytes()


def test_a_recording_over_a_minute_is_refused_from_its_decoded_length(tmp_path: Path) -> None:
    """A header could lie; the samples can't. Over sixty seconds is too long, and the child stopped early."""
    path = tmp_path / "long.wav"
    path.write_bytes(wav_of_silence(70.0))
    with pytest.raises(AudioRefusedError) as refused:
        decode_recording(path)
    assert refused.value.reason == "too_long"


def test_a_recording_under_half_a_second_is_refused(tmp_path: Path) -> None:
    """Nothing can be said in a fifth of a second."""
    path = tmp_path / "blip.wav"
    path.write_bytes(wav_of_silence(0.2))
    with pytest.raises(AudioRefusedError) as refused:
        decode_recording(path)
    assert refused.value.reason == "too_short"


def test_bytes_that_are_no_audio_are_undecodable(tmp_path: Path) -> None:
    """A file that passed the magic-byte check but holds nothing decodable is refused, not crashed on."""
    path = tmp_path / "fake.ogg"
    path.write_bytes(b"OggS" + bytes(range(256)) * 8)
    with pytest.raises(AudioRefusedError) as refused:
        decode_recording(path)
    assert refused.value.reason == "undecodable"


def test_a_decoder_that_runs_past_its_deadline_is_killed(tmp_path: Path) -> None:
    """The wall-clock bound: a child that is not done in time is stopped, and the recording refused."""
    path = tmp_path / "slow.wav"
    path.write_bytes(wav_of_silence(5.0))
    with pytest.raises(AudioRefusedError) as refused:
        decode_recording(path, wall_seconds=0.001)
    assert refused.value.reason == "decode_limit"


def test_a_decoder_that_needs_more_memory_than_allowed_is_stopped(tmp_path: Path) -> None:
    """The memory bound: a child capped below what the decoder needs cannot decode, and the recording is refused.

    The kernel's refusal shows up either as a child that dies, or as an allocation the decoder reports as an
    error of its own; both refuse the file, and neither decodes it.
    """
    path = tmp_path / "small.wav"
    path.write_bytes(wav_of_silence(1.0))
    with pytest.raises(AudioRefusedError) as refused:
        decode_recording(path, memory_bytes=16 * 1024 * 1024)
    assert refused.value.reason in ("decode_limit", "undecodable")


def test_measure_holds_decoded_audio_to_the_datasheets_minute() -> None:
    """Exactly a minute passes; a sample more does not."""
    assert measure(bytes(int(MAX_RECORDING_SECONDS * 32_000))).seconds == 60.0
    with pytest.raises(AudioRefusedError):
        measure(bytes(int(MAX_RECORDING_SECONDS * 32_000) + 3_200))
