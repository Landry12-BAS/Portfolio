"""The two ways a recording becomes words: fast, through the gateway, and private, on our own server.

Both take the decoded audio (16 kHz mono 16-bit PCM, lb09/audio.py) and give a `Transcript`. Fast mode
sends it to the gateway's `lb-stt` alias (Groq's Whisper, then Workers AI's) as the WAV the gateway
measures. Private mode runs faster-whisper on the box, on the CPU, with a small model in 8-bit, whose
weights come from the image build (`LB09_WHISPER_DIR`; docs/DEPLOY.md): it makes no network call of any
kind, which a test proves by running it with every socket refused. Either way the audio never goes in a
log, a span or the database; the span holds the seconds, the segment count and the model's name.
"""

import array
import logging
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Protocol

from django.conf import settings
from openai import OpenAIError

from lb09.limits import MAX_SEGMENTS
from lb09.transcript import RawSegment, Transcript, clean
from lb_common.audio import wav_from_pcm
from lb_common.gateway import Transcription

logger = logging.getLogger(__name__)

# What `transcriber` says when private mode ran, before the model's own name.
PRIVATE_PREFIX = "local/faster-whisper"


class TranscriberError(Exception):
    """The transcriber could not transcribe the recording."""


class Transcriber(Protocol):
    """Turns decoded audio into a transcript."""

    @property
    def mode(self) -> str:
        """`fast` or `private`."""
        ...

    def transcribe(self, pcm: bytes, language: str | None) -> Transcript:
        """Transcribe 16 kHz mono 16-bit PCM, in `language` or in the language the model hears."""
        ...


class GatewayTranscribes(Protocol):
    """The part of lb_common.gateway.Gateway fast mode uses."""

    def transcribe(self, wav: bytes, language: str | None = None, model: str = "lb-stt") -> Transcription:
        """Transcribe a WAV recording through the gateway."""
        ...


class FastTranscriber:
    """Fast mode: Whisper through the gateway, which picks the provider and counts the seconds."""

    mode = "fast"

    def __init__(self, gateway: GatewayTranscribes) -> None:
        """Send recordings through `gateway`."""
        self.gateway = gateway

    def transcribe(self, pcm: bytes, language: str | None) -> Transcript:
        """Send the recording as WAV and clean what comes back; a gateway failure is a transcriber error."""
        try:
            answer = self.gateway.transcribe(wav_from_pcm(pcm), language)
        except OpenAIError as error:
            raise TranscriberError("The gateway could not transcribe the recording.") from error
        raw = [
            RawSegment(
                start=segment.start,
                end=segment.end,
                text=segment.text,
                no_speech_prob=segment.no_speech_prob,
                avg_logprob=segment.avg_logprob,
            )
            for segment in answer.segments
        ]
        return Transcript(language=answer.language, model="lb-stt", segments=clean(raw))


class WhisperSegmentLike(Protocol):
    """The fields of a faster-whisper segment the adapter reads."""

    @property
    def start(self) -> float:
        """Seconds from the start of the recording."""
        ...

    @property
    def end(self) -> float:
        """Seconds from the start of the recording."""
        ...

    @property
    def text(self) -> str:
        """The words."""
        ...

    @property
    def no_speech_prob(self) -> float:
        """How likely the model thought the segment held no speech."""
        ...

    @property
    def avg_logprob(self) -> float:
        """The model's average log-probability over the segment."""
        ...


class WhisperInfoLike(Protocol):
    """The fields of faster-whisper's transcription info the adapter reads."""

    @property
    def language(self) -> str:
        """The language the model heard, as a code such as `en`."""
        ...


class WhisperModelLike(Protocol):
    """What the adapter asks of a faster-whisper model, so a test can give it a stub."""

    def transcribe(
        self, audio: "array.array[float]", language: str | None, beam_size: int, vad_filter: bool
    ) -> tuple[Iterable[WhisperSegmentLike], WhisperInfoLike]:
        """Transcribe samples as floats from -1 to 1 at 16 kHz."""
        ...


class PrivateTranscriber:
    """Private mode: faster-whisper on this machine, CPU, int8, loaded once from the image's weights."""

    mode = "private"

    def __init__(self, model: WhisperModelLike | None = None, model_name: str = "") -> None:
        """Use `model` (a test's stub), or load the real one from `LB09_WHISPER_DIR` on first use."""
        self._model = model
        self.model_name = model_name or whisper_model_name()

    def model(self) -> WhisperModelLike:
        """Return the model, loading it from the local weights the first time; nothing is downloaded."""
        if self._model is None:
            self._model = load_whisper_model(whisper_dir())
        return self._model

    def transcribe(self, pcm: bytes, language: str | None) -> Transcript:
        """Run the model on the samples, with the fastest settings that keep the timestamps."""
        try:
            segments, info = self.model().transcribe(
                pcm_as_floats(pcm), language=language, beam_size=1, vad_filter=False
            )
            raw = [
                RawSegment(
                    start=float(segment.start),
                    end=float(segment.end),
                    text=str(segment.text),
                    no_speech_prob=float(segment.no_speech_prob),
                    avg_logprob=float(segment.avg_logprob),
                )
                for _, segment in zip(range(MAX_SEGMENTS * 2), segments, strict=False)
            ]
        except (RuntimeError, ValueError, OSError) as error:
            raise TranscriberError("The private model could not transcribe the recording.") from error
        return Transcript(language=str(info.language), model=f"{PRIVATE_PREFIX}/{self.model_name}", segments=clean(raw))


def pcm_as_floats(pcm: bytes) -> "array.array[float]":
    """Read 16-bit PCM as the floats from -1 to 1 the model takes."""
    samples: array.array[int] = array.array("h")
    samples.frombytes(pcm)
    if sys.byteorder == "big":
        samples.byteswap()
    return array.array("f", (sample / 32_768.0 for sample in samples))


def whisper_dir() -> Path:
    """Return the folder the private model's weights live in (`LB09_WHISPER_DIR`)."""
    configured = getattr(settings, "LB09_WHISPER_DIR", None)
    if not configured:
        raise TranscriberError("LB09_WHISPER_DIR is not set, so private mode has no model to run.")
    return Path(configured)


def whisper_model_name() -> str:
    """Name the private model by its weights folder, such as `small-int8`, or say none is set."""
    configured = getattr(settings, "LB09_WHISPER_DIR", None)
    return Path(configured).name if configured else "unset"


def load_whisper_model(folder: Path) -> WhisperModelLike:
    """Load faster-whisper from a local folder only: no download, no network, CPU, int8."""
    if not folder.is_dir():
        raise TranscriberError("The private model's weights are not in the image: see docs/DEPLOY.md, LB-09.")
    try:
        from faster_whisper import WhisperModel
    except ImportError as error:
        raise TranscriberError("faster-whisper is not installed, so private mode cannot run.") from error
    model: WhisperModelLike = WhisperModel(str(folder), device="cpu", compute_type="int8", local_files_only=True)
    return model
