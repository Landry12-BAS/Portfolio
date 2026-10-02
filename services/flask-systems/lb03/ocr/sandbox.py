"""The cage the OCR worker puts round itself before it reads a byte of a visitor's file.

A decoder is the likeliest place for a hostile file to find a bug, so the process that decodes is made
harmless first, from the inside, by itself, with what Linux gives an unprivileged process:

- **Limits** (`apply_rlimits`): CPU seconds, address space, the size of any file it writes, the number of
  open files, and no core dump. The service adds a wall-clock limit from outside and kills the process group.
- **No new privileges and not dumpable**, so nothing it runs can gain rights, and no other process of the
  same user can read its memory.
- **A syscall filter** (seccomp): creating or using a socket is refused (EPERM), so there is no network, and
  starting another program, attaching to a process, mounting, loading a module, `bpf` and `io_uring` are
  fatal. Threads, files and pipes work: the OCR needs them. The filter is written here, as the few
  instructions it is, with the numbers of both architectures the platform runs on, and a test checks those
  numbers against libseccomp's.
- **Landlock**, where the kernel has it (Linux 5.13 and later): the process may read the Python it is
  running, the system libraries, a few device files and its own `/proc/self`, and may write nowhere but its
  scratch folder. It cannot read the service's key, the service's folder or the file store, even though they
  belong to the same user. Where the kernel has no Landlock the worker says so (`landlock_abi` 0 in its
  report) and runs on with one layer less, unless the service insists (`require_landlock`).

After the cage is up, the worker proves it: it tries to open a socket, and, under Landlock, to write and
read outside its folder, and stops at once if any of that works. A cage that is not there is an error, not a
silent default. The platform must be Linux on x86-64 or aarch64; anything else fails closed.

This module imports only the standard library and lb03's own small modules: it runs in a process that must
not load any of the web service.
"""

import ctypes
import errno
import os
import platform
import resource
import socket
import stat
import struct
import sys
from pathlib import Path

from lb03.ocr.protocol import SandboxReport, WorkerLimits


class SandboxError(Exception):
    """The cage could not be built, or it does not hold: the worker must not read the file."""


# The audit architecture numbers a seccomp filter must check first, so a call made through another ABI is not mistaken.
AUDIT_ARCH = {"x86_64": 0xC000003E, "aarch64": 0xC00000B7}
# Syscall numbers, one row per call: its name, then its number on x86-64 and on aarch64. They come from libseccomp
# 2.5.5, and tests/unit/test_lb03_ocr_sandbox.py checks every row against libseccomp again where it is installed.
SYSCALL_NUMBERS = (
    ("socket", 41, 198),
    ("socketpair", 53, 199),
    ("connect", 42, 203),
    ("bind", 49, 200),
    ("listen", 50, 201),
    ("accept", 43, 202),
    ("accept4", 288, 242),
    ("sendto", 44, 206),
    ("sendmsg", 46, 211),
    ("sendmmsg", 307, 269),
    ("recvfrom", 45, 207),
    ("recvmsg", 47, 212),
    ("recvmmsg", 299, 243),
    ("execve", 59, 221),
    ("execveat", 322, 281),
    ("ptrace", 101, 117),
    ("process_vm_readv", 310, 270),
    ("process_vm_writev", 311, 271),
    ("mount", 165, 40),
    ("umount2", 166, 39),
    ("pivot_root", 155, 41),
    ("chroot", 161, 51),
    ("unshare", 272, 97),
    ("setns", 308, 268),
    ("bpf", 321, 280),
    ("perf_event_open", 298, 241),
    ("userfaultfd", 323, 282),
    ("keyctl", 250, 219),
    ("add_key", 248, 217),
    ("request_key", 249, 218),
    ("kexec_load", 246, 104),
    ("kexec_file_load", 320, 294),
    ("init_module", 175, 105),
    ("finit_module", 313, 273),
    ("delete_module", 176, 106),
    ("open_by_handle_at", 304, 265),
    ("name_to_handle_at", 303, 264),
    ("io_uring_setup", 425, 425),
    ("io_uring_enter", 426, 426),
    ("io_uring_register", 427, 427),
    ("reboot", 169, 142),
    ("swapon", 167, 224),
    ("swapoff", 168, 225),
    ("acct", 163, 89),
    ("fanotify_init", 300, 262),
    ("mount_setattr", 442, 442),
    ("move_mount", 429, 429),
    ("open_tree", 428, 428),
    ("fsopen", 430, 430),
    ("fsmount", 432, 432),
    ("fsconfig", 431, 431),
    ("fspick", 433, 433),
)
# Refused with EPERM, so a library that tries gets an error it can handle: everything that makes or uses a socket.
REFUSED = (
    "socket",
    "socketpair",
    "connect",
    "bind",
    "listen",
    "accept",
    "accept4",
    "sendto",
    "sendmsg",
    "sendmmsg",
    "recvfrom",
    "recvmsg",
    "recvmmsg",
)
# Fatal: nothing the OCR does needs any of these, so a call to one is an attack. It is every other row of the table.
FATAL = tuple(name for name, _, _ in SYSCALL_NUMBERS if name not in REFUSED)

