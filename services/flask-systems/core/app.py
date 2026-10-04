"""The Flask app factory: one OpenAPI-documented app with a blueprint per system.

`create_app` takes the platform (settings, database engines, model access, spans) and the
systems to serve, builds each system's API, and wraps them all in the same protection:
trusted hosts only, a small request size limit, the security headers on every response
and JSON for every error. There is no interactive documentation page on the live service;
the OpenAPI document is served at /api/openapi.json for generating the site's typed client.
"""

import json
from collections.abc import Callable, Mapping, Sequence

from pydantic import BaseModel, RootModel

from core.errors import ErrorOut, invalid_request_response, register_error_handlers
from core.middleware import register_security_headers
from core.openapi import APIBlueprint, Info, OpenAPI, ResponseDict, SecuritySchemesDict, Tag
from core.platform import Platform
from core.registry import SystemModule

# Every request body the API accepts is a short JSON document; anything bigger is refused with 413.
MAX_REQUEST_BYTES = 8_192
API_TITLE = "LB Flask systems"
API_VERSION = "0.1.0"
API_DESCRIPTION = "The API behind the LB systems built on Flask."
# The one way a visitor proves who they are: the short-lived token the site signs for them.
SECURITY_SCHEMES: SecuritySchemesDict = {"visitor": {"type": "http", "scheme": "bearer", "bearerFormat": "JWT"}}
# Every route may refuse a malformed request, and the OpenAPI document says so in the platform's error shape.
COMMON_RESPONSES: ResponseDict = {422: ErrorOut}


class HealthOut(BaseModel):
    """The liveness answer."""

    status: str


class ReadinessOut(RootModel[dict[str, bool]]):
    """The readiness answer: for each system, whether it can serve right now."""


def health_blueprint(checks: Mapping[str, Callable[[], bool]]) -> APIBlueprint:
    """Build the routes every deployment probes: liveness, and readiness for each system's `checks`."""
    blueprint = APIBlueprint(
        "platform", __name__, url_prefix="/api", abp_tags=[Tag(name="health")], abp_responses=dict(COMMON_RESPONSES)
    )

    @blueprint.get("/healthz", responses={200: HealthOut})
    def health() -> dict[str, str]:
        """Report that the process is up. It checks nothing else, so a database blip never restarts it."""
        return {"status": "ok"}

    @blueprint.get("/readyz", responses={200: ReadinessOut, 503: ReadinessOut})
    def ready() -> tuple[dict[str, bool], int]:
        """Report whether every system can serve, for the container's readiness check."""
        readiness = {schema: check() for schema, check in checks.items()}
        return readiness, 200 if all(readiness.values()) else 503

    return blueprint


def create_app(platform: Platform, systems: Sequence[SystemModule], start_background: bool = False) -> OpenAPI:
    """Build the Flask app that serves `systems` on `platform`.

    With `start_background`, as a booting worker asks, each system that works outside requests starts that work now.
    A test's app and the one a command builds to read the OpenAPI document leave it off and start no thread.
    """
    app = OpenAPI(
        __name__,
        info=Info(title=API_TITLE, version=API_VERSION, description=API_DESCRIPTION),
        security_schemes=SECURITY_SCHEMES,
        validation_error_callback=invalid_request_response,
        validation_error_model=ErrorOut,
        doc_ui=False,
    )
    app.config["TRUSTED_HOSTS"] = list(platform.environment.allowed_hosts)
    app.config["MAX_CONTENT_LENGTH"] = MAX_REQUEST_BYTES
    register_security_headers(app)
    register_error_handlers(app)

    checks: dict[str, Callable[[], bool]] = {}
    for module in systems:
        runtime = module.build(platform)
        app.register_api(runtime.blueprint)
        checks[module.schema] = runtime.is_ready
        if start_background and runtime.start is not None:
            runtime.start()
    app.register_api(health_blueprint(checks))

    @app.get("/api/openapi.json", doc_ui=False)
    def openapi_document() -> dict[str, object]:
        """Serve the API's OpenAPI document, for generating the site's typed client."""
        return app.api_doc

    return app


def render_openapi(app: OpenAPI) -> str:
    """Render the app's OpenAPI document as the committed file stores it: sorted keys, two-space indents."""
    return json.dumps(app.api_doc, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
