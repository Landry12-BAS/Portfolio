"""The OCR pool: starts the caged worker for one document, waits for it under a deadline, reads what it left.

This is the web service's side of the cage, and it trusts nothing the worker hands back. For each document it:

1. waits for a free slot (the pool runs at most `workers` workers at once; the rest queue in order),
2. makes a scratch folder only the service's user can open,
3. starts `python -m lb03.ocr.worker` with that folder as its working directory, an environment holding five
   plain settings and no secret, no inherited descriptors, and its own session (so the whole group can be killed),
4. sends the limits and the file down its standard input and reads at most a few kilobytes of status back,
5. kills the group if the wall-clock limit passes, whatever the worker is doing,
6. reads `result.json` and the page pictures with the strict schemas of lb03/ocr/protocol.py (regular files
   only, never through a link, never over their size cap, a JPEG's first bytes checked), and
7. deletes the scratch folder.

The worker's own text on standard error is thrown away: a decoder's complaint can quote the file it was
reading, and nothing of a visitor's file belongs in a log. What is kept is how the worker ended (its exit
status, or the signal that killed it), which is enough to tell a crash from a limit from the cage's own kill.
"""

import asyncio
import contextlib
import os
import shutil
import signal
import stat
import sys
import tempfile
import time
from dataclasses import dataclass, field, replace
from pathlib import Path

from pydantic import ValidationError

from lb03 import limits
from lb03.ocr.protocol import (
    MAX_PICTURE_BYTES,
    MAX_RESULT_BYTES,
    MODEL_PICTURE,
    RESULT_FILE,
    OcrResult,
    OcrWord,
    SandboxReport,
    WorkerLimits,
    WorkerStatus,
)
from lb03.states import FailureCode

# How long to wait for a killed worker's pipes to empty and close, before giving up on it.
REAP_SECONDS = 3.0
# How much of the worker's standard output is read: its one status line is far shorter than this.
MAX_STATUS_BYTES = 4_096
# The first bytes of every JPEG, which is all the worker writes as a picture.
JPEG_MAGIC = b"\xff\xd8\xff"
# The settings the worker is started with, and nothing else: a fresh environment, so no service secret reaches it.
WORKER_ENVIRONMENT = {
    "PYTHONDONTWRITEBYTECODE": "1",
    "PYTHONNOUSERSITE": "1",
    "MALLOC_ARENA_MAX": "2",
    "LANG": "C.UTF-8",
}
# The folder that holds the `lb03` package. The worker is pointed at it, as its working directory is the scratch folder.
PACKAGE_ROOT = Path(__file__).resolve().parents[2]


class OcrError(Exception):
    """Reading the document failed, and the code says why.

    `exit_status` is how the worker ended when that is known: the exit code, or the negative of the signal
    that killed it. It goes into the trace; it holds nothing from the file.
    """

    def __init__(self, code: FailureCode, exit_status: int | None = None) -> None:
        """Fail with `code`, noting how the worker ended."""
        super().__init__(code.value)
        self.code = code
        self.exit_status = exit_status


@dataclass(frozen=True)
class PageReading:
    """One page as read: its size, its words, and the JPEG picture of it that the viewer shows."""

    number: int
    width: int
    height: int
    words: tuple[OcrWord, ...]
    picture: bytes


@dataclass(frozen=True)
class Reading:
    """Everything the worker read from one document, checked by the service."""

    kind: str
    pages: tuple[PageReading, ...]
    model_picture: bytes | None
    sandbox: SandboxReport
    worker_ms: int
    wall_ms: int = 0


def default_worker_limits() -> WorkerLimits:
    """Return the limits the datasheet promises, as the worker is told them."""
    return WorkerLimits(
        max_bytes=limits.MAX_UPLOAD_BYTES,
        max_pages=limits.MAX_PAGES,
        max_pixels=limits.MAX_IMAGE_PIXELS,
        cpu_seconds=limits.OCR_CPU_SECONDS,
        memory_bytes=limits.OCR_MEMORY_BYTES,
        file_bytes=MAX_RESULT_BYTES,
        page_long_side=limits.PAGE_LONG_SIDE_PIXELS,
        model_long_side=limits.MODEL_IMAGE_LONG_SIDE_PIXELS,
        model_quality=limits.MODEL_IMAGE_QUALITY,
    )