# prctl options and seccomp constants (linux/prctl.h, linux/seccomp.h, linux/filter.h).
PR_SET_DUMPABLE = 4
PR_SET_SECCOMP = 22
PR_SET_NO_NEW_PRIVS = 38
SECCOMP_MODE_FILTER = 2
SECCOMP_RET_ALLOW = 0x7FFF0000
SECCOMP_RET_KILL_PROCESS = 0x80000000
SECCOMP_RET_ERRNO = 0x00050000
BPF_LD_W_ABS = 0x20
BPF_JEQ_K = 0x15
BPF_JGE_K = 0x35
BPF_RET_K = 0x06
# The offsets of the syscall number and the architecture in the data a filter reads, and the x32 ABI's flag bit.
OFFSET_NR = 0
OFFSET_ARCH = 4
X32_FLAG = 0x40000000

# Landlock (linux/landlock.h): the system calls, the access rights, and the scope bits.
SYS_LANDLOCK_CREATE_RULESET = 444
SYS_LANDLOCK_ADD_RULE = 445
SYS_LANDLOCK_RESTRICT_SELF = 446
LANDLOCK_CREATE_RULESET_VERSION = 1
LANDLOCK_RULE_PATH_BENEATH = 1
ACCESS_EXECUTE = 1 << 0
ACCESS_WRITE_FILE = 1 << 1
ACCESS_READ_FILE = 1 << 2
ACCESS_READ_DIR = 1 << 3
ACCESS_REMOVE_DIR = 1 << 4
ACCESS_REMOVE_FILE = 1 << 5
ACCESS_MAKE_CHAR = 1 << 6
ACCESS_MAKE_DIR = 1 << 7
ACCESS_MAKE_REG = 1 << 8
ACCESS_MAKE_SOCK = 1 << 9
ACCESS_MAKE_FIFO = 1 << 10
ACCESS_MAKE_BLOCK = 1 << 11
ACCESS_MAKE_SYM = 1 << 12
ACCESS_REFER = 1 << 13
ACCESS_TRUNCATE = 1 << 14
ACCESS_IOCTL_DEV = 1 << 15
NET_BIND_TCP = 1 << 0
NET_CONNECT_TCP = 1 << 1
SCOPE_ABSTRACT_UNIX_SOCKET = 1 << 0
SCOPE_SIGNAL = 1 << 1
# What each Landlock version added: rights from version 2 (REFER), 3 (TRUNCATE) and 5 (IOCTL_DEV).
FILE_RIGHTS_BY_ABI = ((1, (1 << 13) - 1), (2, ACCESS_REFER), (3, ACCESS_TRUNCATE), (5, ACCESS_IOCTL_DEV))
FILE_ONLY_RIGHTS = ACCESS_EXECUTE | ACCESS_WRITE_FILE | ACCESS_READ_FILE | ACCESS_TRUNCATE | ACCESS_IOCTL_DEV
READ_RIGHTS = ACCESS_EXECUTE | ACCESS_READ_FILE | ACCESS_READ_DIR
SCRATCH_RIGHTS = (
    ACCESS_READ_FILE
    | ACCESS_WRITE_FILE
    | ACCESS_READ_DIR
    | ACCESS_REMOVE_DIR
    | ACCESS_REMOVE_FILE
    | ACCESS_MAKE_DIR
    | ACCESS_MAKE_REG
    | ACCESS_TRUNCATE
)
# Device files the Python and the libraries touch: read-only, but /dev/null which is written to too.
DEVICE_READS = ("/dev/urandom", "/dev/random", "/dev/zero")
# The name of the file the proof tries to create beside the scratch folder, which the cage must refuse.
ESCAPE_PROBE = "lb03-escape-probe"
# Where a process says how willing it is to be killed when the machine runs out of memory, and the most it can say.
OOM_SCORE_FILE = "/proc/self/oom_score_adj"
OOM_SCORE_MAX = 1000
# Where the system's libraries and the CPU's description live: read-only.
SYSTEM_READS = ("/usr", "/lib", "/lib64", "/etc/ld.so.cache", "/sys/devices/system/cpu", "/proc/self")

