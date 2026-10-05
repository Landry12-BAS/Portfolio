"""The one audio format the gateway's speech-to-text route takes, and how to write it.

The gateway has no audio decoder, so it can only measure a recording whose length is a plain
function of its bytes: a WAV file of 16-bit PCM, mono, at 16 kHz, where a second is exactly 32,000
bytes. Every system that sends audio decodes and normalises it to this first (LB-09 does, with its
bundled decoder), so the gateway can believe the bytes and not any header a caller wrote.

    wav = wav_from_pcm(samples)             # samples: 16-bit little-endian mono PCM at 16 kHz
    transcript = gateway.transcribe(wav)
"""

import struct
from typing import Final

# Samples a second of the audio the gateway accepts.
SAMPLE_RATE: Final = 16_000
# Bytes a second of that audio takes: 16-bit samples, one channel.
BYTES_PER_SECOND: Final = 32_000
# The bytes of the plainest WAV header: the RIFF header, the `fmt ` chunk and the `data` chunk's header.
WAV_HEADER_BYTES: Final = 44
# The `fmt ` chunk of plain PCM is this long.
_FMT_CHUNK_BYTES: Final = 16
# The format tag of integer PCM.
_PCM: Final = 1
_CHANNELS: Final = 1
_BITS_PER_SAMPLE: Final = 16
_BLOCK_ALIGN: Final = _CHANNELS * _BITS_PER_SAMPLE // 8


def seconds_of_pcm(pcm: bytes) -> float:
    """Return how many seconds of audio some 16-bit mono 16 kHz samples hold."""
    return len(pcm) / BYTES_PER_SECOND


def wav_from_pcm(pcm: bytes) -> bytes:
    """Wrap 16-bit little-endian mono PCM samples at 16 kHz in the WAV header the gateway reads.

    The result is exactly what the gateway checks: the RIFF size, the data chunk and the end of the
    file agree. Raises ValueError for bytes that are not a whole number of samples.
    """
    if len(pcm) % _BLOCK_ALIGN != 0:
        raise ValueError("PCM audio is a whole number of 16-bit samples.")
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        4 + 8 + _FMT_CHUNK_BYTES + 8 + len(pcm),
        b"WAVE",
        b"fmt ",
        _FMT_CHUNK_BYTES,
        _PCM,
        _CHANNELS,
        SAMPLE_RATE,
        BYTES_PER_SECOND,
        _BLOCK_ALIGN,
        _BITS_PER_SAMPLE,
        b"data",
        len(pcm),
    )
    return header + pcm
