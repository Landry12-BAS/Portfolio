"""Unit tests for the two transcribers: fast mode's call through the gateway, and private mode's run with no network.

Private mode is tested with a stub in place of the faster-whisper model, since the weights are not here, and
with every socket refused, which proves it makes no outbound call. The real model's loading is held to a local
folder only.
"""

import socket
import subprocess
import sys
import threading
import time
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pytest
from lb09 import transcribers
from lb09.transcribers import (
    PRIVATE_PREFIX,
    FastTranscriber,
    PrivateTranscriber,
    TranscriberError,
    load_whisper_model,
    one_private_transcription_at_a_time,
    pcm_as_floats,
)
from pytest_django.fixtures import Settings

from lb_common.gateway import GatewayResponseError, Transcription, TranscriptSegment

PCM = b"\x00\x40" * 16_000


@dataclass
class FakeGatewayAudio:
    """Stands in for the gateway's transcribe call: remembers the WAV and the language, answers or fails."""

    fails: bool = False
    wavs: list[bytes] = None  # type: ignore[assignment]
    languages: list[str | None] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        """Start with nothing heard."""
        self.wavs = []
        self.languages = []

    def transcribe(self, wav: bytes, language: str | None = None, model: str = "lb-stt") -> Transcription:  # noqa: ARG002 - the gateway's signature
        """Answer with two segments, one of which the model doubted."""
        self.wavs.append(wav)
        self.languages.append(language)
        if self.fails:
            raise GatewayResponseError("lb-stt is unavailable.")
        return Transcription(
            language="English",
            duration=1.0,
            text="Hello there. Thanks for watching.",
            segments=[
                TranscriptSegment(id=0, start=0.0, end=0.6, text="Hello there.", avg_logprob=-0.2, no_speech_prob=0.01),
                TranscriptSegment(id=1, start=0.6, end=1.0, text="Thanks for watching.", no_speech_prob=0.95),
            ],
        )


def test_fast_mode_sends_the_recording_as_the_wav_the_gateway_measures_and_cleans_the_answer() -> None:
    """The WAV header says 16 kHz mono 16-bit, the language goes along, and the doubted segment is dropped."""
    gateway = FakeGatewayAudio()
    transcript = FastTranscriber(gateway).transcribe(PCM, "en")
    assert gateway.wavs[0][:4] == b"RIFF"
    assert gateway.wavs[0][44:] == PCM
    assert gateway.languages == ["en"]
    assert transcript.model == "lb-stt"
    assert transcript.language == "English"
    assert [s.text for s in transcript.segments] == ["Hello there."]


def test_fast_mode_reports_a_gateway_failure_as_a_transcriber_error() -> None:
    """The pipeline sees one kind of error whichever transcriber failed."""
    with pytest.raises(TranscriberError):
        FastTranscriber(FakeGatewayAudio(fails=True)).transcribe(PCM, None)


@dataclass(frozen=True)
class StubSegment:
    """A segment as faster-whisper yields it."""

    start: float
    end: float
    text: str
    no_speech_prob: float = 0.0
    avg_logprob: float = -0.1


@dataclass(frozen=True)
class StubInfo:
    """The transcription info as faster-whisper returns it."""

    language: str = "en"


class StubWhisper:
    """Stands in for a faster-whisper model: yields a fixed transcript, and remembers what it was given.

    It takes the audio as the real model does: faster-whisper decodes anything that is not a numpy array as a
    file (`transcribe` calls `decode_audio` on it), so samples handed over any other way never reach the model.
    """

    def __init__(self, fails: bool = False) -> None:
        """Start with nothing heard."""
        self.fails = fails
        self.audio: list[np.ndarray] = []
        self.options: list[dict[str, object]] = []

    def transcribe(
        self, audio: np.ndarray, language: str | None, beam_size: int, vad_filter: bool
    ) -> tuple[Iterable[StubSegment], StubInfo]:
        """Yield two segments, lazily, as the real model does, from samples given the way it takes them."""
        if not isinstance(audio, np.ndarray):
            raise TypeError("faster-whisper would open this as a file to decode, not read it as samples")
        assert audio.dtype == np.float32
        assert audio.ndim == 1
        self.audio.append(audio)
        self.options.append({"language": language, "beam_size": beam_size, "vad_filter": vad_filter})
        if self.fails:
            raise RuntimeError("the model broke")

        def segments() -> Iterable[StubSegment]:
            """Yield the segments one by one."""
            yield StubSegment(0.0, 0.5, " Hello there. ")
            yield StubSegment(0.5, 1.0, "Again.")

        return segments(), StubInfo()