libc = ctypes.CDLL(None, use_errno=True)
libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
libc.prctl.restype = ctypes.c_int
libc.syscall.restype = ctypes.c_long


class SockFprog(ctypes.Structure):
    """The seccomp filter as the kernel takes it: how many instructions, and where they are."""

    _fields_ = (("length", ctypes.c_ushort), ("filter", ctypes.c_void_p))


class RulesetAttr(ctypes.Structure):
    """The rights a Landlock ruleset handles: files, TCP, and the scopes of newer kernels."""

    _fields_ = (
        ("handled_access_fs", ctypes.c_uint64),
        ("handled_access_net", ctypes.c_uint64),
        ("scoped", ctypes.c_uint64),
    )


class PathBeneathAttr(ctypes.Structure):
    """One Landlock rule: the rights granted beneath one directory or file, which is held open by its descriptor."""

    _pack_ = 1
    _fields_ = (("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32))


def apply_rlimits(limits: WorkerLimits) -> None:
    """Set the process's own limits: CPU time, memory, file size, open files, no core file.

    The soft and the hard limit are the same, so the first to be reached ends the process (the kernel
    sends SIGKILL at the hard CPU limit), and the process can never raise them again.
    """
    for name, value in (
        (resource.RLIMIT_CPU, limits.cpu_seconds),
        (resource.RLIMIT_AS, limits.memory_bytes),
        (resource.RLIMIT_FSIZE, limits.file_bytes),
        (resource.RLIMIT_NOFILE, limits.open_files),
        (resource.RLIMIT_CORE, 0),
    ):
        resource.setrlimit(name, (value, value))


def volunteer_for_the_oom_killer() -> int:
    """Ask the kernel to kill this process first when the machine runs out of memory; return the score it holds now.

    The worker is the biggest thing in the container beside the service (about 840 MiB at the most, measured, in
    a container of a couple of GiB), so without this the kernel's pick could be the service, and every document
    in flight with it. Raising one's own score needs no privilege. Where the file can't be written (a read-only
    /proc) the worker goes on and reports 0: this is a courtesy to the service, not a wall of the cage.
    """
    score_file = Path(OOM_SCORE_FILE)
    try:
        score_file.write_text(str(OOM_SCORE_MAX), encoding="ascii")
        return int(score_file.read_text(encoding="ascii"))
    except (OSError, ValueError):
        return 0


def refuse_privileges() -> None:
    """Forbid gaining new privileges, which seccomp and Landlock require, and make the process not dumpable."""
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        raise SandboxError("The kernel did not accept no_new_privs.")
    if libc.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0:
        raise SandboxError("The kernel did not accept dumpable 0.")


def instruction(code: int, jump_true: int, jump_false: int, operand: int) -> bytes:
    """Encode one BPF instruction: the code, where to jump when true and when false, and the operand."""
    return struct.pack("=HBBI", code, jump_true, jump_false, operand)


def numbers_for(architecture: str) -> dict[str, int]:
    """Return each listed system call's number on one architecture."""
    numbers = {}
    for name, x86_64_number, aarch64_number in SYSCALL_NUMBERS:
        numbers[name] = x86_64_number if architecture == "x86_64" else aarch64_number
    return numbers


def build_filter(architecture: str) -> bytes:
    """Build the seccomp program for an architecture: refuse the network, kill on what no OCR needs, allow the rest.

    It checks the architecture first (a call made through another ABI would be numbered differently) and,
    on x86-64, kills any call in the x32 number range, which would otherwise slip past the numbers.
    """
    if architecture not in AUDIT_ARCH:
        raise SandboxError(f"The cage is built for x86_64 and aarch64, not {architecture}.")
    table = numbers_for(architecture)
    program = [
        instruction(BPF_LD_W_ABS, 0, 0, OFFSET_ARCH),
        instruction(BPF_JEQ_K, 1, 0, AUDIT_ARCH[architecture]),
        instruction(BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS),
        instruction(BPF_LD_W_ABS, 0, 0, OFFSET_NR),
    ]
    if architecture == "x86_64":
        program += [instruction(BPF_JGE_K, 0, 1, X32_FLAG), instruction(BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS)]
    for name in REFUSED:
        program += [
            instruction(BPF_JEQ_K, 0, 1, table[name]),
            instruction(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | errno.EPERM),
        ]
    for name in FATAL:
        program += [instruction(BPF_JEQ_K, 0, 1, table[name]), instruction(BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS)]
    program.append(instruction(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW))
    return b"".join(program)


def install_seccomp(architecture: str) -> None:
    """Install the filter on this process, for good: there is no way to take a seccomp filter off."""
    program = build_filter(architecture)
    buffer = ctypes.create_string_buffer(program, len(program))
    fprog = SockFprog(len(program) // 8, ctypes.cast(buffer, ctypes.c_void_p))
    if libc.prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, ctypes.addressof(fprog), 0, 0) != 0:
        raise SandboxError("The kernel did not accept the syscall filter.")


def landlock_abi() -> int:
    """Return the Landlock version the kernel speaks, or 0 when it has none (or the container's filter hides it)."""
    version = libc.syscall(SYS_LANDLOCK_CREATE_RULESET, None, 0, LANDLOCK_CREATE_RULESET_VERSION)
    return int(version) if version > 0 else 0


def handled_file_rights(abi: int) -> int:
    """Return every file right a Landlock of this version can handle."""
    return sum(rights for since, rights in FILE_RIGHTS_BY_ABI if abi >= since)


def open_path(path: str) -> int | None:
    """Open a path only to name it in a rule (no read or write through it); None when it doesn't exist."""
    try:
        return os.open(path, os.O_PATH | os.O_CLOEXEC)
    except OSError:
        return None


def add_rule(ruleset: int, path: str, rights: int) -> None:
    """Allow `rights` beneath one path, when the path exists.

    Landlock refuses a rule that gives a plain file a right that only a directory can have (listing it,
    making things in it), so for a file the rights are cut down to the ones a file can have.
    """
    descriptor = open_path(path)
    if descriptor is None:
        return
    try:
        if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
            rights &= FILE_ONLY_RIGHTS
        attribute = PathBeneathAttr(rights, descriptor)
        if libc.syscall(SYS_LANDLOCK_ADD_RULE, ruleset, LANDLOCK_RULE_PATH_BENEATH, ctypes.byref(attribute), 0) != 0:
            raise SandboxError(f"Landlock refused a rule ({os.strerror(ctypes.get_errno())}).")
    finally:
        os.close(descriptor)


def readable_paths() -> list[str]:
    """List what the worker may read: the Python it runs and its packages, the system libraries, a few devices."""
    prefixes = {sys.prefix, sys.base_prefix, sys.exec_prefix}
    return sorted(prefixes) + list(SYSTEM_READS)


def apply_landlock(scratch: Path, abi: int) -> None:
    """Confine the process to reading its Python and writing its scratch folder, and shut TCP and signals out."""
    handled = handled_file_rights(abi)
    size = 8 if abi < 4 else 16 if abi < 6 else 24
    attribute = RulesetAttr(
        handled,
        (NET_BIND_TCP | NET_CONNECT_TCP) if abi >= 4 else 0,
        (SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL) if abi >= 6 else 0,
    )
    ruleset = int(libc.syscall(SYS_LANDLOCK_CREATE_RULESET, ctypes.byref(attribute), size, 0))
    if ruleset < 0:
        raise SandboxError(f"Landlock refused the ruleset ({os.strerror(ctypes.get_errno())}).")
    try:
        for path in readable_paths():
            add_rule(ruleset, path, READ_RIGHTS & handled)
        for path in DEVICE_READS:
            add_rule(ruleset, path, ACCESS_READ_FILE & handled)
        add_rule(ruleset, "/dev/null", (ACCESS_READ_FILE | ACCESS_WRITE_FILE) & handled)
        add_rule(ruleset, str(scratch), SCRATCH_RIGHTS & handled)
        if libc.syscall(SYS_LANDLOCK_RESTRICT_SELF, ruleset, 0) != 0:
            raise SandboxError(f"Landlock refused to restrict the process ({os.strerror(ctypes.get_errno())}).")
    finally:
        os.close(ruleset)


def apply_sandbox(scratch: Path, limits: WorkerLimits) -> SandboxReport:
    """Build the whole cage, in the one order that works, and report which walls stand.

    The limits were set before; this adds no-new-privileges, Landlock (when the kernel has it) and the syscall filter.
    Raises SandboxError on anything that cannot be done, so the worker never reads a file in a cage that isn't there.
    """
    if sys.platform != "linux":
        raise SandboxError("The OCR worker's cage needs Linux.")
    architecture = platform.machine()
    if architecture not in AUDIT_ARCH:
        raise SandboxError(f"The cage is built for x86_64 and aarch64, not {architecture}.")
    # First, while /proc/self is still writable: Landlock only lets the worker read it.
    oom_score_adj = volunteer_for_the_oom_killer()
    refuse_privileges()
    abi = landlock_abi()
    if abi == 0 and limits.require_landlock:
        raise SandboxError("This kernel has no Landlock, and the service requires it.")
    if abi > 0:
        apply_landlock(scratch, abi)
    install_seccomp(architecture)
    report = SandboxReport(
        rlimits=True, no_new_privileges=True, seccomp=True, landlock_abi=abi, oom_score_adj=oom_score_adj
    )
    verify_sandbox(report, scratch)
    return report


def verify_sandbox(report: SandboxReport, scratch: Path) -> None:
    """Try to do what the cage forbids, and raise if any of it works: the proof that the walls are there.

    A socket must fail with EPERM, the way the syscall filter refuses it. Under Landlock, writing next to the
    scratch folder and reading a file of the system outside the read list must fail with EACCES. The scratch
    folder itself must still be writable, or the worker could not leave its findings.
    """
    try:
        socket.socket(socket.AF_INET, socket.SOCK_STREAM).close()
    except OSError as error:
        if error.errno != errno.EPERM:
            raise SandboxError("A socket failed, but not the way the cage refuses it.") from None
    else:
        raise SandboxError("A socket opened inside the cage.")
    if report.landlock_abi > 0:
        refuse_to_touch(scratch.parent / ESCAPE_PROBE, write=True)
        refuse_to_touch(Path("/proc/version"), write=False)
    probe = scratch / ".probe"
    probe.write_bytes(b"x")
    probe.unlink()


def refuse_to_touch(path: Path, *, write: bool) -> None:
    """Raise unless the cage refuses, with a permission error, to write or read a path outside the scratch folder.

    Any other failure (the path is missing, say) proves nothing, so it fails the check too.
    """
    try:
        with path.open("wb" if write else "rb"):
            pass
    except PermissionError:
        return
    except OSError:
        raise SandboxError(f"The cage's {'write' if write else 'read'} probe failed, but not with a refusal.") from None
    if write:
        path.unlink(missing_ok=True)
    raise SandboxError(f"The cage let the worker {'write' if write else 'read'} {path.name}.")
