# ruff: noqa: ARG001 - every behaviour takes the same two arguments, and most need neither of them
"""A stand-in for the OCR worker, to test the pool with: it speaks the protocol, and misbehaves on purpose.

`python tests/lb03_fake_worker.py <mode> [argument]` reads the limits line and the file from standard
input like the real worker and then does what its mode says: leave a valid result, or hang, flood the
output, die from a signal, leave a link where a result should be, and so on. Each mode is one way a worker
that a hostile file had taken over, or just broken, could answer the pool. It runs with no cage: the pool's
reading of what it leaves is what is under test, not the worker.
"""

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image

from lb03.ocr.protocol import MODEL_PICTURE, RESULT_FILE, OcrPage, OcrResult, OcrWord, SandboxReport, WorkerStatus

SCRATCH = Path.cwd()
WORD = OcrWord(text="Total", confidence=0.97, quad=(0.1, 0.1, 0.3, 0.1, 0.3, 0.15, 0.1, 0.15), line=0)
REPORT = SandboxReport(rlimits=True, no_new_privileges=True, seccomp=True, landlock_abi=7)


def jpeg(name: str) -> None:
    """Write a small JPEG picture into the scratch folder."""
    Image.new("RGB", (60, 80), (240, 240, 240)).save(SCRATCH / name, "JPEG")


def result(pages: int = 1, number_of_first: int = 1, picture: str = "page-1.jpg") -> OcrResult:
    """Make a valid result for `pages` pages, with the first page numbered and pictured as asked."""
    made = [
        OcrPage(
            number=number_of_first if index == 0 else index + 1,
            width=60,
            height=80,
            picture=picture if index == 0 else f"page-{index + 1}.jpg",
            words=[WORD],
        )
        for index in range(pages)
    ]
    return OcrResult(kind="pdf", pages=made, model_picture=MODEL_PICTURE, sandbox=REPORT, elapsed_ms=12)


def leave(content: OcrResult) -> None:
    """Write the pictures a result names and the result itself."""
    for page in content.pages:
        if page.picture.startswith("page-"):
            jpeg(page.picture)
    jpeg(MODEL_PICTURE)
    (SCRATCH / RESULT_FILE).write_text(content.model_dump_json(), encoding="utf-8")


def say(status: WorkerStatus) -> None:
    """Print the status line."""
    sys.stdout.write(status.model_dump_json() + "\n")
    sys.stdout.flush()


def stray_child(path: str) -> None:
    """Start a long sleep in this process group and write its pid, so a test can see it die with the group."""
    child = subprocess.Popen(["sleep", "60"])  # noqa: S607 - a test double that needs a stray child
    Path(path).write_text(str(child.pid), encoding="utf-8")


def clean_environment() -> bool:
    """Say whether the environment holds nothing of the service's: no secret, and the settings the pool promises."""
    secret_names = [name for name in os.environ if name.startswith(("LB_", "FLASK_", "AWS_", "R2_"))]
    return not secret_names and "hunter2" not in os.environ.values() and os.getsid(0) == os.getpid()


def main() -> int:
    """Read the request, then behave as the mode says; return the exit status."""
    mode = sys.argv[1]
    argument = sys.argv[2] if len(sys.argv) > 2 else ""
    limits = json.loads(sys.stdin.buffer.readline())
    data = sys.stdin.buffer.read(limits["max_bytes"] + 1)
    behaviours = {
        "ok": ok,
        "hang": hang,
        "noisy": noisy,
        "crash": crash,
        "sigsys": sigsys,
        "sigkill": sigkill,
        "garbage": garbage,
        "refuse": refuse,
        "bad_result": bad_result,
        "symlink_result": symlink_result,
        "big_result": big_result,
        "wrong_number": wrong_number,
        "bad_picture_name": bad_picture_name,
        "not_jpeg": not_jpeg,
        "picture_link": picture_link,
        "picture_directory": picture_directory,
        "ok_but_exit_one": ok_but_exit_one,
        "slow": slow,
        "no_files": no_files,
    }
    return int(behaviours[mode](data, argument))


def ok(data: bytes, argument: str) -> int:
    """Leave a valid result, unless the environment is not clean, in which case say the file is unreadable."""
    if not clean_environment():
        say(WorkerStatus(ok=False, code="unreadable_file"))
        return 0
    leave(result(pages=2 if argument == "two" else 1))
    say(WorkerStatus(ok=True))
    return 0


