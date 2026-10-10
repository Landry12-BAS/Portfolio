"""The OpenAPI drift check: openapi.json must match the API, so the site's typed client never falls behind."""

from django.conf import settings

from core.management.commands.export_openapi import openapi_document


def test_the_committed_schema_matches_the_api() -> None:
    """A change to the API ships with its schema: run `just openapi` to regenerate it."""
    committed = (settings.BASE_DIR / "openapi.json").read_text(encoding="utf-8")

    assert committed == openapi_document(), "openapi.json is stale: run `just openapi` and commit the result"
