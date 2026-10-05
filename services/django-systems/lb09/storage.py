"""Where a recording waits for the worker, and how it is removed.

The API cannot transcribe in the request (a private transcription takes a while), so a recording is
written to a file for the worker, in a folder the API and the worker share (`LB09_AUDIO_DIR`, a memory-backed
volume on the box; docs/DEPLOY.md). The file has a random name, is readable by the service alone, and is
deleted the moment it has been transcribed, on success and on failure. A crash can leave one behind, so the
sweeper removes any file older than an hour. Nothing here ever logs a file's contents, and a name is never
built from anything a visitor sent.
"""

import logging
import os
import secrets
import tempfile
import time
from pathlib import Path

from django.conf import settings

from lb09.limits import AUDIO_MAX_AGE

logger = logging.getLogger(__name__)

# What a stored recording's name looks like: random URL-safe characters, then the suffix below.
SUFFIX = ".audio"


class AudioStore:
    """The folder recordings wait in."""

    def __init__(self, folder: Path | None = None) -> None:
        """Use `folder`, or the one the settings name, or a folder under the system's temporary directory."""
        self.folder = folder or default_folder()

    def ready(self) -> None:
        """Make the folder, readable by the service alone, if it isn't there yet."""
        self.folder.mkdir(mode=0o700, parents=True, exist_ok=True)

    def save(self, data: bytes) -> str:
        """Write a recording under a fresh random name, readable by the service alone, and return the name."""
        self.ready()
        name = secrets.token_urlsafe(18) + SUFFIX
        path = self.folder / name
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as file:
            file.write(data)
        return name

    def path_of(self, name: str) -> Path:
        """Return where a stored recording is; a name that isn't one of ours is refused."""
        if not is_store_name(name):
            raise ValueError("Not the name of a stored recording.")
        return self.folder / name

    def delete(self, name: str) -> bool:
        """Remove a recording, and say whether there was one to remove."""
        try:
            self.path_of(name).unlink()
        except FileNotFoundError:
            return False
        return True

    def sweep(self, older_than_seconds: float = AUDIO_MAX_AGE.total_seconds()) -> int:
        """Remove every recording older than the age, whatever left it behind, and return how many went."""
        if not self.folder.is_dir():
            return 0
        deadline = time.time() - older_than_seconds
        removed = 0
        for path in self.folder.iterdir():
            if is_store_name(path.name) and path.is_file() and path.stat().st_mtime < deadline:
                path.unlink(missing_ok=True)
                removed += 1
        return removed


def is_store_name(name: str) -> bool:
    """Tell whether a name is one the store made: random URL-safe characters and the suffix, nothing else."""
    stem = name.removesuffix(SUFFIX)
    return name.endswith(SUFFIX) and 20 <= len(stem) <= 32 and all(c.isalnum() or c in "-_" for c in stem)


def default_folder() -> Path:
    """Return the audio folder: `LB09_AUDIO_DIR` when set, else `lb09-audio` under the temporary directory."""
    configured = getattr(settings, "LB09_AUDIO_DIR", None)
    if configured:
        return Path(configured)
    return Path(tempfile.gettempdir()) / "lb09-audio"
