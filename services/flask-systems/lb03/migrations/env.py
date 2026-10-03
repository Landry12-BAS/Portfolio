"""Alembic's environment for LB-03: run the migrations on a connection of the lb03 schema."""

from alembic import context

from core.migrations import run_migrations
from lb03.models import Base

run_migrations(context, Base.metadata, "lb03")
