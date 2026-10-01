"""Fixtures shared by the Flask systems' tests: the semantic layer, the checks and a generated warehouse.

The warehouse is the small synthetic dataset (6,000 customers, about 28,000 orders), generated
once per test session with a fixed seed and as-of day, so every number a test reads is the same
on every run. DuckDB is a library, so no test here needs Docker; the integration tests that need
Postgres and Redis ask for their own fixtures (tests/integration/conftest.py).
"""

from collections.abc import Iterator
from pathlib import Path

import pytest

from core.platform import REPOSITORY_ROOT
from lb05.generator import SIZES, generate
from lb05.semantic_check import load_semantic_layer
from lb05.semantic_layer import SemanticLayer
from lb05.sql_policy import SqlPolicy
from lb05.warehouse import Warehouse
from lb05.warehouse_build import write_dataset
from tests.support import DATA_AS_OF, DATA_SEED

# Enough memory and threads for the tests' queries, and no more than a small machine has to spare.
TEST_MEMORY_LIMIT = "1GB"
TEST_THREADS = 2


@pytest.fixture(scope="session")
def lb05_seed_directory() -> Path:
    """Return the folder with LB-05's semantic layer, data/seed/lb05 in the repository."""
    return REPOSITORY_ROOT / "data" / "seed" / "lb05"


@pytest.fixture(scope="session")
def layer(lb05_seed_directory: Path) -> SemanticLayer:
    """Load the real semantic layer, which also proves every expression in it passes the SQL check."""
    return load_semantic_layer(lb05_seed_directory)


@pytest.fixture(scope="session")
def policy(layer: SemanticLayer) -> SqlPolicy:
    """Provide the parse-tree check for the real layer."""
    return SqlPolicy(layer)


@pytest.fixture(scope="session")
def small_data(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Generate the small dataset once per session, and return its folder (Parquet files and the DuckDB file)."""
    directory = tmp_path_factory.mktemp("lb05-data") / "small"
    write_dataset(generate(SIZES["small"], DATA_AS_OF, DATA_SEED), directory)
    return directory


@pytest.fixture(scope="session")
def warehouse(small_data: Path) -> Iterator[Warehouse]:
    """Open the small dataset the way the service does: read-only, locked, with limits."""
    opened = Warehouse.open(small_data, TEST_MEMORY_LIMIT, TEST_THREADS)
    yield opened
    opened.close()