@dataclass(frozen=True)
class PoolSettings:
    """How the pool runs its workers. The defaults are the production values; tests change the command and the clock."""

    workers: int = limits.OCR_WORKERS
    wall_seconds: float = limits.OCR_WALL_SECONDS
    scratch_root: Path | None = None
    command: tuple[str, ...] = (sys.executable, "-P", "-m", "lb03.ocr.worker")
    package_root: Path = PACKAGE_ROOT
    worker_limits: WorkerLimits = field(default_factory=default_worker_limits)


def exit_label(exit_status: int | None) -> str:
    """Name how a worker ended for the trace: `exit 0`, or the signal, such as `SIGSYS`."""
    if exit_status is None:
        return "unknown"
    if exit_status >= 0:
        return f"exit {exit_status}"
    try:
        return signal.Signals(-exit_status).name
    except ValueError:
        return f"signal {-exit_status}"


def read_regular_file(path: Path, max_bytes: int) -> bytes:
    """Read a file the worker wrote: a regular file (no link, pipe or device) of at most `max_bytes`."""
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except OSError:
        raise OcrError(FailureCode.OCR_FAILED) from None
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > max_bytes:
            raise OcrError(FailureCode.OCR_FAILED)
        chunks = []
        total = 0
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise OcrError(FailureCode.OCR_FAILED)
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def read_picture(scratch: Path, name: str) -> bytes:
    """Read a page picture the worker wrote, and refuse anything that is not a JPEG."""
    data = read_regular_file(scratch / name, MAX_PICTURE_BYTES)
    if not data.startswith(JPEG_MAGIC):
        raise OcrError(FailureCode.OCR_FAILED)
    return data


def parse_status(output: bytes, exit_status: int | None) -> WorkerStatus:
    """Read the worker's status line; a missing or odd one means the worker did not finish its job."""
    if not output.strip():
        if exit_status == -signal.SIGSYS:
            raise OcrError(FailureCode.UNSAFE_FILE, exit_status)
        raise OcrError(FailureCode.OCR_FAILED, exit_status)
    try:
        return WorkerStatus.model_validate_json(output)
    except ValidationError:
        raise OcrError(FailureCode.OCR_FAILED, exit_status) from None


def collect_reading(scratch: Path, output: bytes, exit_status: int | None) -> Reading:
    """Check what the worker said and left in its scratch folder, and turn it into a `Reading`."""
    status = parse_status(output, exit_status)
    if not status.ok:
        raise OcrError(status.code or FailureCode.OCR_FAILED, exit_status)
    if exit_status != 0:
        raise OcrError(FailureCode.OCR_FAILED, exit_status)
    try:
        result = OcrResult.model_validate_json(read_regular_file(scratch / RESULT_FILE, MAX_RESULT_BYTES))
    except ValidationError:
        raise OcrError(FailureCode.OCR_FAILED, exit_status) from None
    pages = []
    for index, page in enumerate(result.pages, start=1):
        if page.number != index or page.picture != f"page-{index}.jpg":
            raise OcrError(FailureCode.OCR_FAILED, exit_status)
        pages.append(
            PageReading(
                number=page.number,
                width=page.width,
                height=page.height,
                words=tuple(page.words),
                picture=read_picture(scratch, page.picture),
            )
        )
    model_picture = None
    if result.model_picture is not None:
        if result.model_picture != MODEL_PICTURE:
            raise OcrError(FailureCode.OCR_FAILED, exit_status)
        model_picture = read_picture(scratch, MODEL_PICTURE)
    return Reading(
        kind=result.kind,
        pages=tuple(pages),
        model_picture=model_picture,
        sandbox=result.sandbox,
        worker_ms=result.elapsed_ms,
    )


async def read_status(stream: asyncio.StreamReader) -> bytes:
    """Read the worker's standard output to its end, refusing more than a status line's worth."""
    collected = b""
    while True:
        chunk = await stream.read(1_024)
        if not chunk:
            return collected
        collected += chunk
        if len(collected) > MAX_STATUS_BYTES:
            raise OcrError(FailureCode.OCR_FAILED)


