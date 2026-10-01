"""The HTTP API of the Django systems: one Django Ninja app, with a router per system.

There is no interactive documentation page on the live service; the OpenAPI schema is
served at /api/openapi.json for generating the site's typed client.
"""

from django.db import connections
from django.http import HttpRequest, HttpResponse
from ninja import NinjaAPI, Status
from ninja.errors import AuthenticationError, ValidationError

from core.databases import SYSTEM_SCHEMAS
from core.views import error_body
from lb01.api import router as lb01_router
from lb02.api import router as lb02_router

api = NinjaAPI(
    title="LB Django systems",
    version="0.1.0",
    description="The API behind the LB systems built on Django.",
    docs_url=None,
    openapi_url="/openapi.json",
)
api.add_router("/lb01/", lb01_router)
api.add_router("/lb02/", lb02_router)


@api.exception_handler(AuthenticationError)
def unauthorized(request: HttpRequest, exception: AuthenticationError) -> HttpResponse:  # noqa: ARG001 - Ninja's signature
    """Answer a missing or invalid visitor token in the platform's error shape."""
    body = error_body("unauthorized", "This route needs a valid visitor token for its system.")
    return api.create_response(request, body, status=401)


@api.exception_handler(ValidationError)
def invalid_request(request: HttpRequest, exception: ValidationError) -> HttpResponse:
    """Answer a malformed request in the platform's error shape, naming the fields but never echoing their values."""
    fields = sorted({".".join(str(part) for part in issue["loc"]) for issue in exception.errors})
    body = error_body("invalid_request", "The request doesn't have the expected form.")
    body["error"]["fields"] = ", ".join(fields)
    return api.create_response(request, body, status=422)


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
