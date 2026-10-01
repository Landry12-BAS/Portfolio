"""Tests for core.databases: each system gets an engine that works inside its own schema and no other."""

import pytest

from core.databases import connection_options, create_system_engine, sqlalchemy_url, system_engines


def test_builds_a_url_from_unquoted_parts() -> None:
    """The URL's parts are unquoted and passed as fields, through the psycopg driver."""
    url = sqlalchemy_url("postgres://lb%40ops:p%3Ass@db.internal:6543/basalt?sslmode=require")

    assert url.drivername == "postgresql+psycopg"
    assert (url.username, url.password) == ("lb@ops", "p:ss")
    assert (url.host, url.port, url.database) == ("db.internal", 6543, "basalt")
    assert dict(url.query) == {"sslmode": "require"}


def test_uses_the_default_port() -> None:
    """A URL without a port connects to 5432."""
    assert sqlalchemy_url("postgresql://lb@db/lb").port == 5432


@pytest.mark.parametrize(
    ("url", "problem"),
    [
        ("mysql://lb@db/lb", "must start with postgres://"),
        ("postgres://lb@db/", "needs a host and a database name"),
        ("postgres:///lb", "needs a host and a database name"),
        # A URL must not be able to widen a system's search_path.
        ("postgres://lb@db/lb?options=-c%20search_path%3Dpublic", "isn't supported"),
        ("postgres://lb@db/lb?sslrootcert=/tmp/ca.pem", "isn't supported"),
    ],
)
def test_refuses_a_url_it_cant_use_safely(url: str, problem: str) -> None:
    """Other databases, incomplete URLs and unknown options are refused."""
    with pytest.raises(ValueError, match=problem):
        sqlalchemy_url(url)


def test_a_connection_works_inside_its_own_schema_only() -> None:
    """The session options hold the system's schema and nothing else on the search_path."""
    options = connection_options("lb05")

    assert "-c search_path=lb05 " in options
    assert "public" not in options
    assert "-c statement_timeout=5000" in options
    with pytest.raises(ValueError, match="not a system schema"):
        connection_options("public")


def test_the_engine_is_made_for_the_schema_without_connecting() -> None:
    """Creating an engine opens nothing, so the app starts even when the database is down."""
    engine = create_system_engine("postgres://lb:secret@127.0.0.1:1/lb", "lb05")

    assert engine.dialect.name == "postgresql"
    assert engine.url.password == "secret"
    engine.dispose()


def test_a_system_uses_its_own_url_when_it_has_one() -> None:
    """A system's own URL (its own role, in production) wins over the shared one."""
    shared = "postgres://shared@127.0.0.1/lb"

    own = system_engines(shared, {"lb05": "postgres://lb05@127.0.0.1/lb"})["lb05"]
    fallback = system_engines(shared, {"lb05": None})["lb05"]

    assert own.url.username == "lb05"
    assert fallback.url.username == "shared"
    own.dispose()
    fallback.dispose()
