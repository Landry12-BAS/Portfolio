"""Create the quota ledger: one counter per visitor per day.

Revision ID: 0001
Revises:
Create Date: 2026-10-01
"""

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create the table that counts each visitor's questions for each day."""
    op.create_table(
        "quota_usage",
        sa.Column("session_key", sa.String(length=128), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("used", sa.Integer(), server_default="0", nullable=False),
        sa.Column("busy_until", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("used >= 0 AND used <= 1000", name="quota_usage_used_range"),
        sa.PrimaryKeyConstraint("session_key", "day"),
    )


def downgrade() -> None:
    """Drop the quota ledger."""
    op.drop_table("quota_usage")
