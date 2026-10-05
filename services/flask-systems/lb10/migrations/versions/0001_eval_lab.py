"""Create Eval Lab's tables: the quota ledger, the result cache, the runs and the nightly results.

Revision ID: 0001
Revises:
Create Date: 2026-10-03
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create the four tables LB-10 keeps in Postgres."""
    op.create_table(
        "quota_usage",
        sa.Column("session_key", sa.String(length=128), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("used", sa.Integer(), server_default="0", nullable=False),
        sa.Column("busy_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("refunds", sa.Integer(), server_default="0", nullable=False),
        sa.CheckConstraint("used >= 0 AND used <= 1000", name="quota_usage_used_range"),
        sa.CheckConstraint("refunds >= 0 AND refunds <= 1000", name="quota_usage_refunds_range"),
        sa.PrimaryKeyConstraint("session_key", "day"),
    )
    op.create_table(
        "case_results",
        sa.Column("pack", sa.String(length=80), nullable=False),
        sa.Column("pack_version", sa.String(length=16), nullable=False),
        sa.Column("prompt_hash", sa.String(length=64), nullable=False),
        sa.Column("alias", sa.String(length=40), nullable=False),
        sa.Column("case_id", sa.String(length=80), nullable=False),
        sa.Column("output", sa.Text(), server_default="", nullable=False),
        sa.Column("passed", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("grades", postgresql.JSONB(), server_default="[]", nullable=False),
        sa.Column("model", sa.String(length=120), server_default="", nullable=False),
        sa.Column("input_tokens", sa.Integer(), server_default="0", nullable=False),
        sa.Column("output_tokens", sa.Integer(), server_default="0", nullable=False),
        sa.Column("latency_ms", sa.Integer(), server_default="0", nullable=False),
        sa.Column("error", sa.String(length=40), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("pack", "pack_version", "prompt_hash", "alias", "case_id"),
    )
    op.create_table(
        "runs",
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("session_key", sa.String(length=128), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("pack", sa.String(length=80), nullable=False),
        sa.Column("pack_version", sa.String(length=16), nullable=False),
        sa.Column("prompt_hash", sa.String(length=64), nullable=False),
        sa.Column("providers", postgresql.JSONB(), server_default="[]", nullable=False),
        sa.Column("state", sa.String(length=16), server_default="running", nullable=False),
        sa.Column("calls_done", sa.Integer(), server_default="0", nullable=False),
        sa.Column("calls_total", sa.Integer(), server_default="0", nullable=False),
        sa.Column("cached_calls", sa.Integer(), server_default="0", nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failure", sa.String(length=40), nullable=True),
        sa.Column("report", postgresql.JSONB(), nullable=True),
        sa.CheckConstraint("state IN ('running', 'done', 'failed')", name="runs_state"),
        sa.PrimaryKeyConstraint("run_id"),
    )
    op.create_index("runs_session_day", "runs", ["session_key", "day"])
    op.create_table(
        "nightly_results",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("run_on", sa.Date(), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("pack", sa.String(length=80), nullable=False),
        sa.Column("pack_version", sa.String(length=16), nullable=False),
        sa.Column("alias", sa.String(length=40), nullable=False),
        sa.Column("report", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("kind IN ('eval', 'judge')", name="nightly_results_kind"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("nightly_results_pack_day", "nightly_results", ["pack", "run_on"])


def downgrade() -> None:
    """Drop the four tables."""
    op.drop_index("nightly_results_pack_day", table_name="nightly_results")
    op.drop_table("nightly_results")
    op.drop_index("runs_session_day", table_name="runs")
    op.drop_table("runs")
    op.drop_table("case_results")
    op.drop_table("quota_usage")
