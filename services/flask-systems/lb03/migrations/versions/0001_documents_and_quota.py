"""Create the documents of the hour and the daily count of them.

Revision ID: 0001
Revises:
Create Date: 2026-10-02
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create the documents table, with its indexes, and the quota ledger."""
    op.create_table(
        "documents",
        sa.Column("id", sa.String(length=22), nullable=False),
        sa.Column("session_key", sa.String(length=128), nullable=False),
        sa.Column("state", sa.String(length=10), nullable=False),
        sa.Column("failure_code", sa.String(length=24), nullable=True),
        sa.Column("label", sa.String(length=80), nullable=False),
        sa.Column("kind", sa.String(length=5), nullable=False),
        sa.Column("byte_size", sa.Integer(), nullable=False),
        sa.Column("file_sha256", sa.String(length=64), nullable=False),
        sa.Column("page_count", sa.SmallInteger(), nullable=True),
        sa.Column("admitted_on", sa.Date(), nullable=False),
        sa.Column("extraction", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("placements", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("checks", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("journal", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "steps", postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'[]'::jsonb"), nullable=False
        ),
        sa.Column(
            "corrections",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("identity_vendor", sa.String(length=160), nullable=True),
        sa.Column("identity_number", sa.String(length=80), nullable=True),
        sa.Column("content_hash", sa.String(length=64), nullable=True),
        sa.Column("duplicate_of", sa.String(length=80), nullable=True),
        sa.Column("duplicate_same_content", sa.Boolean(), nullable=True),
        sa.Column("text_cut", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("model", sa.String(length=80), nullable=True),
        sa.Column("model_calls", sa.SmallInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=True),
        sa.Column("ocr_ms", sa.Integer(), nullable=True),
        sa.Column("elapsed_ms", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "state IN ('uploaded','ocr','extract','validate','repair','ready','failed')", name="documents_state"
        ),
        sa.CheckConstraint("kind IN ('pdf','png','jpeg','webp')", name="documents_kind"),
        sa.CheckConstraint("(state = 'failed') = (failure_code IS NOT NULL)", name="documents_failure_code"),
        sa.CheckConstraint("byte_size >= 0 AND model_calls >= 0 AND model_calls <= 20", name="documents_counts"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("documents_session_created", "documents", ["session_key", "created_at"])
    op.create_index("documents_expires", "documents", ["expires_at"])
    op.create_index("documents_identity", "documents", ["session_key", "identity_vendor", "identity_number"])
    op.create_table(
        "quota_usage",
        sa.Column("session_key", sa.String(length=128), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("used", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("active", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("refunds", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.CheckConstraint("used >= 0 AND used <= 1000", name="quota_usage_used_range"),
        sa.CheckConstraint("active >= 0 AND active <= 20", name="quota_usage_active_range"),
        sa.CheckConstraint("refunds >= 0 AND refunds <= 1000", name="quota_usage_refunds_range"),
        sa.PrimaryKeyConstraint("session_key", "day"),
    )


def downgrade() -> None:
    """Drop both tables."""
    op.drop_table("quota_usage")
    op.drop_index("documents_identity", table_name="documents")
    op.drop_index("documents_expires", table_name="documents")
    op.drop_index("documents_session_created", table_name="documents")
    op.drop_table("documents")
