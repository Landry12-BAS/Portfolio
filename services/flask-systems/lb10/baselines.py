"""The committed baselines: what each pack scored on each alias when it was last measured, for the CI gate.

A baseline is a measurement, so none is invented: a file in evals/baselines is written only by the gate
command from a real run (`manage.py gate_lb10 --write-baselines`), and says when and from what it was
measured. Until a pack has one, the gate has nothing to compare with and says so instead of passing or
failing. The reader is strict, like every data file's.
"""

from datetime import date
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, StringConstraints

from core.data_files import DataFileError, Key, StrictEntry, read_data_file

# How a baseline was measured: on live providers, or offline on stored results with a fake gateway (tests only).
type BaselineSource = Literal["live", "offline"]


class BaselineEntry(StrictEntry):
    """One pack's score on one alias: the share of passing cases, its interval, and when it was measured."""

    pack: Key
    pack_version: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{16}$")]
    alias: Annotated[str, StringConstraints(pattern=r"^lb-[a-z0-9-]+$", max_length=40)]
    score: Annotated[float, Field(ge=0.0, le=1.0)]
    low: Annotated[float, Field(ge=0.0, le=1.0)]
    high: Annotated[float, Field(ge=0.0, le=1.0)]
    cases: Annotated[int, Field(ge=1)]
    measured_on: date
    source: BaselineSource


class BaselineFile(StrictEntry):
    """The whole of one baselines file: every alias a pack was measured on."""

    baselines: list[BaselineEntry] = Field(min_length=1)


def read_baselines(directory: Path) -> list[BaselineEntry]:
    """Read every baseline in a folder (none when the folder is empty or missing), by pack file name."""
    entries: list[BaselineEntry] = []
    if not directory.is_dir():
        return entries
    for path in sorted(directory.glob("*.yaml")):
        file = read_data_file(path, BaselineFile)
        for entry in file.baselines:
            if entry.pack != path.stem:
                raise DataFileError(f"{path} holds a baseline of the pack {entry.pack!r}, which another file names")
            entries.append(entry)
    return entries
