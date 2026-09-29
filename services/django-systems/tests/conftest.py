"""Fixtures shared by the Django systems' tests: the Postgres the integration tests run on.

Integration tests use a real Postgres with pgvector, because schemas, generated columns,
check constraints and vector indexes are exactly what a fake database would get wrong.
LB_TEST_DATABASE_URL points at a running server (CI starts one); without it,
Testcontainers starts one in Docker. Unit tests never ask for it, so they run without
Docker, and pytest-django refuses any database access they attempt.
"""

import os
from collections.abc import Iterator

import pytest
from django.conf import settings

from core.databases import SYSTEM_SCHEMAS, database_from_url

# The Postgres and pgvector versions production runs.
POSTGRES_IMAGE = "pgvector/pgvector:pg17"
# The settings that say where a database is; each system keeps its own search_path.
CONNECTION_KEYS = ("HOST", "PORT", "USER", "PASSWORD", "NAME")


@pytest.fixture(scope="session")
def postgres_url() -> Iterator[str]:
    """Provide the URL of a real Postgres with pgvector: LB_TEST_DATABASE_URL when set, otherwise a container."""
    external = os.environ.get("LB_TEST_DATABASE_URL")
    if external:
        yield external
        return
    # Imported here, so runs with LB_TEST_DATABASE_URL never need Docker.
    from testcontainers.community.postgres import PostgresContainer

    with PostgresContainer(POSTGRES_IMAGE, driver=None) as container:
        yield container.get_connection_url()


@pytest.fixture(scope="session")
def django_db_modify_db_settings(
    django_db_modify_db_settings_parallel_suffix: None,  # noqa: ARG001 - asked for so it runs first, as upstream
    postgres_url: str,
) -> None:
    """Point every system's connection at the test Postgres before pytest-django makes the test databases.

    Only the address changes: each system keeps its schema, its search_path and its
    test database name (`test_<name>_<schema>`), as core.databases sets them.
    """
    for system in SYSTEM_SCHEMAS:
        test_database = database_from_url(postgres_url, schema=system)
        for key in CONNECTION_KEYS:
            settings.DATABASES[system][key] = test_database[key]
