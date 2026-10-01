"""Running a system's Alembic migrations on its own Postgres schema.

Each system owns its migrations (AGENTS.md, Architecture rules): LB-05's are in lb05/migrations. A
migration runs on a connection of the system's own engine, whose search_path holds only its schema
(core/databases.py), so a table it creates lands there and nowhere else, and the role that runs it
needs rights on that schema alone.

`upgrade` is what `manage.py migrate` and the integration tests call. The environment script of each
system calls `run_migrations`, which also lets Alembic's own command line work, building the engine
from the same settings the service reads.
"""

import os
from pathlib import Path
from typing import Any

from alembic import command
from alembic.config import Config
from sqlalchemy import Connection, Engine, MetaData

from config.environment import read_environment
from core.databases import create_system_engine, ensure_schema


def alembic_config(script_location: Path) -> Config:
    """Make Alembic's configuration for one system, with its migrations in `script_location`."""
    config = Config()
    config.set_main_option("script_location", str(script_location))
    return config


def upgrade(engine: Engine, schema: str, script_location: Path) -> None:
    """Bring a system's schema up to its latest migration, creating the schema first when it is missing."""
    with engine.begin() as connection:
        ensure_schema(connection, schema)
        config = alembic_config(script_location)
        config.attributes["connection"] = connection
        command.upgrade(config, "head")


def migrate_on(environment: Any, connection: Connection, metadata: MetaData) -> None:
    """Run the migrations on a connection, comparing types so a later `--autogenerate` sees them."""
    environment.configure(connection=connection, target_metadata=metadata, compare_type=True)
    with environment.begin_transaction():
        environment.run_migrations()


def run_migrations(environment: Any, metadata: MetaData, schema: str) -> None:
    """Run a system's migrations online: on the connection `upgrade` passed in, or on one made from the settings.

    `environment` is Alembic's `context`. Offline mode, which writes SQL and runs none, isn't supported.
    """
    if environment.is_offline_mode():
        raise RuntimeError("Offline migrations aren't supported: run them against the database.")
    passed = environment.config.attributes.get("connection")
    if passed is not None:
        migrate_on(environment, passed, metadata)
        return
    settings = read_environment(os.environ)
    url = (settings.lb05_database_url if schema == "lb05" else None) or settings.database_url
    engine = create_system_engine(url, schema)
    try:
        with engine.begin() as connection:
            ensure_schema(connection, schema)
            migrate_on(environment, connection, metadata)
    finally:
        engine.dispose()
