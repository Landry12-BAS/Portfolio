"""LB-03's tables in its own Postgres schema, `lb03`: the documents of the hour, and the daily count of them.

A visitor has no account: they are the hash of their session (the subject of their token), never a name or an
address. A document row holds what was read from their file (the extracted fields, the boxes, the checks, the
journal entry) and is deleted an hour after the upload with its files; nothing of it outlives the hour. The
original file and its page pictures are in the file store, not here.

The tables carry no schema name: every connection of this system has a search_path of `lb03` only
(core/databases.py), so they are created and read there, and the models work unchanged on a role that is
granted nothing else.
"""

from datetime import date, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Index,
    Integer,
    SmallInteger,
    String,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# LB-03's Alembic migrations: the folder `manage.py migrate` runs on the lb03 schema.
MIGRATIONS = Path(__file__).resolve().parent / "migrations"
# The most a counter may hold, which a CHECK constraint keeps even if a bug tried to pass it.
MAX_COUNTER = 1_000
STATES = ("uploaded", "ocr", "extract", "validate", "repair", "ready", "failed")
KINDS = ("pdf", "png", "jpeg", "webp")


class Base(DeclarativeBase):
    """The base of LB-03's tables; its metadata is what the migrations are checked against."""


class Document(Base):
    """One uploaded document: its state, what was read from it so far, and the hour it lives for.

    `session_key` is the visitor, and every read of a document is by id *and* session key, so one visitor can
    never see another's. `identity_vendor`, `identity_number` and `content_hash` are the keys the duplicate check
    compares (lb03/duplicates.py). `admitted_on` is the day the quota counted the document, which the ledger
    needs to give the place back. JSON columns hold the checked reading; the schemas are in lb03/repository.py.
    """

    __tablename__ = "documents"
    __table_args__ = (
        CheckConstraint(
            "state IN ('uploaded','ocr','extract','validate','repair','ready','failed')", name="documents_state"
        ),
        CheckConstraint("kind IN ('pdf','png','jpeg','webp')", name="documents_kind"),
        CheckConstraint("(state = 'failed') = (failure_code IS NOT NULL)", name="documents_failure_code"),
        CheckConstraint("byte_size >= 0 AND model_calls >= 0 AND model_calls <= 20", name="documents_counts"),
        Index("documents_session_created", "session_key", "created_at"),
        Index("documents_expires", "expires_at"),
        Index("documents_identity", "session_key", "identity_vendor", "identity_number"),
    )

    id: Mapped[str] = mapped_column(String(22), primary_key=True)
    session_key: Mapped[str] = mapped_column(String(128), nullable=False)
    state: Mapped[str] = mapped_column(String(10), nullable=False)
    failure_code: Mapped[str | None] = mapped_column(String(24), nullable=True)
    label: Mapped[str] = mapped_column(String(80), nullable=False)
    kind: Mapped[str] = mapped_column(String(5), nullable=False)
    byte_size: Mapped[int] = mapped_column(Integer, nullable=False)
    file_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    page_count: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    admitted_on: Mapped[date] = mapped_column(Date, nullable=False)
    extraction: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    placements: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    checks: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONB, nullable=True)
    journal: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    steps: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    corrections: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    identity_vendor: Mapped[str | None] = mapped_column(String(160), nullable=True)
    identity_number: Mapped[str | None] = mapped_column(String(80), nullable=True)
    content_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    duplicate_of: Mapped[str | None] = mapped_column(String(80), nullable=True)
    duplicate_same_content: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    text_cut: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    model: Mapped[str | None] = mapped_column(String(80), nullable=True)
    model_calls: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default=text("0"))
    run_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    ocr_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    elapsed_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class QuotaUsage(Base):
    """How many documents one visitor has uploaded on one day, how many are being read, and how many were given back.

    `active` is the number of the visitor's documents in the pipeline right now, which the ledger caps so one
    visitor cannot hold the OCR worker; `refunds` counts the places given back today, which the ledger caps too.
    """

    __tablename__ = "quota_usage"
    __table_args__ = (
        CheckConstraint(f"used >= 0 AND used <= {MAX_COUNTER}", name="quota_usage_used_range"),
        CheckConstraint("active >= 0 AND active <= 20", name="quota_usage_active_range"),
        CheckConstraint(f"refunds >= 0 AND refunds <= {MAX_COUNTER}", name="quota_usage_refunds_range"),
    )

    session_key: Mapped[str] = mapped_column(String(128), primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    used: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    active: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    refunds: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
