"""Tests for LB-10's Alembic migration (lb10/migrations) on a real Postgres, from an empty database."""

from collections.abc import Callable

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import Engine, inspect, text

from core.databases import create_system_engine
from core.migrations import upgrade
from lb10.models import Base
from lb10.module import MIGRATIONS

pytestmark = pytest.mark.integration


def test_upgrading_an_empty_database_builds_the_four_tables_in_the_lb10_schema(
    make_database: Callable[[], str],
) -> None:
    """The first deploy: the schema, its tables, their keys, and the version mark, all in lb10 and nothing in public."""
    engine = create_system_engine(make_database(), "lb10")

    upgrade(engine, "lb10", MIGRATIONS)

    inspector = inspect(engine)
    assert inspector.has_schema("lb10")
    assert set(inspector.get_table_names(schema="lb10")) == {
        "alembic_version",
        "case_results",
        "nightly_results",
        "quota_usage",
        "runs",
    }
    cache_key = inspector.get_pk_constraint("case_results", schema="lb10")["constrained_columns"]
    assert cache_key == ["pack", "pack_version", "prompt_hash", "alias", "case_id"]
    assert {check["name"] for check in inspector.get_check_constraints("runs", schema="lb10")} == {"runs_state"}
    assert inspector.get_table_names(schema="public") == []
    with engine.connect() as connection:
        assert connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == "0001"
    engine.dispose()


def test_the_migrations_match_the_models(lb10_migrated_engine: Engine) -> None:
    """Alembic's own comparison finds nothing to generate: the models and the migrations describe the same tables."""
    with lb10_migrated_engine.connect() as connection:
        context = MigrationContext.configure(connection, opts={"compare_type": True, "include_schemas": False})
        differences = compare_metadata(context, Base.metadata)
    assert differences == []
