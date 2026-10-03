"""The OCR worker's cage, tested for what it does: the filter's logic, its numbers, and a real process behind it.

Three kinds of test. The filter is a few BPF instructions, so a tiny interpreter runs them for both
architectures on made-up system calls, which proves the aarch64 filter on an x86-64 machine. The syscall
numbers are compared with libseccomp's own, where it is installed. And real child processes build the cage
and then try what a hostile file would try: open a socket, start a program, trace a process, write or read
outside the scratch folder, run out of time, memory and disk.
"""

import ctypes
import ctypes.util
import errno
import json
import os
import platform
import signal
import struct
import subprocess
import sys
from pathlib import Path

import pytest

from lb03.ocr import sandbox
from lb03.ocr.pool import default_worker_limits

SERVICE_ROOT = Path(__file__).resolve().parents[2]
ARCHITECTURES = ("x86_64", "aarch64")
BPF_LD_W_ABS, BPF_JEQ_K, BPF_JGE_K, BPF_RET_K = 0x20, 0x15, 0x35, 0x06
# A few system calls an OCR worker needs, by architecture: they must pass the filter.
ALLOWED_CALLS = {
    "x86_64": {"read": 0, "write": 1, "openat": 257, "mmap": 9, "futex": 202, "getrandom": 318, "clone3": 435},
    "aarch64": {"read": 63, "write": 64, "openat": 56, "mmap": 222, "futex": 98, "getrandom": 278, "clone3": 435},
}
ON_LINUX_WITH_A_CAGE = sys.platform == "linux" and platform.machine() in sandbox.AUDIT_ARCH
needs_cage = pytest.mark.skipif(not ON_LINUX_WITH_A_CAGE, reason="the cage is built for Linux on x86-64 or aarch64")
needs_landlock = pytest.mark.skipif(
    not ON_LINUX_WITH_A_CAGE or sandbox.landlock_abi() == 0,
    reason="this kernel has no Landlock",
)

# What a child process runs: build the cage the way the worker does, then the attack written in each test.
BOOTSTRAP = """
import json, platform, sys
from pathlib import Path
from lb03.ocr.protocol import WorkerLimits
from lb03.ocr import sandbox

NUMBERS = sandbox.numbers_for(platform.machine())
limits = WorkerLimits(**json.loads(sys.argv[1]))
scratch = Path(sys.argv[2])
{prelude}
sandbox.apply_rlimits(limits)
try:
    report = sandbox.apply_sandbox(scratch, limits)
except sandbox.SandboxError as error:
    print("SANDBOX-ERROR", error)
    raise SystemExit(3)
{attack}
"""


def run_filter(program: bytes, number: int, architecture_token: int) -> int:
    """Run a seccomp BPF program on one call, as the kernel would, and return what it decides."""
    instructions = [struct.unpack("=HBBI", program[at : at + 8]) for at in range(0, len(program), 8)]
    data = {0: number, 4: architecture_token}
    accumulator = 0
    counter = 0
    for _ in range(len(instructions) + 1):
        code, jump_true, jump_false, operand = instructions[counter]
        if code == BPF_LD_W_ABS:
            accumulator = data[operand]
            counter += 1
        elif code == BPF_JEQ_K:
            counter += 1 + (jump_true if accumulator == operand else jump_false)
        elif code == BPF_JGE_K:
            counter += 1 + (jump_true if accumulator >= operand else jump_false)
        elif code == BPF_RET_K:
            return int(operand)
        else:
            raise AssertionError(f"an instruction the filter should not hold: {code:#x}")
    raise AssertionError("the filter did not end")


def libseccomp() -> ctypes.CDLL | None:
    """Load libseccomp, or return None when this machine does not have it."""
    path = ctypes.util.find_library("seccomp")
    if path is None:
        return None
    library = ctypes.CDLL(path)
    library.seccomp_arch_resolve_name.argtypes = [ctypes.c_char_p]
    library.seccomp_arch_resolve_name.restype = ctypes.c_uint32
    library.seccomp_syscall_resolve_name_arch.argtypes = [ctypes.c_uint32, ctypes.c_char_p]
    library.seccomp_syscall_resolve_name_arch.restype = ctypes.c_int
    return library


