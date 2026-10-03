"""Unit tests for where LB-09's recordings wait: random names, private files, deletion and the sweep."""

import os
import time
from pathlib import Path

import pytest
from lb09.storage import AudioStore, is_store_name


def test_a_saved_recording_gets_a_random_private_name(tmp_path: Path) -> None:
    """The file is named by the store, readable by the service alone, and found again by that name only."""
    store = AudioStore(tmp_path / "audio")
    name = store.save(b"OggS...")
    assert is_store_name(name)
    path = store.path_of(name)
    assert path.read_bytes() == b"OggS..."
    assert oct(path.stat().st_mode & 0o777) == "0o600"
    assert oct(store.folder.stat().st_mode & 0o777) == "0o700"
    assert store.save(b"x") != name


@pytest.mark.parametrize(
    "name", ["../etc/passwd", "audio.audio", "", "a" * 40 + ".audio", "abc.mp3", "ABCDEFGHIJKLMNOPQRSTUVWX"]
)
def test_a_name_the_store_did_not_make_is_refused(tmp_path: Path, name: str) -> None:
    """A path a visitor could have sent never reaches the file system."""
    store = AudioStore(tmp_path)
    assert not is_store_name(name)
    with pytest.raises(ValueError, match="stored recording"):
        store.path_of(name)


def test_delete_removes_the_file_and_says_whether_there_was_one(tmp_path: Path) -> None:
    """Deleting twice is fine: the second time there is nothing to remove."""
    store = AudioStore(tmp_path)
    name = store.save(b"audio")
    assert store.delete(name) is True
    assert not store.path_of(name).exists()
    assert store.delete(name) is False


def test_the_sweep_removes_old_recordings_and_leaves_fresh_ones_and_other_files(tmp_path: Path) -> None:
    """A file older than the age goes, whatever left it; a fresh one stays; a file that isn't ours is not touched."""
    store = AudioStore(tmp_path)
    old = store.save(b"old")
    fresh = store.save(b"fresh")
    other = tmp_path / "notes.txt"
    other.write_text("keep me")
    long_ago = time.time() - 7_200
    os.utime(store.path_of(old), (long_ago, long_ago))
    os.utime(other, (long_ago, long_ago))
    assert store.sweep(older_than_seconds=3_600) == 1
    assert not store.path_of(old).exists()
    assert store.path_of(fresh).exists()
    assert other.exists()


def test_the_sweep_of_a_folder_that_does_not_exist_removes_nothing(tmp_path: Path) -> None:
    """Before the first recording there is no folder, and that is not an error."""
    assert AudioStore(tmp_path / "missing").sweep() == 0
