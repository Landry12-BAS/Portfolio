"""The HTTP API of the Django systems: one Django Ninja app, with a router per system.

There is no interactive documentation page on the live service; the OpenAPI schema is
served at /api/openapi.json for generating the site's typed client.
"""

from django.db import connections
from django.http import HttpRequest
from ninja import NinjaAPI, Status

from core.databases import SYSTEM_SCHEMAS

api = NinjaAPI(
    title="LB Django systems",
    version="0.1.0",
    description="The API behind the LB systems built on Django.",
    docs_url=None,
    openapi_url="/openapi.json",
)


@api.get("/healthz", tags=["health"])
def health(request: HttpRequest) -> dict[str, str]:  # noqa: ARG001 - Ninja passes the request by this name
    """Report that the process is up. It checks nothing else, so a database blip never restarts it."""
    return {"status": "ok"}


@api.get("/readyz", tags=["health"], response={200: dict[str, bool], 503: dict[str, bool]})
def ready(request: HttpRequest) -> Status[dict[str, bool]]:  # noqa: ARG001 - as above
    """Report whether every system can reach its schema, for the container's readiness check."""
    reachable = {system: can_query(system) for system in SYSTEM_SCHEMAS}
    return Status(200 if all(reachable.values()) else 503, reachable)


def can_query(alias: str) -> bool:
    """Tell whether a system's connection answers a trivial query."""
    try:
        with connections[alias].cursor() as cursor:
            cursor.execute("SELECT 1")
            row: tuple[object, ...] | None = cursor.fetchone()
            return row == (1,)
    except Exception:  # noqa: BLE001 - any failure means "not ready"; readiness must not raise
        return False
