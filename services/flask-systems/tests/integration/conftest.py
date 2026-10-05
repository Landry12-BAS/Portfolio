"""Fixtures for the integration tests: a real Postgres with LB-05's schema migrated, and a real Redis.

The quota ledger is atomic SQL, the schema is built by Alembic and run spans are Redis streams: a fake of any of
them would only imitate the behaviour these tests are there to prove. LB_TEST_DATABASE_URL and LB_TEST_REDIS_URL point
at running servers (CI starts them); without them, Testcontainers starts both in Docker. The Postgres user needs the
right to create databases: every session makes a database of its own on the server, and drops it when it ends, so
no other database is touched and nothing is left behind. Unit tests never ask for these fixtures, so they run
without Docker.
"""

import os
import secrets
from collections.abc import Callable, Iterator
from urllib.parse import urlsplit

import psycopg
import pytest
from psycopg import sql
from redis import Redis
from sqlalchemy import Engine, delete

from core.databases import create_system_engine
from core.migrations import upgrade
from lb03 import models as lb03_models
from lb05.models import QuotaUsage
from lb05.module import MIGRATIONS
from lb10 import models as lb10_models
from lb10.module import MIGRATIONS as LB10_MIGRATIONS
from lb_common.tracing import Span

# The Postgres production runs, and the Redis the gateway's integration tests use too.
POSTGRES_IMAGE = "pgvector/pgvector:pg17"
REDIS_IMAGE = "redis:8.10-alpine"


@pytest.fixture(scope="session")
def postgres_url() -> Iterator[str]:
    """Provide the URL of a real Postgres: LB_TEST_DATABASE_URL when set, otherwise a container."""
    external = os.environ.get("LB_TEST_DATABASE_URL")
    if external:
        yield external
        return
    # Imported here, so runs with LB_TEST_DATABASE_URL never need Docker.
    from testcontainers.community.postgres import PostgresContainer

    with PostgresContainer(POSTGRES_IMAGE, driver=None) as container:
        yield container.get_connection_url()


def url_for_database(server_url: str, name: str) -> str:
    """Return the URL of the database `name` on the server `server_url` points at."""
    return urlsplit(server_url)._replace(path=f"/{name}").geturl()


@pytest.fixture(scope="session")
def make_database(postgres_url: str) -> Iterator[Callable[[], str]]:
    """Return a maker of empty databases on the test server, which are all dropped when the session ends."""
    created: list[str] = []

    def make() -> str:
        """Create an empty database with a name of its own, and return its URL."""
        name = f"lb_flask_test_{secrets.token_hex(5)}"
        with psycopg.connect(postgres_url, autocommit=True) as connection:
            connection.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
        created.append(name)
        return url_for_database(postgres_url, name)

    yield make
    with psycopg.connect(postgres_url, autocommit=True) as connection:
        for name in created:
            connection.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name)))


@pytest.fixture(scope="session")
def migrated_engine(make_database: Callable[[], str]) -> Iterator[Engine]:
    """Make a database, bring LB-05's schema up to date with its real migrations, and connect as the service does."""
    engine = create_system_engine(make_database(), "lb05")
    upgrade(engine, "lb05", MIGRATIONS)
    yield engine
    engine.dispose()


@pytest.fixture
def engine(migrated_engine: Engine) -> Engine:
    """Return LB-05's engine on a ledger with no counters, so a test starts from nothing."""
    with migrated_engine.begin() as connection:
        connection.execute(delete(QuotaUsage))
    return migrated_engine


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
def prefix() -> str:
    """Make a key prefix for one test, in the gateway's format (such as `lbtest-1a2b3c4d5e6f:`)."""
    return f"lbtest-{secrets.token_hex(6)}:"


@pytest.fixture
def redis(redis_url: str, prefix: str) -> Iterator[Redis]:
    """Connect to the test Redis, and remove the test's keys when it ends."""
    client = Redis.from_url(redis_url, decode_responses=True)
    yield client
    keys = list(client.scan_iter(match=f"{prefix}*"))
    if keys:
        client.delete(*keys)
    client.close()


@pytest.fixture
def read_spans(redis: Redis) -> Callable[[str], list[Span]]:
    """Return a reader for the spans in one Redis stream, oldest first."""

    def read(key: str) -> list[Span]:
        """Read and validate every span in the stream at `key`."""
        entries = redis.xrange(key) or []
        return [Span.model_validate_json(fields["span"]) for _, fields in entries if fields]

    return read


@pytest.fixture(scope="session")
def lb03_migrated_engine(make_database: Callable[[], str]) -> Iterator[Engine]:
    """Make a database, bring LB-03's schema up to date with its real migrations, and connect as the service does."""
    engine = create_system_engine(make_database(), "lb03")
    upgrade(engine, "lb03", lb03_models.MIGRATIONS)
    yield engine
    engine.dispose()


@pytest.fixture
def lb03_engine(lb03_migrated_engine: Engine) -> Engine:
    """Return LB-03's engine with no documents and no counters, so a test starts from nothing."""
    with lb03_migrated_engine.begin() as connection:
        connection.execute(delete(lb03_models.Document))
        connection.execute(delete(lb03_models.QuotaUsage))
    return lb03_migrated_engine


@pytest.fixture(scope="session")
def lb10_migrated_engine(make_database: Callable[[], str]) -> Iterator[Engine]:
    """Make a database, bring LB-10's schema up to date with its real migrations, and connect as the service does."""
    engine = create_system_engine(make_database(), "lb10")
    upgrade(engine, "lb10", LB10_MIGRATIONS)
    yield engine
    engine.dispose()


@pytest.fixture
def lb10_engine(lb10_migrated_engine: Engine) -> Engine:
    """Return LB-10's engine with no runs, no cached results and no counters, so a test starts from nothing."""
    with lb10_migrated_engine.begin() as connection:
        connection.execute(delete(lb10_models.EvalRun))
        connection.execute(delete(lb10_models.CaseResult))
        connection.execute(delete(lb10_models.NightlyResult))
        connection.execute(delete(lb10_models.QuotaUsage))
    return lb10_migrated_engine
