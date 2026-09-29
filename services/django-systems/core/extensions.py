"""The Postgres extensions the systems share, each installed once in the `extensions` schema.

Every system's connection searches only its own schema and `extensions`
(core/databases.py), so an extension installed anywhere else is invisible to it.
Postgres puts a new extension in `public` unless told otherwise, which is why the step
below checks where pgvector lives before relying on it.
"""

from django.db import migrations

# Stops a migration with a message that says how to fix the problem, instead of a later
# "type vector does not exist".
CHECK_PGVECTOR_SCHEMA = """
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_extension AS extension
        JOIN pg_namespace AS namespace ON namespace.oid = extension.extnamespace
        WHERE extension.extname = 'vector' AND namespace.nspname <> 'extensions'
    ) THEN
        RAISE EXCEPTION 'pgvector is installed outside the extensions schema'
            USING HINT = 'Move it with: ALTER EXTENSION vector SET SCHEMA extensions';
    END IF;
END
$$
"""

# A no-op where the platform already installed pgvector, so a system's role needs no
# right to create extensions in production.
INSTALL_PGVECTOR = "CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions"


def install_pgvector() -> migrations.RunSQL:
    """Return the migration step that makes pgvector's types available to a system.

    A system's first migration that stores vectors starts with this step. Undoing it
    does nothing, because other systems may use the extension too.
    """
    return migrations.RunSQL(sql=[CHECK_PGVECTOR_SCHEMA, INSTALL_PGVECTOR], reverse_sql=migrations.RunSQL.noop)
