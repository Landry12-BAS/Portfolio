"""The Postgres extensions the systems share, each installed once in the `extensions` schema.

Every system's connection searches only its own schema and `extensions`
(core/databases.py), so an extension installed anywhere else is invisible to it.
Postgres puts a new extension in `public` unless told otherwise (and Django's own
extension operations install into the first schema of the search path, which is the
system's), which is why each step below checks where its extension lives before
relying on it.

- pgvector gives LB-01 its `vector` type and nearest-neighbour indexes.
- btree_gist lets LB-02's exclusion constraint compare a room with `=` inside a GiST
  index, next to the time range's `&&`.
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


# The same check for btree_gist: stops a migration with a message that says how to fix
# the problem, instead of a later "data type bigint has no default operator class".
CHECK_BTREE_GIST_SCHEMA = """
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_extension AS extension
        JOIN pg_namespace AS namespace ON namespace.oid = extension.extnamespace
        WHERE extension.extname = 'btree_gist' AND namespace.nspname <> 'extensions'
    ) THEN
        RAISE EXCEPTION 'btree_gist is installed outside the extensions schema'
            USING HINT = 'Move it with: ALTER EXTENSION btree_gist SET SCHEMA extensions';
    END IF;
END
$$
"""

# A no-op where the platform already installed btree_gist. The extension is marked
# trusted, so a database owner may create it without being a superuser.
INSTALL_BTREE_GIST = "CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA extensions"


def install_btree_gist() -> migrations.RunSQL:
    """Return the migration step that makes btree_gist's operators available to a system.

    A system's first migration that adds an exclusion constraint on a scalar column
    starts with this step. Undoing it does nothing, because other systems may use the
    extension too.
    """
    return migrations.RunSQL(sql=[CHECK_BTREE_GIST_SCHEMA, INSTALL_BTREE_GIST], reverse_sql=migrations.RunSQL.noop)
