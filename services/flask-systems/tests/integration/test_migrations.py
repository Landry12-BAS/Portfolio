"""Tests for LB-05's Alembic migrations (lb05/migrations) on a real Postgres, from an empty database.

Each test makes a database of its own, so each one really starts from nothing: that is what a first deploy is.
"""

from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import pytest
from alembic.autogenerate import compare_metadata
from alembic.command import upgrade as alembic_upgrade
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import Engine, insert, inspect, select, text

from config.systems import SYSTEMS
from core.cli import SERVICE_DIRECTORY, main
from core.databases import create_system_engine
from core.migrations import upgrade
from lb05.models import Base, QuotaUsage
from lb05.module import MIGRATIONS
from tests.support import VALID_ENVIRONMENT

pytestmark = pytest.mark.integration

QUOTA_COLUMNS = {"session_key", "day", "used", "busy_until"}


def fresh_engine(make_database: Callable[[], str]) -> Engine:
    """Connect to a new, empty database as LB-05 does, with its search_path on its own schema."""
    return create_system_engine(make_database(), "lb05")


def test_upgrading_an_empty_database_builds_the_schema_and_the_quota_table(
    make_database: Callable[[], str],
) -> None:
    """The first deploy: the schema, the table, its key and its range check, and the version mark, all in lb05."""
    engine = fresh_engine(make_database)

    upgrade(engine, "lb05", MIGRATIONS)

    inspector = inspect(engine)
    assert inspector.has_schema("lb05")
    assert {column["name"] for column in inspector.get_columns("quota_usage", schema="lb05")} == QUOTA_COLUMNS
    assert inspector.get_pk_constraint("quota_usage", schema="lb05")["constrained_columns"] == ["session_key", "day"]
    checks = inspector.get_check_constraints("quota_usage", schema="lb05")
    assert [check["name"] for check in checks] == ["quota_usage_used_range"]
    assert "alembic_version" in inspector.get_table_names(schema="lb05")
    with engine.connect() as connection:
        assert connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == "0001"
    engine.dispose()


def test_nothing_of_lb_05_lands_outside_its_own_schema(make_database: Callable[[], str]) -> None:
    """The migration runs on the system's own search_path, so no table of it is made in public."""
    engine = fresh_engine(make_database)

    upgrade(engine, "lb05", MIGRATIONS)

    public = inspect(engine).get_table_names(schema="public")
    assert "quota_usage" not in public
    assert "alembic_version" not in public
    engine.dispose()


def test_upgrading_again_changes_nothing(make_database: Callable[[], str]) -> None:
    """A deploy that migrates on every start finds nothing to do the second time and keeps the data."""
    engine = fresh_engine(make_database)
    upgrade(engine, "lb05", MIGRATIONS)
    with engine.begin() as connection:
        connection.execute(
            insert(QuotaUsage).values(session_key="a" * 64, day=datetime(2026, 10, 1, tzinfo=UTC).date(), used=7)
        )

    upgrade(engine, "lb05", MIGRATIONS)

    with engine.connect() as connection:
        assert connection.execute(select(QuotaUsage.used)).scalar_one() == 7
    engine.dispose()


def test_the_models_and_the_migrations_describe_the_same_database(make_database: Callable[[], str]) -> None:
    """Alembic finds nothing to change when it compares the models with what the migrations built."""
    engine = fresh_engine(make_database)
    upgrade(engine, "lb05", MIGRATIONS)

    with engine.connect() as connection:
        context = MigrationContext.configure(connection, opts={"compare_type": True})
        differences = compare_metadata(context, Base.metadata)

    assert differences == []
    engine.dispose()


def test_the_migrate_command_brings_a_fresh_database_up(
    make_database: Callable[[], str], capsys: pytest.CaptureFixture[str]
) -> None:
    """`manage.py migrate`, read from the environment as in production, says what it did and leaves the table."""
    url = make_database()

    status = main(["migrate"], {**VALID_ENVIRONMENT, "LB_DATABASE_URL": url}, SYSTEMS)

    assert status == 0
    assert "Migrated lb05." in capsys.readouterr().out
    engine = create_system_engine(url, "lb05")
    assert "quota_usage" in inspect(engine).get_table_names(schema="lb05")
    engine.dispose()


def test_the_sweep_command_deletes_old_counters_through_the_real_wiring(
    make_database: Callable[[], str], capsys: pytest.CaptureFixture[str]
) -> None:
    """`manage.py sweep_lb05` opens its own engine, counts what it removed and keeps today's rows."""
    url = make_database()
    environment = {**VALID_ENVIRONMENT, "LB_DATABASE_URL": url}
    assert main(["migrate"], environment, SYSTEMS) == 0
    engine = create_system_engine(url, "lb05")
    today = datetime.now(UTC).date()
    with engine.begin() as connection:
        connection.execute(insert(QuotaUsage).values(session_key="a" * 64, day=today, used=2))
        connection.execute(insert(QuotaUsage).values(session_key="b" * 64, day=today - timedelta(days=400), used=3))
    capsys.readouterr()

    status = main(["sweep_lb05"], environment, SYSTEMS)

    assert status == 0
    assert "Removed 1 quota counters." in capsys.readouterr().out
    with engine.connect() as connection:
        assert connection.execute(select(QuotaUsage.session_key)).scalars().all() == ["a" * 64]
    engine.dispose()


def test_alembics_own_command_line_works_from_the_environment(
    make_database: Callable[[], str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """`alembic -n lb05 upgrade head` builds the engine from the same settings the service reads."""
    url = make_database()
    for name, value in {**VALID_ENVIRONMENT, "LB_DATABASE_URL": url}.items():
        monkeypatch.setenv(name, value)
    monkeypatch.chdir(SERVICE_DIRECTORY)

    alembic_upgrade(Config(str(SERVICE_DIRECTORY / "alembic.ini"), ini_section="lb05"), "head")

    engine = create_system_engine(url, "lb05")
    assert "quota_usage" in inspect(engine).get_table_names(schema="lb05")
    engine.dispose()
