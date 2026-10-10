"""The OCR pool, tested against workers that misbehave: it must end each one, read nothing it should not, and clean up.

The workers are `tests/lb03_fake_worker.py` in its modes. They have no cage; what is under test is the service's
side: the deadline, the process group kill, the bounded output, the strict reading of the result and the pictures,
the environment the worker is given, the number of workers at once, and the scratch folder going away.
"""

import asyncio
import os
import signal
import sys
import time
from collections.abc import Coroutine
from pathlib import Path
from typing import Any

import pytest

from lb03.ocr.pool import OcrError, OcrPool, PoolSettings, Reading, exit_label
from lb03.states import FailureCode

FAKE_WORKER = Path(__file__).resolve().parents[1] / "lb03_fake_worker.py"


def run[Result](coroutine: Coroutine[Any, Any, Result]) -> Result:
    """Run a coroutine to its end on a fresh event loop."""
    return asyncio.run(coroutine)


def pool_for(tmp_path: Path, mode: str, argument: str = "", **settings: Any) -> OcrPool:
    """Make a pool whose worker is the fake in a mode, with its scratch folders under the test's folder."""
    scratch_root = tmp_path / "scratch-root"
    scratch_root.mkdir(exist_ok=True)
    command = (sys.executable, "-P", str(FAKE_WORKER), mode, argument)
    return OcrPool(
        PoolSettings(
            command=command,
            scratch_root=scratch_root,
            **settings,
        )
    )


def failure_of(pool: OcrPool, data: bytes = b"%PDF-1.7 file") -> OcrError:
    """Read a file the pool must fail on, and return the failure."""
    with pytest.raises(OcrError) as caught:
        run(pool.read(data))
    return caught.value


def leftovers(tmp_path: Path) -> list[str]:
    """List what is still in the scratch root: nothing, once a document is done."""
    return sorted(path.name for path in (tmp_path / "scratch-root").iterdir())


def alive(pid: int) -> bool:
    """Tell whether a process still exists and has not died."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return Path(f"/proc/{pid}/stat").exists() and Path(f"/proc/{pid}/stat").read_text().split()[2] != "Z"


def test_a_good_worker_gives_a_checked_reading_and_leaves_nothing_behind(tmp_path: Path) -> None:
    """The pool returns the pages, words, pictures and the sandbox report, and removes the scratch folder."""
    reading = run(pool_for(tmp_path, "ok", "two").read(b"%PDF-1.7 file"))
    assert isinstance(reading, Reading)
    assert reading.kind == "pdf"
    assert [page.number for page in reading.pages] == [1, 2]
    assert reading.pages[0].words[0].text == "Total"
    assert reading.pages[0].picture.startswith(b"\xff\xd8\xff")
    assert reading.model_picture is not None
    assert reading.sandbox.landlock_abi == 7
    assert reading.worker_ms == 12
    assert reading.wall_ms >= 0
    assert leftovers(tmp_path) == []


def test_the_worker_gets_no_secret_and_its_own_session(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The service's environment never reaches the worker, and the worker leads its own process group."""
    monkeypatch.setenv("LB_GATEWAY_SERVICE_KEY", "hunter2")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "hunter2")
    monkeypatch.setenv("FLASK_SECRET", "hunter2")
    reading = run(pool_for(tmp_path, "ok").read(b"%PDF-1.7 file"))
    assert reading.pages[0].words[0].text == "Total"


def test_the_environment_holds_only_the_settings_the_pool_promises(tmp_path: Path) -> None:
    """Four fixed settings, the package path and the thread count: that is the whole environment."""
    environment = pool_for(tmp_path, "ok").environment()
    assert sorted(environment) == [
        "LANG",
        "MALLOC_ARENA_MAX",
        "OMP_NUM_THREADS",
        "PYTHONDONTWRITEBYTECODE",
        "PYTHONNOUSERSITE",
        "PYTHONPATH",
    ]


def test_a_worker_that_hangs_is_killed_at_the_deadline_with_its_children(tmp_path: Path) -> None:
    """The wall-clock limit ends the worker and everything it started, and the code is time_limit."""
    child_file = tmp_path / "child.pid"
    started = time.monotonic()
    failure = failure_of(pool_for(tmp_path, "hang", str(child_file), wall_seconds=1.5))
    elapsed = time.monotonic() - started
    assert failure.code is FailureCode.TIME_LIMIT
    assert failure.exit_status == -signal.SIGKILL
    assert elapsed < 6
    child = int(child_file.read_text())
    time.sleep(0.2)
    assert not alive(child)
    assert leftovers(tmp_path) == []


def test_a_worker_that_floods_its_output_is_stopped(tmp_path: Path) -> None:
    """More than a status line's worth on standard output is a failure, and the worker is killed."""
    started = time.monotonic()
    failure = failure_of(pool_for(tmp_path, "noisy", wall_seconds=20))
    assert failure.code is FailureCode.OCR_FAILED
    assert time.monotonic() - started < 10
    assert leftovers(tmp_path) == []


