"""Tests for LB-03's Alembic migrations (lb03/migrations) on a real Postgres, from an empty database.

Each test makes a database of its own, so each one really starts from nothing: that is what a first deploy is.
"""

from collections.abc import Callable
from datetime import UTC, date, datetime

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import Engine, insert, inspect, text
from sqlalchemy.exc import IntegrityError

from core.databases import create_system_engine
from core.migrations import upgrade
from lb03.models import MIGRATIONS, Base, Document

pytestmark = pytest.mark.integration

DOCUMENT_COLUMNS = {
    "id",
    "session_key",
    "state",
    "failure_code",
    "label",
    "kind",
    "byte_size",
    "file_sha256",
    "page_count",
    "admitted_on",
    "extraction",
    "placements",
    "checks",
    "journal",
    "steps",
    "corrections",
    "identity_vendor",
    "identity_number",
    "content_hash",
    "duplicate_of",
    "duplicate_same_content",
    "text_cut",
    "model",
    "model_calls",
    "run_id",
    "ocr_ms",
    "elapsed_ms",
    "created_at",
    "updated_at",
    "expires_at",
}
NOW = datetime(2026, 10, 1, 9, 30, tzinfo=UTC)


def fresh_engine(make_database: Callable[[], str]) -> Engine:
    """Connect to a new, empty database as LB-03 does, with its search_path on its own schema."""
    return create_system_engine(make_database(), "lb03")


def insert_document(engine: Engine, **overrides: object) -> None:
    """Insert a document row straight into the table, with whatever the test wants to be different."""
    values: dict[str, object] = {
        "id": "a" * 22,
        "session_key": "session-of-sam-visitor-0001",
        "state": "uploaded",
        "label": "invoice.pdf",
        "kind": "pdf",
        "byte_size": 1000,
        "file_sha256": "0" * 64,
        "admitted_on": date(2026, 10, 1),
        "created_at": NOW,
        "updated_at": NOW,
        "expires_at": NOW,
        **overrides,
    }
    with engine.begin() as connection:
        connection.execute(insert(Document).values(**values))


def test_upgrading_an_empty_database_builds_the_schema_the_tables_and_their_indexes(
    make_database: Callable[[], str],
) -> None:
    """The first deploy: the schema, both tables with their keys and indexes, and the version mark, all in lb03."""
    engine = fresh_engine(make_database)

    upgrade(engine, "lb03", MIGRATIONS)

    inspector = inspect(engine)
    assert inspector.has_schema("lb03")
    assert {column["name"] for column in inspector.get_columns("documents", schema="lb03")} == DOCUMENT_COLUMNS
    assert inspector.get_pk_constraint("documents", schema="lb03")["constrained_columns"] == ["id"]
    indexes = {index["name"] for index in inspector.get_indexes("documents", schema="lb03")}
    assert indexes == {"documents_session_created", "documents_expires", "documents_identity"}
    assert inspector.get_pk_constraint("quota_usage", schema="lb03")["constrained_columns"] == ["session_key", "day"]
    assert "alembic_version" in inspector.get_table_names(schema="lb03")
    with engine.connect() as connection:
        assert connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == "0001"
    engine.dispose()


def test_nothing_of_lb_03_lands_outside_its_own_schema(make_database: Callable[[], str]) -> None:
    """The migration runs on the system's own search_path, so no table of it is made in public."""
    engine = fresh_engine(make_database)

    upgrade(engine, "lb03", MIGRATIONS)

    public = inspect(engine).get_table_names(schema="public")
    assert not {"documents", "quota_usage", "alembic_version"} & set(public)
    engine.dispose()


def test_upgrading_again_changes_nothing(make_database: Callable[[], str]) -> None:
    """A deploy that migrates on every start finds nothing to do the second time and keeps the data."""
    engine = fresh_engine(make_database)
    upgrade(engine, "lb03", MIGRATIONS)
    insert_document(engine)

    upgrade(engine, "lb03", MIGRATIONS)

    with engine.connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM documents")).scalar_one() == 1
    engine.dispose()


def test_the_models_and_the_migrations_describe_the_same_database(make_database: Callable[[], str]) -> None:
    """Alembic finds nothing to change when it compares the models with what the migration built."""
    engine = fresh_engine(make_database)
    upgrade(engine, "lb03", MIGRATIONS)

    with engine.connect() as connection:
        context = MigrationContext.configure(connection, opts={"compare_type": True})
        differences = compare_metadata(context, Base.metadata)

    assert differences == []
    engine.dispose()


def test_the_database_itself_refuses_a_document_with_a_state_that_does_not_exist(
    make_database: Callable[[], str],
) -> None:
    """The state vocabulary is a constraint, so a bug that wrote another word could not store it."""
    engine = fresh_engine(make_database)
    upgrade(engine, "lb03", MIGRATIONS)

    with pytest.raises(IntegrityError, match="documents_state"):
        insert_document(engine, state="thinking")
    engine.dispose()


def test_the_database_keeps_a_failure_code_and_the_failed_state_together(make_database: Callable[[], str]) -> None:
    """A failed document has its code, and no other document has one: the board always has a reason to show."""
    engine = fresh_engine(make_database)
    upgrade(engine, "lb03", MIGRATIONS)

    with pytest.raises(IntegrityError, match="documents_failure_code"):
        insert_document(engine, state="failed")
    with pytest.raises(IntegrityError, match="documents_failure_code"):
        insert_document(engine, state="ready", failure_code="no_text")
    insert_document(engine, state="failed", failure_code="no_text")
    engine.dispose()


def test_the_database_refuses_a_file_kind_the_service_does_not_read(make_database: Callable[[], str]) -> None:
    """Only the four kinds that magic-byte sniffing can name are stored."""
    engine = fresh_engine(make_database)
    upgrade(engine, "lb03", MIGRATIONS)

    with pytest.raises(IntegrityError, match="documents_kind"):
        insert_document(engine, kind="exe")
    engine.dispose()


def test_the_counters_cannot_go_past_their_ranges(make_database: Callable[[], str]) -> None:
    """The quota table's range checks hold even against a statement that tried to break them."""
    engine = fresh_engine(make_database)
    upgrade(engine, "lb03", MIGRATIONS)

    with pytest.raises(IntegrityError, match="quota_usage_used_range"), engine.begin() as connection:
        connection.execute(text("INSERT INTO quota_usage (session_key, day, used) VALUES ('k', '2026-10-01', -1)"))
    with pytest.raises(IntegrityError, match="quota_usage_active_range"), engine.begin() as connection:
        connection.execute(text("INSERT INTO quota_usage (session_key, day, active) VALUES ('k', '2026-10-01', 21)"))
    engine.dispose()