async def feed(stream: asyncio.StreamWriter, payload: bytes) -> None:
    """Write the request to the worker's standard input and close it; a worker that stopped listening is fine."""
    try:
        stream.write(payload)
        await stream.drain()
        stream.close()
        await stream.wait_closed()
    except (BrokenPipeError, ConnectionResetError):
        return


async def drain(stream: asyncio.StreamReader) -> None:
    """Read a stream to its end and throw it away."""
    while await stream.read(65_536):
        pass


async def reap(process: asyncio.subprocess.Process) -> None:
    """Make sure the worker's whole process group is gone, and collect it.

    asyncio finishes `wait()` only after the worker's pipes are closed, and a pipe the service stopped reading
    stays open while data sits in it, so after the kill the standard output is read to its end first.
    """
    if process.returncode is None:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
    if process.stdout is not None:
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(drain(process.stdout), timeout=REAP_SECONDS)
    with contextlib.suppress(TimeoutError):
        await asyncio.wait_for(process.wait(), timeout=REAP_SECONDS)


class OcrPool:
    """Runs OCR workers for the service: bounded in number, each caged, each killed on a deadline."""

    def __init__(self, settings: PoolSettings | None = None) -> None:
        """Make a pool with `settings`, or the production ones."""
        self.settings = settings or PoolSettings()
        self.slots = asyncio.Semaphore(self.settings.workers)

    def environment(self) -> dict[str, str]:
        """Return the worker's whole environment: the path of the package, the thread count, and fixed settings."""
        environment = dict(WORKER_ENVIRONMENT)
        environment["PYTHONPATH"] = str(self.settings.package_root)
        environment["OMP_NUM_THREADS"] = str(self.settings.worker_limits.threads)
        return environment

    def make_scratch(self) -> Path:
        """Make this document's scratch folder: new, empty, and readable by the service's user alone."""
        root = self.settings.scratch_root
        return Path(tempfile.mkdtemp(prefix="lb03-ocr-", dir=root))

    async def talk(self, process: asyncio.subprocess.Process, data: bytes) -> bytes:
        """Send the limits and the file to the worker and return what it printed once it has ended."""
        if process.stdin is None or process.stdout is None:
            raise OcrError(FailureCode.OCR_FAILED)
        request = self.settings.worker_limits.model_dump_json().encode("utf-8") + b"\n" + data
        feeder = asyncio.create_task(feed(process.stdin, request))
        try:
            output = await read_status(process.stdout)
            await process.wait()
        finally:
            feeder.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await feeder
        return output

    async def run_worker(self, scratch: Path, data: bytes) -> tuple[bytes, int | None]:
        """Start a worker in the scratch folder and give it the file; return its output and how it ended."""
        process = await asyncio.create_subprocess_exec(
            *self.settings.command,
            cwd=scratch,
            env=self.environment(),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
        )
        timed_out = False
        output = b""
        try:
            output = await asyncio.wait_for(self.talk(process, data), timeout=self.settings.wall_seconds)
        except TimeoutError:
            timed_out = True
        finally:
            await reap(process)
        if timed_out:
            raise OcrError(FailureCode.TIME_LIMIT, process.returncode)
        return output, process.returncode

    async def collect(self, scratch: Path, output: bytes, exit_status: int | None) -> Reading:
        """Read what the worker left, off the event loop, and note how it ended on any failure that has no status."""
        try:
            return await asyncio.to_thread(collect_reading, scratch, output, exit_status)
        except OcrError as error:
            if error.exit_status is None:
                error.exit_status = exit_status
            raise

    async def read(self, data: bytes) -> Reading:
        """Read one document's pages: raises `OcrError` with the reason when it can't be read."""
        started = time.monotonic()
        async with self.slots:
            scratch = await asyncio.to_thread(self.make_scratch)
            try:
                output, exit_status = await self.run_worker(scratch, data)
                reading = await self.collect(scratch, output, exit_status)
            finally:
                await asyncio.to_thread(shutil.rmtree, scratch, True)
        return replace(reading, wall_ms=round((time.monotonic() - started) * 1000))
