"""Tests for LB-02 in core.databases: its own connection and schema, and no way across to another system."""

from types import SimpleNamespace
from typing import Any

import pytest
from django.core.exceptions import ImproperlyConfigured

from config.environment import read_environment
from core.databases import SYSTEM_SCHEMAS, SystemSchemaRouter, database_from_url, system_databases, system_of
from lb01.models import Ticket
from lb02.models import Conversation, Reservation


def model_of(app_label: str) -> Any:
    """Stand in for a model of another app; the router reads nothing but its app label."""
    return SimpleNamespace(_meta=SimpleNamespace(app_label=app_label))


def test_lb02_is_a_system_with_a_schema_of_its_own() -> None:
    """Its connection searches its own schema, then the shared extensions, where btree_gist lives."""
    assert "lb02" in SYSTEM_SCHEMAS
    entry = database_from_url("postgres://lb:lb@db.internal/lb", schema="lb02")

    assert entry["OPTIONS"] == {"options": "-c search_path=lb02,extensions"}
    assert entry["TEST"] == {"NAME": "test_lb_lb02", "DEPENDENCIES": []}


def test_lb02_uses_its_own_database_url_when_it_has_one() -> None:
    """In production each system logs in as a role granted only its schema."""
    databases = system_databases("postgres://shared@db/lb", {"lb01": None, "lb02": "postgres://lb02-role@db/lb"})

    assert databases["lb02"]["USER"] == "lb02-role"
    assert databases["lb01"]["USER"] == "shared"


def test_the_environment_reads_an_optional_lb02_database_url() -> None:
    """The variable is optional, and must be a Postgres URL when it is set."""
    valid = {
        "DJANGO_SECRET_KEY": "k" * 50,
        "DJANGO_ALLOWED_HOSTS": "api.example.test",
        "LB_DATABASE_URL": "postgres://lb:lb@db:5432/lb",
        "LB_REDIS_URL": "redis://cache:6379/0",
    }

    assert read_environment(valid).lb02_database_url is None
    assert read_environment({**valid, "LB02_DATABASE_URL": "postgres://lb02@db/lb"}).lb02_database_url == (
        "postgres://lb02@db/lb"
    )
    with pytest.raises(ImproperlyConfigured, match="LB02_DATABASE_URL"):
        read_environment({**valid, "LB02_DATABASE_URL": "mysql://db/lb"})


def test_every_lb02_model_is_read_and_written_through_the_lb02_connection() -> None:
    """The router sends LB-02's models to their own connection, and refuses relations to another system."""
    router = SystemSchemaRouter()

    assert system_of("lb02") == "lb02"
    assert router.db_for_read(Conversation) == "lb02"
    assert router.db_for_write(Reservation) == "lb02"
    assert router.db_for_read(Ticket) == "lb01"
    assert router.allow_relation(model_of("lb02"), model_of("lb02")) is True
    assert router.allow_relation(model_of("lb02"), model_of("lb01")) is False
    assert router.allow_relation(model_of("lb02"), model_of("core")) is False


@pytest.mark.parametrize(
    ("database", "app_label", "allowed"),
    [("lb02", "lb02", True), ("lb01", "lb02", False), ("default", "lb02", False), ("lb02", "lb01", False)],
)
def test_lb02_migrates_only_on_its_own_connection(database: str, app_label: str, allowed: bool) -> None:
    """Its tables are created in its own schema and nowhere else, and no other system's land in it."""
    assert SystemSchemaRouter().allow_migrate(database, app_label) is allowed
