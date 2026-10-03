"""The child process that decodes one recording, held to limits the operating system enforces.

    python -m lb09.decode_child <recording> <pcm out> <most seconds> <cpu seconds> <memory bytes>

It reads the recording with PyAV, turns whatever it holds into 16 kHz mono 16-bit PCM, and writes the
samples to the output file as it goes. A recording built to blow up (a few kilobytes that decode to hours
of silence, or to a frame the size of memory) costs a bounded amount: the process caps its own CPU time
and address space before it opens the file, the parent (lb09/audio.py) kills it after a wall-clock
deadline, and it stops decoding as soon as it has written more audio than a recording may hold, since
nothing past that is ever used. It imports no Django, so it starts quickly and holds nothing else.

Exit codes tell the parent what happened: 0 for a whole recording, 3 for one that was cut at the most
seconds, 4 for a file the decoder could not read, 5 for one that needed more memory than allowed. It prints
nothing: a decoder's message can quote the file, and the file is a visitor's.
"""

import resource
import sys
from pathlib import Path
from typing import BinaryIO

import av

# The format everything after the decoder uses (lb_common.audio).
SAMPLE_RATE = 16_000
BYTES_PER_SAMPLE = 2

WHOLE = 0
CUT = 3
UNREADABLE = 4
OUT_OF_MEMORY = 5


def limit_resources(cpu_seconds: int, memory_bytes: int) -> None:
    """Cap this process's CPU time and address space, so a decoder bomb is stopped by the kernel."""
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))
    resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, memory_bytes))


def decode(recording: Path, output: Path, most_seconds: float) -> int:
    """Decode the recording into 16 kHz mono PCM, stopping once `most_seconds` of audio have been written."""
    most_bytes = int(most_seconds * SAMPLE_RATE * BYTES_PER_SAMPLE)
    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    written = 0
    with output.open("wb") as out:
        try:
            with av.open(str(recording), mode="r") as container:
                stream = container.streams.audio[0]
                for frame in container.decode(stream):
                    for resampled in resampler.resample(frame):
                        written += write_frame(out, resampled)
                    if written >= most_bytes:
                        return CUT
                for resampled in resampler.resample(None):
                    written += write_frame(out, resampled)
        except (av.FFmpegError, IndexError, ValueError, OSError):
            return UNREADABLE
        except MemoryError:
            return OUT_OF_MEMORY
    return CUT if written >= most_bytes else WHOLE


def write_frame(out: BinaryIO, frame: av.AudioFrame) -> int:
    """Write one resampled frame's samples and return how many bytes that was."""
    samples = bytes(frame.planes[0])[: frame.samples * BYTES_PER_SAMPLE]
    out.write(samples)
    return len(samples)


def main(arguments: list[str]) -> int:
    """Read the arguments, cap the process, decode, and return the exit code."""
    recording, output, most_seconds, cpu_seconds, memory_bytes = arguments
    limit_resources(int(cpu_seconds), int(memory_bytes))
    return decode(Path(recording), Path(output), float(most_seconds))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