@pytest.mark.parametrize(
    ("mode", "code", "status"),
    [
        ("crash", FailureCode.OCR_FAILED, 3),
        ("sigkill", FailureCode.OCR_FAILED, -signal.SIGKILL),
        ("sigsys", FailureCode.UNSAFE_FILE, -signal.SIGSYS),
        ("garbage", FailureCode.OCR_FAILED, 0),
        ("no_files", FailureCode.OCR_FAILED, 0),
        ("bad_result", FailureCode.OCR_FAILED, 0),
        ("ok_but_exit_one", FailureCode.OCR_FAILED, 1),
    ],
)
def test_a_worker_that_dies_or_lies_is_a_failed_reading(
    tmp_path: Path, mode: str, code: FailureCode, status: int
) -> None:
    """Crashes, kills, junk, missing files and a bad result all fail closed; the cage's own kill is unsafe_file."""
    failure = failure_of(pool_for(tmp_path, mode))
    assert failure.code is code
    assert failure.exit_status == status
    assert leftovers(tmp_path) == []


@pytest.mark.parametrize("code", ["unsupported_file", "too_many_pages", "image_too_big", "unsafe_file", "no_text"])
def test_a_refusal_from_the_worker_keeps_its_code(tmp_path: Path, code: str) -> None:
    """When the worker says it refused the document, the service passes the same code on."""
    assert failure_of(pool_for(tmp_path, "refuse", code)).code is FailureCode(code)


def test_a_refusal_with_a_code_that_does_not_exist_is_a_failed_reading(tmp_path: Path) -> None:
    """The status line is validated: a code outside the vocabulary is not believed."""
    assert failure_of(pool_for(tmp_path, "refuse", "all_good")).code is FailureCode.OCR_FAILED


@pytest.mark.parametrize("mode", ["symlink_result", "picture_link", "picture_directory"])
def test_a_link_or_a_directory_where_a_file_belongs_is_refused(tmp_path: Path, mode: str) -> None:
    """The result and the pictures are read only if they are regular files, never through a link."""
    secret = tmp_path / "service-secret.txt"
    secret.write_text("the service's own file", encoding="utf-8")
    assert failure_of(pool_for(tmp_path, mode, str(secret))).code is FailureCode.OCR_FAILED


def test_a_result_larger_than_the_cap_is_refused(tmp_path: Path) -> None:
    """The result file is bounded before it is read into memory."""
    assert failure_of(pool_for(tmp_path, "big_result")).code is FailureCode.OCR_FAILED


@pytest.mark.parametrize("mode", ["wrong_number", "bad_picture_name", "not_jpeg"])
def test_a_result_that_names_the_wrong_pages_or_pictures_is_refused(tmp_path: Path, mode: str) -> None:
    """Page numbers, picture names and the picture's own first bytes must be what the pool expects."""
    assert failure_of(pool_for(tmp_path, mode)).code is FailureCode.OCR_FAILED


def test_the_pool_runs_no_more_workers_at_once_than_it_has_slots(tmp_path: Path) -> None:
    """Three documents on one slot take turns: no two workers overlap."""
    log = tmp_path / "log.txt"
    pool = pool_for(tmp_path, "slow", f"{log},0.4", workers=1)

    async def three() -> list[Reading]:
        """Read three documents at once."""
        return await asyncio.gather(*(pool.read(b"%PDF-1.7 file") for _ in range(3)))

    started = time.monotonic()
    assert len(run(three())) == 3
    assert time.monotonic() - started >= 1.2
    events = [line.split()[0] for line in sorted(log.read_text().splitlines(), key=lambda line: float(line.split()[1]))]
    assert events == ["start", "end"] * 3


def test_two_slots_let_two_workers_overlap(tmp_path: Path) -> None:
    """With two slots, two workers run together and the third waits."""
    log = tmp_path / "log.txt"
    pool = pool_for(tmp_path, "slow", f"{log},0.6", workers=2)

    async def three() -> list[Reading]:
        """Read three documents at once."""
        return await asyncio.gather(*(pool.read(b"%PDF-1.7 file") for _ in range(3)))

    run(three())
    events = [line.split()[0] for line in sorted(log.read_text().splitlines(), key=lambda line: float(line.split()[1]))]
    assert events[:2] == ["start", "start"]


def test_cancelling_a_reading_kills_the_worker_and_removes_the_scratch_folder(tmp_path: Path) -> None:
    """When the pipeline gives up on a document (its own deadline), the worker does not keep running."""
    child_file = tmp_path / "child.pid"
    pool = pool_for(tmp_path, "hang", str(child_file), wall_seconds=30)

    async def give_up() -> None:
        """Start a reading, then cancel it while the worker hangs."""
        task = asyncio.create_task(pool.read(b"%PDF-1.7 file"))
        await asyncio.sleep(1.0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    run(give_up())
    time.sleep(0.2)
    assert not alive(int(child_file.read_text()))
    assert leftovers(tmp_path) == []


def test_the_exit_of_a_worker_is_named_for_the_trace() -> None:
    """The trace says `exit 3` or `SIGSYS`, never a raw number."""
    assert exit_label(0) == "exit 0"
    assert exit_label(3) == "exit 3"
    assert exit_label(-signal.SIGSYS) == "SIGSYS"
    assert exit_label(-signal.SIGKILL) == "SIGKILL"
    assert exit_label(-250) == "signal 250"
    assert exit_label(None) == "unknown"
