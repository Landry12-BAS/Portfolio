"""The core app's configuration: it ties schema creation to Django's migrations."""

from django.apps import AppConfig
from django.db.models.signals import pre_migrate

from core.databases import ensure_schemas


class CoreConfig(AppConfig):
    """The shared plumbing of the Django systems."""

    name = "core"
    verbose_name = "Shared plumbing"

    def ready(self) -> None:
        """Create each system's schema before its first migration (see core.databases)."""
        pre_migrate.connect(ensure_schemas, dispatch_uid="core.ensure_schemas")
