"""Tests for core.databases: each system gets a connection that works inside its own schema."""

from types import SimpleNamespace
from typing import Any

import pytest

from core.databases import SystemSchemaRouter, database_from_url, system_databases, system_of
from lb01.models import Customer, Ticket


def model_of(app_label: str) -> Any:
    """Stand in for a model of another app; the router reads nothing but its app label."""
    return SimpleNamespace(_meta=SimpleNamespace(app_label=app_label))


def test_builds_a_connection_that_works_inside_the_system_schema() -> None:
    """The URL's parts are unquoted, and the search_path holds the schema and the extensions."""
    entry = database_from_url("postgres://lb%40ops:p%3Ass@db.internal:6543/basalt?sslmode=require", schema="lb01")

    assert entry["ENGINE"] == "django.db.backends.postgresql"
    assert (entry["USER"], entry["PASSWORD"]) == ("lb@ops", "p:ss")
    assert (entry["HOST"], entry["PORT"], entry["NAME"]) == ("db.internal", "6543", "basalt")
    assert entry["OPTIONS"] == {"options": "-c search_path=lb01,extensions", "sslmode": "require"}
    assert entry["TEST"] == {"NAME": "test_basalt_lb01", "DEPENDENCIES": []}


def test_uses_the_default_port() -> None:
    """A URL without a port connects to 5432."""
    assert database_from_url("postgresql://lb@db/lb", schema="lb01")["PORT"] == "5432"


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
        database_from_url(url, schema="lb01")


def test_a_system_uses_its_own_url_when_it_has_one() -> None:
    """A system's own URL (its own role, in production) wins over the shared one."""
    shared = "postgres://shared@db/lb"

    assert system_databases(shared, {"lb01": "postgres://lb01@db/lb"})["lb01"]["USER"] == "lb01"
    assert system_databases(shared, {"lb01": None})["lb01"]["USER"] == "shared"


def test_system_of_knows_only_the_systems() -> None:
    """A system's app maps to its alias; shared apps map to none."""
    assert system_of("lb01") == "lb01"
    assert system_of("core") is None


def test_reads_and_writes_go_to_the_models_system() -> None:
    """Every LB-01 model is read and written through the lb01 connection, and nothing else is routed."""
    router = SystemSchemaRouter()

    assert router.db_for_read(Ticket) == "lb01"
    assert router.db_for_write(Customer) == "lb01"
    assert router.db_for_read(model_of("core")) is None


def test_relations_stay_inside_one_system() -> None:
    """Models of one system may relate; models of two systems may not."""
    router = SystemSchemaRouter()

    assert router.allow_relation(model_of("lb01"), model_of("lb01")) is True
    assert router.allow_relation(model_of("lb01"), model_of("core")) is False


@pytest.mark.parametrize(
    ("database", "app_label", "allowed"),
    [
        ("lb01", "lb01", True),
        ("default", "lb01", False),
        ("lb01", "core", False),
        ("default", "core", True),
    ],
)
def test_migrations_run_only_on_the_systems_own_connection(database: str, app_label: str, allowed: bool) -> None:
    """A system migrates only on its alias, and no shared app migrates into a system's schema."""
    assert SystemSchemaRouter().allow_migrate(database, app_label) is allowed
