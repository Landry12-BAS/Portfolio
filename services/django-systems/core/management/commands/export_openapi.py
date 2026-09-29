"""`manage.py export_openapi` (`just openapi`): write the API's OpenAPI schema to openapi.json.

The site generates its typed client from that file, and a test fails when the file
falls behind the API, so a change to the API always comes with its schema.
"""

import json

from django.conf import settings
from django.core.management.base import BaseCommand

from config.api import api


def openapi_document() -> str:
    """Render the API's OpenAPI schema as the file stores it: sorted keys, two-space indents."""
    return json.dumps(api.get_openapi_schema(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"


class Command(BaseCommand):
    """Writes openapi.json next to manage.py."""

    help = "Write the API's OpenAPI schema to openapi.json, for the site's typed client."

    def handle(self, *args: object, **options: object) -> None:
        """Write the schema, and say where."""
        path = settings.BASE_DIR / "openapi.json"
        path.write_text(openapi_document(), encoding="utf-8")
        self.stdout.write(self.style.SUCCESS(f"Wrote {path}."))
