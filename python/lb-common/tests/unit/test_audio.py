"""Unit tests for the WAV the gateway's speech-to-text route takes, which Python's own reader understands."""

import io
import wave

import pytest

from lb_common.audio import BYTES_PER_SECOND, SAMPLE_RATE, WAV_HEADER_BYTES, seconds_of_pcm, wav_from_pcm


def test_the_wav_is_what_a_standard_reader_sees_as_16_bit_mono_16_khz() -> None:
    """The header says what the samples are, and the reader finds every sample."""
    pcm = b"\x01\x00\xff\x7f" * 8_000

    with wave.open(io.BytesIO(wav_from_pcm(pcm))) as reader:
        assert reader.getnchannels() == 1
        assert reader.getsampwidth() == 2
        assert reader.getframerate() == SAMPLE_RATE
        assert reader.getnframes() == len(pcm) // 2
        assert reader.readframes(reader.getnframes()) == pcm


def test_the_file_is_the_header_and_the_samples_and_nothing_else() -> None:
    """The gateway believes the bytes: the RIFF size and the data chunk must end where the file does."""
    pcm = bytes(BYTES_PER_SECOND)

    wav = wav_from_pcm(pcm)

    assert len(wav) == WAV_HEADER_BYTES + len(pcm)
    assert int.from_bytes(wav[4:8], "little") == len(wav) - 8
    assert int.from_bytes(wav[40:44], "little") == len(pcm)


def test_a_second_is_32000_bytes() -> None:
    """The one fact the gateway measures a recording by."""
    assert seconds_of_pcm(bytes(BYTES_PER_SECOND)) == 1.0
    assert seconds_of_pcm(bytes(BYTES_PER_SECOND * 3 // 2)) == 1.5
    assert seconds_of_pcm(b"") == 0.0


def test_half_a_sample_is_refused() -> None:
    """Audio is whole 16-bit samples."""
    with pytest.raises(ValueError, match="whole number of 16-bit samples"):
        wav_from_pcm(b"\x00\x00\x00")
