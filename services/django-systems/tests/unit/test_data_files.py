"""Tests for core.data_files: YAML data files are read safely and strictly, and problems name the file."""

from pathlib import Path

import pytest

from core.data_files import DataFileError, Key, StrictEntry, read_data_file


class Example(StrictEntry):
    """A small schema to read files against."""

    key: Key
    count: int


def test_reads_a_file_that_follows_its_schema(tmp_path: Path) -> None:
    """A valid file comes back as its schema."""
    path = tmp_path / "example.yaml"
    path.write_text("key: returns.withdrawal\ncount: 3\n", encoding="utf-8")

    assert read_data_file(path, Example) == Example(key="returns.withdrawal", count=3)


def test_names_the_file_and_the_field(tmp_path: Path) -> None:
    """A broken file is reported with its path and the path of the bad field inside it."""
    path = tmp_path / "example.yaml"
    path.write_text("key: Not A Key\ncount: 3\n", encoding="utf-8")

    with pytest.raises(DataFileError) as error:
        read_data_file(path, Example)

    assert str(path) in str(error.value)
    assert "- key: String should match pattern" in str(error.value)


def test_refuses_unknown_fields(tmp_path: Path) -> None:
    """A misspelt field is an error, never silently dropped."""
    path = tmp_path / "example.yaml"
    path.write_text("key: a\ncount: 3\ncuont: 4\n", encoding="utf-8")

    with pytest.raises(DataFileError, match="cuont: Extra inputs are not permitted"):
        read_data_file(path, Example)


def test_refuses_broken_yaml_and_missing_files(tmp_path: Path) -> None:
    """Unparseable YAML and a missing file both stop the reader with a clear message."""
    broken = tmp_path / "broken.yaml"
    broken.write_text("key: [unclosed\n", encoding="utf-8")

    with pytest.raises(DataFileError, match="isn't valid YAML"):
        read_data_file(broken, Example)
    with pytest.raises(DataFileError, match="can't be read"):
        read_data_file(tmp_path / "missing.yaml", Example)


def test_never_builds_python_objects_from_yaml(tmp_path: Path) -> None:
    """YAML tags that would construct Python objects are refused, not executed."""
    path = tmp_path / "example.yaml"
    path.write_text("key: !!python/object/apply:os.system ['true']\ncount: 1\n", encoding="utf-8")

    with pytest.raises(DataFileError, match="isn't valid YAML"):
        read_data_file(path, Example)
