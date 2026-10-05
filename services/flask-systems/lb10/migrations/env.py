"""Alembic's environment for LB-10: run the migrations on a connection of the lb10 schema."""

from alembic import context

from core.migrations import run_migrations
from lb10.models import Base

run_migrations(context, Base.metadata, "lb10")