def crash(data: bytes, argument: str) -> int:
    """Exit with a failure status and no status line."""
    return 3


def sigsys(data: bytes, argument: str) -> int:
    """Die of SIGSYS, the way the cage's filter kills a process that makes a forbidden call."""
    os.kill(os.getpid(), signal.SIGSYS)
    return 0


def sigkill(data: bytes, argument: str) -> int:
    """Die of SIGKILL, the way the kernel stops a process that is over its CPU limit."""
    os.kill(os.getpid(), signal.SIGKILL)
    return 0


def garbage(data: bytes, argument: str) -> int:
    """Print a line that is not a status."""
    sys.stdout.write("this is not json\n")
    sys.stdout.flush()
    return 0


def refuse(data: bytes, argument: str) -> int:
    """Refuse the document with the failure code given as the argument."""
    say(WorkerStatus(ok=False, code=argument))
    return 0


def no_files(data: bytes, argument: str) -> int:
    """Say ok and leave nothing behind."""
    say(WorkerStatus(ok=True))
    return 0


def hang(data: bytes, argument: str) -> int:
    """Never finish, with a stray child in the group when asked."""
    if argument:
        stray_child(argument)
    time.sleep(60)
    return 0


def noisy(data: bytes, argument: str) -> int:
    """Print far more than a status line, then wait."""
    sys.stdout.write("x" * 200_000)
    sys.stdout.flush()
    time.sleep(60)
    return 0


def bad_result(data: bytes, argument: str) -> int:
    """Say ok and leave a result that does not fit the schema."""
    (SCRATCH / RESULT_FILE).write_text('{"kind": "pdf"}', encoding="utf-8")
    say(WorkerStatus(ok=True))
    return 0


def symlink_result(data: bytes, argument: str) -> int:
    """Say ok and leave a link to a file of the service's, where the result should be."""
    (SCRATCH / RESULT_FILE).symlink_to(argument or "/etc/passwd")
    say(WorkerStatus(ok=True))
    return 0


def big_result(data: bytes, argument: str) -> int:
    """Say ok and leave a result file larger than the service reads."""
    leave(result())
    with (SCRATCH / RESULT_FILE).open("ab") as handle:
        handle.write(b" " * (13 * 1024 * 1024))
    say(WorkerStatus(ok=True))
    return 0


def wrong_number(data: bytes, argument: str) -> int:
    """Say ok and leave a result whose first page is numbered 2."""
    leave(result(number_of_first=2))
    say(WorkerStatus(ok=True))
    return 0


def bad_picture_name(data: bytes, argument: str) -> int:
    """Say ok and leave a result that names a picture the pool did not ask for."""
    leave(result(picture="evil.jpg"))
    jpeg("evil.jpg")
    say(WorkerStatus(ok=True))
    return 0


def not_jpeg(data: bytes, argument: str) -> int:
    """Say ok and leave a PNG where a JPEG page picture should be."""
    leave(result())
    Image.new("RGB", (10, 10)).save(SCRATCH / "page-1.jpg", "PNG")
    say(WorkerStatus(ok=True))
    return 0


def picture_link(data: bytes, argument: str) -> int:
    """Say ok and leave a link to another file where a page picture should be."""
    leave(result())
    (SCRATCH / "page-1.jpg").unlink()
    (SCRATCH / "page-1.jpg").symlink_to(argument or "/etc/passwd")
    say(WorkerStatus(ok=True))
    return 0


def picture_directory(data: bytes, argument: str) -> int:
    """Say ok and leave a directory where a page picture should be."""
    leave(result())
    (SCRATCH / "page-1.jpg").unlink()
    (SCRATCH / "page-1.jpg").mkdir()
    say(WorkerStatus(ok=True))
    return 0


def ok_but_exit_one(data: bytes, argument: str) -> int:
    """Leave a valid result and say ok, then exit with a failure status."""
    leave(result())
    say(WorkerStatus(ok=True))
    return 1


def slow(data: bytes, argument: str) -> int:
    """Take a while, noting when it started and ended in the log file named by the first part of the argument."""
    log, seconds = argument.split(",")
    with Path(log).open("a", encoding="utf-8") as handle:
        handle.write(f"start {time.monotonic():.3f}\n")
    time.sleep(float(seconds))
    with Path(log).open("a", encoding="utf-8") as handle:
        handle.write(f"end {time.monotonic():.3f}\n")
    leave(result())
    say(WorkerStatus(ok=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
