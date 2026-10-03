"""Unit tests for the two transcribers: fast mode's call through the gateway, and private mode's run with no network.

Private mode is tested with a stub in place of the faster-whisper model, since the weights are not here, and
with every socket refused, which proves it makes no outbound call. The real model's loading is held to a local
folder only.
"""

import socket
from array import array
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

import pytest
from lb09.transcribers import (
    PRIVATE_PREFIX,
    FastTranscriber,
    PrivateTranscriber,
    TranscriberError,
    load_whisper_model,
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
    """Stands in for a faster-whisper model: yields a fixed transcript, and remembers what it was given."""

    def __init__(self, fails: bool = False) -> None:
        """Start with nothing heard."""
        self.fails = fails
        self.audio: list[array[float]] = []
        self.options: list[dict[str, object]] = []

    def transcribe(
        self, audio: array[float], language: str | None, beam_size: int, vad_filter: bool
    ) -> tuple[Iterable[StubSegment], StubInfo]:
        """Yield two segments, lazily, as the real model does."""
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
