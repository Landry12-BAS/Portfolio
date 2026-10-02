"""Count the questions given back to each visitor each day, so the refunds can be capped.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-02
"""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add the refund counter, zero for every row that already exists, and keep it in range."""
    op.add_column("quota_usage", sa.Column("refunds", sa.Integer(), server_default="0", nullable=False))
    op.create_check_constraint("quota_usage_refunds_range", "quota_usage", "refunds >= 0 AND refunds <= 1000")


def downgrade() -> None:
    """Drop the refund counter."""
    op.drop_constraint("quota_usage_refunds_range", "quota_usage", type_="check")
    op.drop_column("quota_usage", "refunds")
