"""Alembic's environment for LB-05: run the migrations on a connection of the lb05 schema."""

from alembic import context

from core.migrations import run_migrations
from lb05.models import Base

run_migrations(context, Base.metadata, "lb05")
