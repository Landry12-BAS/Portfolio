"""The two ways a recording becomes words: fast, through the gateway, and private, on our own server.

Both take the decoded audio (16 kHz mono 16-bit PCM, lb09/audio.py) and give a `Transcript`. Fast mode
sends it to the gateway's `lb-stt` alias (Groq's Whisper, then Workers AI's) as the WAV the gateway
measures. Private mode runs faster-whisper on the box, on the CPU, with a small model in 8-bit, whose
weights come from the image build (`LB09_WHISPER_DIR`; docs/DEPLOY.md): it makes no network call of any
kind, which a test proves by running it with every socket refused. Either way the audio never goes in a
log, a span or the database; the span holds the seconds, the segment count and the model's name.
"""

import fcntl
import logging
import os
import tempfile
import time
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Protocol

import numpy as np
from django.conf import settings
from numpy.typing import NDArray
from openai import OpenAIError

from lb09.limits import MAX_SEGMENTS
from lb09.transcript import RawSegment, Transcript, clean
from lb_common.audio import wav_from_pcm
from lb_common.gateway import Transcription

logger = logging.getLogger(__name__)

# What `transcriber` says when private mode ran, before the model's own name.
PRIVATE_PREFIX = "local/faster-whisper"

# One private transcription runs at a time in the worker's container. The model needs about 480 MiB while it
# works (measured on a one-minute recording: README, "Measured"), and two at once took the whole worker to
# 974 MiB of its 1024: past that the kernel kills a process. The lock is a file lock, which the kernel lets go
# of when the process holding it ends, so a child that is killed mid-run never leaves the next meeting waiting.
PRIVATE_LOCK_PATH = Path(tempfile.gettempdir()) / "lb09-private-transcription.lock"
# How long a meeting waits for its turn: a minute of audio takes the model well under a minute on the box,
# and a task has 150 seconds in all (lb09/limits.py), so a meeting that waited this long would have no time left.
PRIVATE_LOCK_WAIT_SECONDS = 90.0
# How often a waiting meeting looks again.
PRIVATE_LOCK_POLL_SECONDS = 0.25


class TranscriberError(Exception):
    """The transcriber could not transcribe the recording."""


@contextmanager
def one_private_transcription_at_a_time(
    wait_seconds: float | None = None, poll_seconds: float | None = None
) -> Iterator[None]:
    """Hold the container's one place for a private transcription, waiting for it, or fail when it does not come.

    The lock is on a file that is never followed through a link, and is held on the open descriptor: closing
    it, which a dying process does too, gives the place up. The file and the waits are read when the place is
    asked for, so a test can give it a folder and a short wait of its own.
    """
    wait = PRIVATE_LOCK_WAIT_SECONDS if wait_seconds is None else wait_seconds
    poll = PRIVATE_LOCK_POLL_SECONDS if poll_seconds is None else poll_seconds
    descriptor = os.open(PRIVATE_LOCK_PATH, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        deadline = time.monotonic() + wait
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TranscriberError("Another private transcription held the model for too long.") from None
                time.sleep(poll)
        yield
    finally:
        os.close(descriptor)


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
        self, audio: NDArray[np.float32], language: str | None, beam_size: int, vad_filter: bool
    ) -> tuple[Iterable[WhisperSegmentLike], WhisperInfoLike]:
        """Transcribe samples as floats from -1 to 1 at 16 kHz.

        The samples must be a numpy array: faster-whisper takes anything else for a file to open and decode.
        """
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
        """Run the model on the samples, with the fastest settings that keep the timestamps, one meeting at a time."""
        try:
            with one_private_transcription_at_a_time():
                segments, info = self.model().transcribe(
                    pcm_as_floats(pcm), language=language, beam_size=1, vad_filter=False
                )
                # The segments are made as they are read, so the work is done here, inside the lock.
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


def pcm_as_floats(pcm: bytes) -> NDArray[np.float32]:
    """Read 16-bit little-endian PCM as the floats from -1 to 1 the model takes, in the numpy array it insists on."""
    samples = np.frombuffer(pcm, dtype="<i2")
    return samples.astype(np.float32) / np.float32(32_768.0)


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