@pytest.fixture
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Refuse every socket, so any outbound call fails the test."""

    def refuse(*args: object, **kwargs: object) -> None:
        """Fail on any attempt to open a socket."""
        raise AssertionError("private mode opened a socket")

    monkeypatch.setattr(socket, "socket", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)


@pytest.mark.usefixtures("no_network")
def test_private_mode_transcribes_with_no_network_at_all(settings: Settings) -> None:
    """With every socket refused, private mode still transcribes: the model is local, and so is everything else."""
    settings.LB09_WHISPER_DIR = "/opt/whisper/small-int8"
    model = StubWhisper()
    transcript = PrivateTranscriber(model).transcribe(PCM, "en")
    assert [s.text for s in transcript.segments] == ["Hello there.", "Again."]
    assert transcript.model == f"{PRIVATE_PREFIX}/small-int8"
    assert transcript.language == "en"
    assert model.options == [{"language": "en", "beam_size": 1, "vad_filter": False}]
    assert len(model.audio[0]) == 16_000
    assert abs(model.audio[0][0] - 0x4000 / 32_768) < 1e-6


@pytest.mark.usefixtures("no_network")
def test_private_mode_reports_a_model_failure_as_a_transcriber_error() -> None:
    """A model that raises is a transcriber error, never a crash with the audio in its message."""
    with pytest.raises(TranscriberError):
        PrivateTranscriber(StubWhisper(fails=True), model_name="stub").transcribe(PCM, None)


def test_the_samples_become_floats_from_minus_one_to_one() -> None:
    """16-bit PCM is read as the floats the model takes."""
    floats = pcm_as_floats(b"\x00\x80\xff\x7f\x00\x00")
    assert [round(value, 4) for value in floats] == [-1.0, 1.0, 0.0]


def test_the_real_model_is_loaded_from_local_weights_only(tmp_path: Path, settings: Settings) -> None:
    """Without the weights folder private mode says so; nothing is ever downloaded."""
    with pytest.raises(TranscriberError, match="not in the image"):
        load_whisper_model(tmp_path / "missing")
    settings.LB09_WHISPER_DIR = None
    with pytest.raises(TranscriberError, match="LB09_WHISPER_DIR"):
        PrivateTranscriber().model()


@pytest.fixture
def private_place(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Give the private transcription's one place a file and a short wait of this test's own, and return the file."""
    path = tmp_path / "private.lock"
    monkeypatch.setattr(transcribers, "PRIVATE_LOCK_PATH", path)
    monkeypatch.setattr(transcribers, "PRIVATE_LOCK_WAIT_SECONDS", 0.3)
    monkeypatch.setattr(transcribers, "PRIVATE_LOCK_POLL_SECONDS", 0.02)
    return path


@pytest.mark.usefixtures("private_place")
def test_private_mode_runs_the_model_while_it_holds_the_one_place() -> None:
    """The model runs inside the lock: another private transcription asked for its place meanwhile is refused."""
    seen: list[str] = []

    class ProbingWhisper(StubWhisper):
        """A model that looks, while it works, whether a second transcription could start."""

        def transcribe(
            self, audio: np.ndarray, language: str | None, beam_size: int, vad_filter: bool
        ) -> tuple[Iterable[StubSegment], StubInfo]:
            """Ask for the place from inside the run, and say what came of it."""
            try:
                with one_private_transcription_at_a_time(wait_seconds=0.0):
                    seen.append("free")
            except TranscriberError:
                seen.append("held")
            return super().transcribe(audio, language, beam_size, vad_filter)

    PrivateTranscriber(ProbingWhisper(), model_name="stub").transcribe(PCM, "en")
    assert seen == ["held"]


@pytest.mark.usefixtures("private_place")
def test_a_second_private_transcription_gives_up_when_the_first_holds_the_place_too_long() -> None:
    """A meeting that cannot get its turn in time fails as the transcriber's, which gives the visitor's place back."""
    with one_private_transcription_at_a_time():
        started = time.monotonic()
        with pytest.raises(TranscriberError, match="held the model"), one_private_transcription_at_a_time():
            pytest.fail("a second transcription started while the first held the place")
        assert time.monotonic() - started >= 0.25
    with one_private_transcription_at_a_time():
        pass


@pytest.mark.usefixtures("private_place")
def test_a_private_transcription_that_waits_runs_when_the_first_has_finished() -> None:
    """Two meetings at once take turns: the second starts when the first lets go."""
    holding = threading.Event()
    order: list[str] = []

    def first() -> None:
        """Hold the place for a moment."""
        with one_private_transcription_at_a_time():
            order.append("first starts")
            holding.set()
            time.sleep(0.15)
            order.append("first ends")

    thread = threading.Thread(target=first)
    thread.start()
    assert holding.wait(2.0)
    with one_private_transcription_at_a_time(wait_seconds=2.0):
        order.append("second starts")
    thread.join()
    assert order == ["first starts", "first ends", "second starts"]


def test_the_place_is_free_again_when_the_process_holding_it_dies(private_place: Path) -> None:
    """A child killed in the middle of a transcription never leaves the next meeting waiting."""
    holding_script = (
        "import fcntl, os, sys, time\n"
        "fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)\n"
        "fcntl.flock(fd, fcntl.LOCK_EX)\n"
        "print('held', flush=True)\n"
        "time.sleep(60)\n"
    )
    with subprocess.Popen(  # noqa: S603 - this interpreter, running a few lines of our own
        [sys.executable, "-c", holding_script, str(private_place)], stdout=subprocess.PIPE, text=True
    ) as holder:
        try:
            assert holder.stdout is not None
            assert holder.stdout.readline().strip() == "held"
            with pytest.raises(TranscriberError), one_private_transcription_at_a_time():
                pytest.fail("the place was taken from a live holder")
        finally:
            holder.kill()
    with one_private_transcription_at_a_time():
        pass


@pytest.mark.usefixtures("private_place", "no_network")
def test_a_model_that_fails_gives_the_place_up() -> None:
    """A failed transcription is a transcriber error, and the next meeting is not kept waiting for it."""
    with pytest.raises(TranscriberError):
        PrivateTranscriber(StubWhisper(fails=True), model_name="stub").transcribe(PCM, None)
    with one_private_transcription_at_a_time(wait_seconds=0.0):
        pass
