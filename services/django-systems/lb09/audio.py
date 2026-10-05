"""Audio in, safely: what a recording may be, and how it is decoded without being trusted.

A visitor's recording is untrusted bytes. Before anything reads it as audio its first bytes must say it
is one of the containers a browser's recorder or a sample writes (WebM, Ogg, MP4, WAV, MP3), and it must
fit the byte cap. Then it is decoded in a child process the operating system holds to a CPU, memory and
wall-clock budget (lb09/decode_child.py), into 16 kHz mono 16-bit PCM, and its length is measured from
the samples that came out, never from a header. A recording over a minute, under half a second, in an
unknown container, or built to blow up is refused with a reason the page can explain.

The decoded audio is what the transcribers take (lb09/transcribers.py): the gateway measures that same
format from its bytes, and the private model reads it as samples.
"""

import logging
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Final

from lb09 import decode_child
from lb09.limits import (
    DECODE_CPU_SECONDS,
    DECODE_MEMORY_BYTES,
    DECODE_SLACK_SECONDS,
    DECODE_WALL_SECONDS,
    MAX_RECORDING_SECONDS,
    MAX_UPLOAD_BYTES,
    MIN_RECORDING_SECONDS,
)
from lb_common.audio import BYTES_PER_SECOND

logger = logging.getLogger(__name__)


# Enough of a file's start to tell its container from (the WAV check reaches byte 12); reading a few spare
# bytes costs nothing.
HEAD_BYTES: Final = 64


class Container(StrEnum):
    """The audio containers a recording may arrive in, told apart by their first bytes."""

    WEBM = "webm"
    OGG = "ogg"
    MP4 = "mp4"
    WAV = "wav"
    MP3 = "mp3"


# The media types a browser gives a recording of each container, which the API accepts for it.
MEDIA_TYPES: Final[dict[Container, tuple[str, ...]]] = {
    Container.WEBM: ("audio/webm", "video/webm"),
    Container.OGG: ("audio/ogg", "application/ogg"),
    Container.MP4: ("audio/mp4", "audio/x-m4a", "audio/aac", "video/mp4"),
    Container.WAV: ("audio/wav", "audio/x-wav", "audio/wave"),
    Container.MP3: ("audio/mpeg", "audio/mp3"),
}


class AudioRefusedError(Exception):
    """A recording the service will not decode, with the reason as a stable code."""

    def __init__(self, reason: str) -> None:
        """Keep the reason, which is one of `Meeting.Failure`'s codes about audio."""
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class Decoded:
    """A recording decoded: its samples as 16 kHz mono PCM, and its length measured from them."""

    pcm: bytes
    seconds: float


def sniff_container(data: bytes) -> Container | None:
    """Tell a recording's container from its first bytes, or None for anything else."""
    if data.startswith(b"\x1a\x45\xdf\xa3"):
        return Container.WEBM
    if data.startswith(b"OggS"):
        return Container.OGG
    if len(data) >= 12 and data[4:8] == b"ftyp":
        return Container.MP4
    if data.startswith(b"RIFF") and data[8:12] == b"WAVE":
        return Container.WAV
    if data.startswith(b"ID3") or is_mp3_frame(data[:2]):
        return Container.MP3
    return None


def is_mp3_frame(head: bytes) -> bool:
    """Tell whether two bytes are an MPEG audio frame's sync word, as a bare MP3 starts with."""
    return len(head) == 2 and head[0] == 0xFF and head[1] in (0xFB, 0xFA, 0xF3, 0xF2)


def check_upload(data: bytes) -> Container:
    """Refuse an upload that is too big or in no known container, and say which container it is in."""
    if len(data) > MAX_UPLOAD_BYTES:
        raise AudioRefusedError("too_big")
    container = sniff_container(data)
    if container is None:
        raise AudioRefusedError("undecodable")
    return container


def seconds_of(pcm: bytes) -> float:
    """Measure 16 kHz mono PCM, to the millisecond."""
    return round(len(pcm) / BYTES_PER_SECOND, 3)


def decode_recording(
    recording: Path,
    wall_seconds: float = DECODE_WALL_SECONDS,
    cpu_seconds: int = DECODE_CPU_SECONDS,
    memory_bytes: int = DECODE_MEMORY_BYTES,
) -> Decoded:
    """Decode a recording in a bounded child process and measure it, refusing what is too long, too short or unreadable.

    The child stops once it has produced a recording's worth of audio plus a little slack, so a file that would
    decode to hours costs a bounded amount, and the parent kills it when the wall-clock deadline passes.
    """
    most_seconds = MAX_RECORDING_SECONDS + DECODE_SLACK_SECONDS
    # Sniff the container from the stored bytes again, and pin the decoder to that demuxer: the child never
    # lets FFmpeg probe and choose one that opens another file or a URL (lb09/decode_child.py).
    with recording.open("rb") as file:
        container = sniff_container(file.read(HEAD_BYTES))
    if container is None:
        raise AudioRefusedError("undecodable")
    with tempfile.TemporaryDirectory(prefix="lb09-decode-") as folder:
        output = Path(folder) / "audio.pcm"
        command = [
            sys.executable,
            "-m",
            decode_child.__name__,
            str(recording),
            str(output),
            str(most_seconds),
            str(cpu_seconds),
            str(memory_bytes),
            str(container),
        ]
        try:
            result = subprocess.run(command, capture_output=True, timeout=wall_seconds, check=False)  # noqa: S603 - our own module in our own interpreter, with paths of our own
        except subprocess.TimeoutExpired:
            raise AudioRefusedError("decode_limit") from None
        if result.returncode == decode_child.UNREADABLE:
            raise AudioRefusedError("undecodable")
        if result.returncode not in (decode_child.WHOLE, decode_child.CUT):
            # Killed by the CPU or memory cap, or crashed: either way the file is not worth more.
            logger.info("The decoder stopped with code %s.", result.returncode)
            raise AudioRefusedError("decode_limit")
        pcm = output.read_bytes() if output.is_file() else b""
    return measure(pcm)


def measure(pcm: bytes) -> Decoded:
    """Hold decoded audio to the datasheet's length: over a minute or under half a second is refused."""
    seconds = seconds_of(pcm)
    if seconds > MAX_RECORDING_SECONDS:
        raise AudioRefusedError("too_long")
    if seconds < MIN_RECORDING_SECONDS:
        raise AudioRefusedError("too_short")
    return Decoded(pcm=pcm, seconds=seconds)