def cage_limits(**changes: int | bool) -> str:
    """Return the worker's production limits as a JSON line, with some of them changed for one test."""
    values = default_worker_limits().model_dump()
    values.update(changes)
    return json.dumps(values)


def in_the_cage(
    attack: str, scratch: Path, *, prelude: str = "", limits: str | None = None
) -> subprocess.CompletedProcess[str]:
    """Build the cage in a fresh Python process and run `attack` inside it; return how it went."""
    script = BOOTSTRAP.format(prelude=prelude, attack=attack)
    return subprocess.run(  # noqa: S603 - the interpreter is this one, the script is the test's own
        [sys.executable, "-P", "-c", script, limits or cage_limits(), str(scratch)],
        cwd=scratch,
        env={"PYTHONPATH": str(SERVICE_ROOT), "PYTHONDONTWRITEBYTECODE": "1"},
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


@pytest.fixture
def scratch(tmp_path: Path) -> Path:
    """Make a folder shaped like the pool's: a scratch folder inside a parent the cage must keep out of."""
    folder = tmp_path / "scratch"
    folder.mkdir(mode=0o700)
    return folder


@pytest.mark.parametrize("architecture", ARCHITECTURES)
def test_the_system_call_numbers_match_libseccomp(architecture: str) -> None:
    """Every number in the table is the one libseccomp gives the call, for both architectures."""
    library = libseccomp()
    if library is None:
        pytest.skip("libseccomp is not installed here")
    token = library.seccomp_arch_resolve_name(architecture.encode())
    assert token == sandbox.AUDIT_ARCH[architecture]
    wrong = {
        name: (number, library.seccomp_syscall_resolve_name_arch(token, name.encode()))
        for name, number in sandbox.numbers_for(architecture).items()
        if library.seccomp_syscall_resolve_name_arch(token, name.encode()) != number
    }
    assert wrong == {}


def test_every_listed_call_is_either_refused_or_fatal() -> None:
    """No call is in both lists, and every row of the table is in one of them."""
    names = [name for name, _, _ in sandbox.SYSCALL_NUMBERS]
    assert len(names) == len(set(names))
    assert not set(sandbox.REFUSED) & set(sandbox.FATAL)
    assert set(sandbox.REFUSED) | set(sandbox.FATAL) == set(names)


@pytest.mark.parametrize("architecture", ARCHITECTURES)
def test_the_filter_refuses_the_network_and_kills_what_no_ocr_needs(architecture: str) -> None:
    """Sockets get EPERM, the dangerous calls kill the process, and the calls an OCR worker needs pass."""
    program = sandbox.build_filter(architecture)
    token = sandbox.AUDIT_ARCH[architecture]
    numbers = sandbox.numbers_for(architecture)
    for name in sandbox.REFUSED:
        assert run_filter(program, numbers[name], token) == sandbox.SECCOMP_RET_ERRNO | errno.EPERM, name
    for name in sandbox.FATAL:
        assert run_filter(program, numbers[name], token) == sandbox.SECCOMP_RET_KILL_PROCESS, name
    for name, number in ALLOWED_CALLS[architecture].items():
        assert run_filter(program, number, token) == sandbox.SECCOMP_RET_ALLOW, name


@pytest.mark.parametrize("architecture", ARCHITECTURES)
def test_a_call_through_another_abi_is_killed(architecture: str) -> None:
    """A call that arrives with the other architecture's audit number is not trusted to mean what its number says."""
    other = next(name for name in ARCHITECTURES if name != architecture)
    program = sandbox.build_filter(architecture)
    assert run_filter(program, 0, sandbox.AUDIT_ARCH[other]) == sandbox.SECCOMP_RET_KILL_PROCESS


def test_the_x32_number_range_is_killed_on_x86_64() -> None:
    """An x86-64 process could reach a call through the x32 range, which the number tests would not see."""
    program = sandbox.build_filter("x86_64")
    token = sandbox.AUDIT_ARCH["x86_64"]
    socket_number = sandbox.numbers_for("x86_64")["socket"]
    assert run_filter(program, socket_number | sandbox.X32_FLAG, token) == sandbox.SECCOMP_RET_KILL_PROCESS


def test_the_cage_refuses_an_architecture_it_has_no_numbers_for() -> None:
    """Failing closed: on any other platform the filter is not built, so the worker does not read the file."""
    with pytest.raises(sandbox.SandboxError):
        sandbox.build_filter("riscv64")


def test_the_instruction_encoding_is_the_kernels() -> None:
    """A BPF instruction is eight bytes: a 16-bit code, two 8-bit jumps and a 32-bit operand, in native order."""
    assert len(sandbox.instruction(BPF_RET_K, 0, 0, 7)) == 8
    assert struct.unpack("=HBBI", sandbox.instruction(BPF_JEQ_K, 1, 2, 99)) == (BPF_JEQ_K, 1, 2, 99)


@needs_cage
def test_the_cage_reports_the_walls_it_put_up(scratch: Path) -> None:
    """The report says which layers stand, and the process shows no new privileges and a filter in force."""
    attack = """
print("REPORT", report.model_dump_json())
status = Path("/proc/self/status").read_text()
print("\\n".join(line for line in status.splitlines() if line.startswith(("NoNewPrivs", "Seccomp:"))))
"""
    done = in_the_cage(attack, scratch)
    assert done.returncode == 0, done.stderr
    report = json.loads(next(line for line in done.stdout.splitlines() if line.startswith("REPORT")).split(" ", 1)[1])
    assert report["rlimits"]
    assert report["no_new_privileges"]
    assert report["seccomp"]
    assert report["landlock_abi"] == sandbox.landlock_abi()
    assert "NoNewPrivs:\t1" in done.stdout
    assert "Seccomp:\t2" in done.stdout


@needs_cage
def test_the_worker_volunteers_to_be_the_first_process_the_kernel_kills(scratch: Path) -> None:
    """Out of memory, the kernel's pick is the worker and not the service: its score is the highest there is."""
    if not os.access(sandbox.OOM_SCORE_FILE, os.W_OK):
        pytest.skip("this /proc does not let a process raise its own OOM score")
    attack = """
print("REPORT", report.oom_score_adj)
print("SCORE", Path("/proc/self/oom_score_adj").read_text().strip())
"""
    done = in_the_cage(attack, scratch)
    assert done.returncode == 0, done.stderr
    assert "REPORT 1000" in done.stdout
    assert "SCORE 1000" in done.stdout


def test_a_worker_that_cannot_raise_its_oom_score_goes_on_and_reports_nothing_gained(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """It is a courtesy and not a wall: a /proc that refuses the write leaves the score at 0 and raises nothing.

    The real file is never touched here: it would make the test runner itself the kernel's first victim.
    """
    monkeypatch.setattr(sandbox, "OOM_SCORE_FILE", str(tmp_path / "no-such-folder" / "oom_score_adj"))
    assert sandbox.volunteer_for_the_oom_killer() == 0
    stand_in = tmp_path / "oom_score_adj"
    stand_in.write_text("0")
    monkeypatch.setattr(sandbox, "OOM_SCORE_FILE", str(stand_in))
    assert sandbox.volunteer_for_the_oom_killer() == sandbox.OOM_SCORE_MAX
    assert stand_in.read_text() == "1000"


@needs_cage
@pytest.mark.parametrize(
    "attempt",
    [
        "socket.socket(socket.AF_INET, socket.SOCK_STREAM)",
        "socket.socket(socket.AF_INET, socket.SOCK_DGRAM)",
        "socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
        "socket.socketpair()",
    ],
)
def test_no_socket_of_any_kind_can_be_made(scratch: Path, attempt: str) -> None:
    """TCP, UDP, a Unix socket and a socket pair all fail with a permission error: there is no network."""
    attack = f"""
import socket
try:
    {attempt}
except PermissionError as error:
    print("REFUSED", error.errno)
else:
    print("OPENED")
"""
    done = in_the_cage(attack, scratch)
    assert done.returncode == 0, done.stderr
    assert f"REFUSED {errno.EPERM}" in done.stdout


@needs_cage
@pytest.mark.parametrize(
    "attempt",
    [
        'os.execv("/bin/true", ["true"])',
        'os.execve("/bin/sh", ["sh", "-c", "id"], {})',
        "ctypes.CDLL(None).ptrace(0, 0, 0, 0)",
        'ctypes.CDLL(None).syscall(NUMBERS["bpf"], 0, 0, 0)',
        'ctypes.CDLL(None).syscall(NUMBERS["io_uring_setup"], 0, 0)',
    ],
)
def test_starting_a_program_or_tracing_kills_the_process(scratch: Path, attempt: str) -> None:
    """Exec, ptrace, bpf and io_uring are fatal: the kernel ends the process with SIGSYS."""
    attack = f"""
import ctypes, os, subprocess
{attempt}
print("SURVIVED")
"""
    done = in_the_cage(attack, scratch)
    assert done.returncode == -signal.SIGSYS, (done.returncode, done.stdout, done.stderr)
    assert "SURVIVED" not in done.stdout


@needs_cage
def test_a_child_process_cannot_start_a_program_either(scratch: Path) -> None:
    """The worker may fork, but the child dies of SIGSYS the moment it tries to exec, so nothing else runs."""
    attack = """
import subprocess
print("CHILD", subprocess.run(["/bin/true"], check=False).returncode)
"""
    done = in_the_cage(attack, scratch)
    assert done.returncode == 0, done.stderr
    assert f"CHILD {-signal.SIGSYS}" in done.stdout


@needs_landlock
def test_it_can_write_its_scratch_folder_and_nothing_beside_it(scratch: Path) -> None:
    """The scratch folder takes files and folders; the folder next to it, and a link out of it, are refused."""
    attack = """
(scratch / "inside.txt").write_text("fine")
(scratch / "folder").mkdir()
(scratch / "folder" / "deeper.bin").write_bytes(b"fine")
(scratch / "inside.txt").rename(scratch / "renamed.txt")
results = {}
for label, action in {
    "write-beside": lambda: (scratch.parent / "outside.txt").write_text("no"),
    "mkdir-beside": lambda: (scratch.parent / "folder").mkdir(),
    "link-out": lambda: (scratch / "link").symlink_to("/etc/passwd"),
    "rename-out": lambda: (scratch / "renamed.txt").rename(scratch.parent / "moved.txt"),
}.items():
    try:
        action()
        results[label] = "ALLOWED"
    except OSError:
        results[label] = "refused"
print("RESULTS", results)
"""
    done = in_the_cage(attack, scratch)
    assert done.returncode == 0, done.stderr
    refused = "{'write-beside': 'refused', 'mkdir-beside': 'refused', 'link-out': 'refused', 'rename-out': 'refused'}"
    assert f"RESULTS {refused}" in done.stdout
    assert (scratch / "renamed.txt").read_text() == "fine"
    assert not (scratch.parent / "outside.txt").exists()
    assert not (scratch.parent / "moved.txt").exists()


@needs_landlock
@pytest.mark.parametrize("path", ["/etc/passwd", "/etc/hostname", "/proc/version", "/root", "/home", "/var"])
def test_it_cannot_read_what_is_not_its_own(scratch: Path, path: str) -> None:
    """The system's files outside the read list are refused, even those anyone could normally read."""
    attack = f"""
import os
try:
    if os.path.isdir({path!r}):
        os.listdir({path!r})
    else:
        open({path!r}, "rb").read(1)
except PermissionError:
    print("REFUSED")
except FileNotFoundError:
    print("MISSING")
else:
    print("READ")
"""
    done = in_the_cage(attack, scratch)
    assert done.returncode == 0, done.stderr
    assert "READ" not in done.stdout.split(), done.stdout


@needs_landlock
def test_it_can_still_read_the_python_it_runs(scratch: Path) -> None:
    """What the decoders need, the interpreter's own files and the libraries, is readable after the cage."""
    attack = """
import decimal, json, zlib, importlib
importlib.import_module("PIL.Image")
print("IMPORTED")
"""
    done = in_the_cage(attack, scratch)
    assert done.returncode == 0, done.stderr
    assert "IMPORTED" in done.stdout


@needs_cage
def test_without_landlock_the_cage_runs_with_one_layer_less_and_says_so(scratch: Path) -> None:
    """On a kernel with no Landlock the worker still has its filter, and its report says the layer is missing."""
    prelude = "sandbox.landlock_abi = lambda: 0"
    attack = """
import socket
print("ABI", report.landlock_abi)
try:
    socket.socket()
except PermissionError:
    print("SOCKET-REFUSED")
"""
    done = in_the_cage(attack, scratch, prelude=prelude)
    assert done.returncode == 0, done.stderr
    assert "ABI 0" in done.stdout
    assert "SOCKET-REFUSED" in done.stdout


@needs_cage
def test_the_service_can_insist_on_landlock(scratch: Path) -> None:
    """With `require_landlock`, a kernel without it means no cage, so the worker refuses to read the file."""
    prelude = "sandbox.landlock_abi = lambda: 0"
    done = in_the_cage("print('REACHED')", scratch, prelude=prelude, limits=cage_limits(require_landlock=True))
    assert done.returncode == 3
    assert "SANDBOX-ERROR" in done.stdout
    assert "REACHED" not in done.stdout


@needs_cage
def test_a_cage_that_does_not_hold_is_found_out_by_the_proof(scratch: Path) -> None:
    """If the filter were not installed, the worker's own attempt to open a socket would succeed, and it stops."""
    prelude = "sandbox.install_seccomp = lambda architecture: None"
    done = in_the_cage("print('REACHED')", scratch, prelude=prelude)
    assert done.returncode == 3
    assert "A socket opened inside the cage" in done.stdout
    assert "REACHED" not in done.stdout


@needs_cage
def test_running_out_of_cpu_time_ends_the_process(scratch: Path) -> None:
    """The CPU limit is a hard limit: a worker that spins is killed by the kernel after its seconds."""
    attack = "while True:\n    pass"
    done = in_the_cage(attack, scratch, limits=cage_limits(cpu_seconds=1))
    assert done.returncode == -signal.SIGKILL


@needs_cage
def test_a_file_cannot_grow_past_the_size_limit(scratch: Path) -> None:
    """Writing more than `file_bytes` into one file fails, so a hostile decoder cannot fill the disk with one."""
    attack = """
try:
    with open(scratch / "big.bin", "wb") as handle:
        for _ in range(4):
            handle.write(b"x" * (1024 * 1024))
            handle.flush()
except OSError as error:
    print("STOPPED", error.errno)
"""
    done = in_the_cage(attack, scratch, limits=cage_limits(file_bytes=2 * 1024 * 1024))
    assert done.returncode == 0, done.stderr
    assert f"STOPPED {errno.EFBIG}" in done.stdout
    assert (scratch / "big.bin").stat().st_size <= 2 * 1024 * 1024


@needs_cage
def test_memory_is_capped(scratch: Path) -> None:
    """Asking for more memory than the limit is a MemoryError, not a swollen process."""
    attack = """
try:
    block = bytearray(1500 * 1024 * 1024)
except MemoryError:
    print("MEMORY-REFUSED")
else:
    print("ALLOCATED")
"""
    done = in_the_cage(attack, scratch, limits=cage_limits(memory_bytes=1024 * 1024 * 1024))
    assert done.returncode == 0, done.stderr
    assert "MEMORY-REFUSED" in done.stdout


@needs_cage
def test_open_files_are_capped(scratch: Path) -> None:
    """A worker may hold only a few files open, so a file that makes it open thousands gets an error."""
    attack = """
handles = []
try:
    for number in range(200):
        handles.append(open("/dev/null", "rb"))
except OSError as error:
    print("TOO-MANY", error.errno)
"""
    done = in_the_cage(attack, scratch, limits=cage_limits(open_files=32))
    assert done.returncode == 0, done.stderr
    assert f"TOO-MANY {errno.EMFILE}" in done.stdout
