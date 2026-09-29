"""One Postgres database, one schema per system (AGENTS.md, Architecture rules).

Each system's app talks to the database through a connection of its own, whose
search_path holds only that system's schema and the shared `extensions` schema, where
pgvector's types live. The router keeps every model on its system's connection and
refuses relations between systems, so no system reaches another's tables through the
ORM. In production each connection also logs in as a role granted only its schema.
"""

from collections.abc import Mapping
from urllib.parse import parse_qsl, unquote, urlsplit

from django.db import connections
from django.db.models import Model
from psycopg import sql

# The systems with data of their own. A system's app label, database alias and schema
# all share its part-number name.
SYSTEM_SCHEMAS: tuple[str, ...] = ("lb01",)
# Where database extensions such as pgvector live, readable by every system.
EXTENSIONS_SCHEMA = "extensions"
# The only URL parameters passed on to Postgres.
ALLOWED_URL_OPTIONS = frozenset({"sslmode", "connect_timeout"})


def database_from_url(url: str, schema: str) -> dict[str, object]:
    """Build one Django database entry from a postgres:// URL, working inside `schema`.

    Each system tests against a database of its own (`test_<name>_<schema>`), so that
    Django migrates every one of them; in production they all share one database.
    """
    parts = urlsplit(url)
    if parts.scheme not in ("postgres", "postgresql"):
        raise ValueError("The database URL must start with postgres:// or postgresql://.")
    name = unquote(parts.path.removeprefix("/"))
    if not parts.hostname or not name:
        raise ValueError("The database URL needs a host and a database name.")
    options: dict[str, str] = {"options": f"-c search_path={schema},{EXTENSIONS_SCHEMA}"}
    for key, value in parse_qsl(parts.query):
        if key not in ALLOWED_URL_OPTIONS:
            raise ValueError(f"The database URL option {key!r} isn't supported.")
        options[key] = value
    return {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": name,
        "USER": unquote(parts.username or ""),
        "PASSWORD": unquote(parts.password or ""),
        "HOST": parts.hostname,
        "PORT": str(parts.port or 5432),
        "CONN_MAX_AGE": 60,
        "CONN_HEALTH_CHECKS": True,
        "OPTIONS": options,
        # Django makes every other test database wait for `default`'s by default; here
        # `default` is a placeholder that is never created, so nothing waits on it.
        "TEST": {"NAME": f"test_{name}_{schema}", "DEPENDENCIES": []},
    }


def system_databases(shared_url: str, own_urls: Mapping[str, str | None]) -> dict[str, dict[str, object]]:
    """Return one database entry per system: from its own URL when it has one, else from the shared one."""
    return {system: database_from_url(own_urls.get(system) or shared_url, schema=system) for system in SYSTEM_SCHEMAS}


def system_of(app_label: str) -> str | None:
    """Return the system an app belongs to (its database alias), or None for shared apps."""
    return app_label if app_label in SYSTEM_SCHEMAS else None


class SystemSchemaRouter:
    """Routes each system's models to its own connection, and keeps the systems apart."""

    def db_for_read(self, model: type[Model], **hints: object) -> str | None:
        """Read a system's models through that system's connection."""
        return system_of(model._meta.app_label)

    def db_for_write(self, model: type[Model], **hints: object) -> str | None:
        """Write a system's models through that system's connection."""
        return system_of(model._meta.app_label)

    def allow_relation(self, first: Model, second: Model, **hints: object) -> bool:
        """Allow a relation only between models of the same system."""
        return system_of(first._meta.app_label) == system_of(second._meta.app_label)

    def allow_migrate(self, db: str, app_label: str, **hints: object) -> bool:
        """Migrate a system's models on its own connection only, and no shared app on a system's.

        Django also passes the model's name among the hints; the app label alone decides.
        """
        system = system_of(app_label)
        if system is not None:
            return db == system
        return db not in SYSTEM_SCHEMAS


def ensure_schemas(using: str, **kwargs: object) -> None:
    """Create a system's schema, and the extensions schema, before its first migration.

    Runs on Django's pre_migrate signal, which also passes the app being migrated among
    the other arguments. It checks before creating: in production the schemas already
    exist, and a system's role has no right to create one.
    """
    if using not in SYSTEM_SCHEMAS:
        return
    with connections[using].cursor() as cursor:
        for schema in (EXTENSIONS_SCHEMA, using):
            cursor.execute("SELECT 1 FROM pg_namespace WHERE nspname = %s", [schema])
            if cursor.fetchone() is None:
                cursor.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
