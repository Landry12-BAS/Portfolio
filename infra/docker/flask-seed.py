"""Release step of LB-05's data: make the synthetic warehouse, unless the volume already holds one the service accepts.

LB-05 answers questions by querying a DuckDB file it opens read-only, and that file is
generated, never committed (services/flask-systems/README.md, "The data"). On the box the
file lives on a volume of its own: this one-shot job is the only container that can write
to it, and the API mounts it read-only, so a compromised API can't change the data it
answers from. The job has no network and no secret (docker-compose.yml).

It runs on every deploy, and does nothing when the data is already there: the service's own
reader (`read_meta`) must accept it, it must be of the size asked for, and the DuckDB file
must exist. A new generator version, a different size or a missing volume makes it generate
again; `--force` does so on purpose, and the API needs a restart to see the new file.

Run from the service's folder, which is where the image keeps this file next to manage.py:

    python seed_warehouse.py [--force]

Settings, from the environment: LB05_WAREHOUSE_DIR, where the dataset goes (required; its
parent folder must be writable, because the files are built beside it and renamed into
place), and LB05_SEED_SIZE, one of full, small or tiny (default full, about two million
orders; small is for a local stack).
"""

import os
import sys
from pathlib import Path

from config.systems import SYSTEMS
from core.cli import main as run_command
from core.cli import write_line
from lb05.generator import SIZES
from lb05.warehouse_build import DATABASE_FILE, WarehouseMetaError, read_meta

DEFAULT_SIZE = "full"


def holds_current_dataset(directory: Path, size: str) -> bool:
    """Tell whether the directory holds a dataset of this size that the service would accept."""
    try:
        meta = read_meta(directory)
    except WarehouseMetaError:
        return False
    return meta.size == size and (directory / DATABASE_FILE).is_file()


def main(arguments: list[str]) -> int:
    """Generate the dataset when it is missing, out of date or forced, and return the exit status."""
    if arguments not in ([], ["--force"]):
        write_line("usage: python seed_warehouse.py [--force]", error=True)
        return 2
    location = os.environ.get("LB05_WAREHOUSE_DIR", "")
    if not location:
        write_line("LB05_WAREHOUSE_DIR is not set.", error=True)
        return 2
    size = os.environ.get("LB05_SEED_SIZE", DEFAULT_SIZE)
    if size not in SIZES:
        write_line(f"LB05_SEED_SIZE must be one of {', '.join(sorted(SIZES))}.", error=True)
        return 2
    directory = Path(location)
    if arguments != ["--force"] and holds_current_dataset(directory, size):
        write_line(f"The {size} dataset is already in {directory}: nothing to do.")
        return 0
    return run_command(["seed_lb05", "--size", size, "--data", str(directory)], os.environ, SYSTEMS)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
