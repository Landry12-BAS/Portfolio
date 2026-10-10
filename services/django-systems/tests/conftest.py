"""Fixtures shared by the Django systems' tests: the Postgres and the Redis the integration tests run on.

Integration tests use a real Postgres with pgvector, because schemas, generated columns,
check constraints, vector indexes and exclusion constraints are exactly what a fake
database would get wrong. LB_TEST_DATABASE_URL points at a running server (CI starts
one); without it, Testcontainers starts one in Docker. The few tests about the real
channel layer use a real Redis the same way: LB_TEST_REDIS_URL, or a container. Unit
tests never ask for either, so they run without Docker, and pytest-django refuses any
database access they attempt.
"""

import base64
import os
import secrets
from collections.abc import Iterator

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from django.conf import settings
from pytest_django.fixtures import Settings
from redis import Redis

from config.channel_layer import channel_layers
from core.databases import SYSTEM_SCHEMAS, database_from_url

# The Postgres and pgvector versions production runs, and the Redis version the gateway's tests use too.
POSTGRES_IMAGE = "pgvector/pgvector:pg17"
REDIS_IMAGE = "redis:8.10-alpine"
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


@pytest.fixture(scope="session")
def redis_url() -> Iterator[str]:
    """Provide the URL of a real Redis: LB_TEST_REDIS_URL when set, otherwise a container."""
    external = os.environ.get("LB_TEST_REDIS_URL")
    if external:
        yield external
        return
    # Imported here, so runs with LB_TEST_REDIS_URL never need Docker.
    from testcontainers.community.redis import RedisContainer

    with RedisContainer(REDIS_IMAGE) as container:
        yield f"redis://{container.get_container_host_ip()}:{container.get_exposed_port(6379)}"


@pytest.fixture
def redis_channel_layer(settings: Settings, redis_url: str) -> Iterator[str]:
    """Run the test on the real Redis channel layer, under a key prefix of its own, and return the prefix.

    The settings are what production uses (built by the same function, so the timeouts are
    the real ones), with a prefix only this test writes under, and its keys are removed
    afterwards, so tests never share state.
    """
    prefix = f"lbtest-{secrets.token_hex(6)}:"
    settings.CHANNEL_LAYERS = channel_layers(redis_url, f"{prefix}channels:")
    yield prefix
    client = Redis.from_url(redis_url)
    keys = list(client.scan_iter(match=f"{prefix}*"))
    if keys:
        client.delete(*keys)
    client.close()


@pytest.fixture
def web_signing_key(settings: Settings) -> Ed25519PrivateKey:
    """Make the site's signing key, and give the service its public half the way the environment does."""
    key = Ed25519PrivateKey.generate()
    raw = key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    settings.WEB_TOKEN_KEY = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    return key
