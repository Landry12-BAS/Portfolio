"""One Postgres database, one schema per system (AGENTS.md, Architecture rules).

Each system talks to the database through an engine of its own, whose connections have
a search_path holding only that system's schema, so no query of one system can name
another's tables by accident. In production each engine also logs in as a role granted
only its schema (`LB05_DATABASE_URL` for LB-05). This is the SQLAlchemy twin of
services/django-systems/core/databases.py.
"""

from collections.abc import Mapping
from urllib.parse import parse_qsl, unquote, urlsplit

from sqlalchemy import Connection, Engine, create_engine, inspect, text
from sqlalchemy.engine import URL
from sqlalchemy.schema import CreateSchema

# The systems with data of their own. A system's schema is its part number without the hyphen.
SYSTEM_SCHEMAS: tuple[str, ...] = ("lb05",)
# The only URL parameters passed on to Postgres.
ALLOWED_URL_OPTIONS = frozenset({"sslmode", "connect_timeout"})
# No statement of the ledger's may run longer than this: they are all single-row lookups.
STATEMENT_TIMEOUT_MS = 5_000
# A pooled connection is replaced after this long, so a restarted database is noticed.
POOL_RECYCLE_SECONDS = 1_800
# How many connections a system may hold at once, and how long a request waits for one.
POOL_SIZE = 5
POOL_OVERFLOW = 5
POOL_TIMEOUT_SECONDS = 5


def sqlalchemy_url(url: str) -> URL:
    """Turn a postgres:// URL into the URL SQLAlchemy connects with, through the psycopg driver.

    The URL's parts are unquoted and passed as fields, never joined into a string, and only
    the options in ALLOWED_URL_OPTIONS are kept: a URL must not be able to widen a search_path.
    """
    parts = urlsplit(url)
    if parts.scheme not in ("postgres", "postgresql"):
        raise ValueError("The database URL must start with postgres:// or postgresql://.")
    name = unquote(parts.path.removeprefix("/"))
    if not parts.hostname or not name:
        raise ValueError("The database URL needs a host and a database name.")
    query: dict[str, str] = {}
    for key, value in parse_qsl(parts.query):
        if key not in ALLOWED_URL_OPTIONS:
            raise ValueError(f"The database URL option {key!r} isn't supported.")
        query[key] = value
    return URL.create(
        "postgresql+psycopg",
        username=unquote(parts.username) if parts.username else None,
        password=unquote(parts.password) if parts.password else None,
        host=parts.hostname,
        port=parts.port or 5432,
        database=name,
        query=query,
    )


def connection_options(schema: str) -> str:
    """Return the Postgres session options for one system: its own schema only, and a statement timeout."""
    if schema not in SYSTEM_SCHEMAS:
        raise ValueError(f"{schema!r} is not a system schema.")
    return f"-c search_path={schema} -c statement_timeout={STATEMENT_TIMEOUT_MS}"


def create_system_engine(url: str, schema: str) -> Engine:
    """Create the engine for one system: every connection works inside `schema` and nothing else."""
    return create_engine(
        sqlalchemy_url(url),
        connect_args={"options": connection_options(schema)},
        pool_size=POOL_SIZE,
        max_overflow=POOL_OVERFLOW,
        pool_timeout=POOL_TIMEOUT_SECONDS,
        pool_recycle=POOL_RECYCLE_SECONDS,
        pool_pre_ping=True,
    )


def system_engines(shared_url: str, own_urls: Mapping[str, str | None]) -> dict[str, Engine]:
    """Return one engine per system: from its own URL when it has one, else from the shared one.

    Nothing connects yet: an engine opens its first connection when first used.
    """
    return {schema: create_system_engine(own_urls.get(schema) or shared_url, schema) for schema in SYSTEM_SCHEMAS}


def can_query(engine: Engine) -> bool:
    """Tell whether a system's engine answers a trivial query, for the readiness check."""
    try:
        with engine.connect() as connection:
            return connection.execute(text("SELECT 1")).scalar_one() == 1
    except Exception:  # noqa: BLE001 - any failure means "not ready"; readiness must not raise
        return False


def ensure_schema(connection: Connection, schema: str) -> None:
    """Create a system's schema if it is missing, before its first migration.

    It checks before creating: in production the schema already exists, and a system's
    role has no right to create one.
    """
    if schema not in SYSTEM_SCHEMAS:
        raise ValueError(f"{schema!r} is not a system schema.")
    if not inspect(connection).has_schema(schema):
        connection.execute(CreateSchema(schema))
