"""Tests for what every HTTP answer carries: JSON bodies, the security headers from docs/SECURITY.md, and trusted hosts.

A small stand-in system is served through the real app factory, so these tests show how
any system added to the monolith is protected, without depending on LB-05.
"""

import logging
from collections.abc import Callable, Iterator

import pytest
from flask import Flask
from flask.testing import FlaskClient
from pydantic import BaseModel, ConfigDict

from core.app import COMMON_RESPONSES, create_app
from core.errors import ErrorOut, describe_failure
from core.middleware import SECURITY_HEADERS
from core.openapi import APIBlueprint
from core.platform import Platform
from core.registry import SystemModule, SystemRuntime
from core.visitors import require_visitor, visitor_of_request
from tests.support import SiteKey, make_environment, make_platform

SECRET_WORDS = "words-a-visitor-wrote-that-must-not-leak"


class Echo(BaseModel):
    """A request body the stand-in system accepts."""

    model_config = ConfigDict(extra="forbid")

    text: str


class EchoOut(BaseModel):
    """The stand-in system's answer."""

    text: str


def stand_in_system(site_key: SiteKey, ready: Callable[[], bool] = lambda: True) -> SystemModule:
    """Build a stand-in system, `lb-99`, with a guarded route for each way an answer can go."""

    def build(platform: Platform) -> SystemRuntime:  # noqa: ARG001 - the registry's signature
        """Make the stand-in's blueprint, guarded by visitor tokens for lb-99."""
        blueprint = APIBlueprint(
            "lb99",
            __name__,
            url_prefix="/api/lb99",
            abp_security=[{"visitor": []}],
            abp_responses=dict(COMMON_RESPONSES),
        )
        blueprint.before_request(require_visitor("lb-99", site_key.public))

        @blueprint.get("/whoami", responses={200: EchoOut, 401: ErrorOut})
        def whoami() -> dict[str, str]:
            """Say which visitor the token vouched for."""
            return {"text": visitor_of_request().session_key}

        @blueprint.post("/echo", responses={200: EchoOut, 401: ErrorOut})
        def echo(body: Echo) -> dict[str, str]:
            """Echo the body back."""
            return {"text": body.text}

        @blueprint.get("/boom", responses={200: EchoOut})
        def boom() -> dict[str, str]:
            """Fail the way a bug does, with an exception whose message quotes a visitor."""
            raise RuntimeError(SECRET_WORDS)

        return SystemRuntime(blueprint=blueprint, is_ready=ready)

    return SystemModule(key="lb-99", schema="lb99", build=build)


@pytest.fixture
def site_key() -> SiteKey:
    """Make the site's signing key for one test."""
    return SiteKey()


@pytest.fixture
def app(site_key: SiteKey) -> Flask:
    """Serve the stand-in system through the real app factory."""
    return create_app(make_platform(), [stand_in_system(site_key)])


@pytest.fixture
def client(app: Flask) -> Iterator[FlaskClient]:
    """Return a test client for the app."""
    with app.test_client() as test_client:
        yield test_client


def test_health_answers_without_asking_any_system(client: FlaskClient) -> None:
    """The liveness check touches nothing, so a database blip never restarts the service."""
    response = client.get("/api/healthz")

    assert response.status_code == 200
    assert response.get_json() == {"status": "ok"}


def test_readiness_names_each_system_and_fails_when_one_cant_serve(site_key: SiteKey) -> None:
    """Readiness is 200 when every system is ready, and 503 naming the one that isn't."""
    ready = create_app(make_platform(), [stand_in_system(site_key)]).test_client().get("/api/readyz")
    broken = (
        create_app(make_platform(), [stand_in_system(site_key, ready=lambda: False)]).test_client().get("/api/readyz")
    )

    assert (ready.status_code, ready.get_json()) == (200, {"lb99": True})
    assert (broken.status_code, broken.get_json()) == (503, {"lb99": False})


def test_a_system_with_background_work_is_started_only_when_the_app_is_asked_to(site_key: SiteKey) -> None:
    """A booting worker starts each system's background work (its sweep); a test's or a command's app does not."""
    started: list[str] = []

    def build(platform: Platform) -> SystemRuntime:
        """Make the stand-in's runtime, with a start that notes itself."""
        runtime = stand_in_system(site_key).build(platform)
        return SystemRuntime(runtime.blueprint, runtime.is_ready, start=lambda: started.append("lb-99"))

    module = SystemModule(key="lb-99", schema="lb99", build=build)

    create_app(make_platform(), [module])
    assert started == []

    create_app(make_platform(), [module], start_background=True)
    assert started == ["lb-99"]


@pytest.mark.parametrize("path", ["/api/healthz", "/api/openapi.json", "/nowhere", "/api/lb99/whoami"])
def test_every_answer_carries_the_security_headers(client: FlaskClient, path: str) -> None:
    """Found or not, authorised or not, every answer is uncacheable, unframeable and allows no content."""
    response = client.get(path)

    for name, value in SECURITY_HEADERS.items():
        assert response.headers[name] == value


def test_the_headers_also_cover_errors_the_framework_raises(client: FlaskClient, site_key: SiteKey) -> None:
    """A 405, a 413 and a 500 are stamped like any other answer."""
    wrong_method = client.post("/api/healthz")
    too_large = client.post(
        "/api/lb99/echo", data="x" * 20_000, headers={**site_key.headers("lb-99"), "Content-Type": "application/json"}
    )
    failed = client.get("/api/lb99/boom", headers=site_key.headers("lb-99"))

    assert (wrong_method.status_code, too_large.status_code, failed.status_code) == (405, 413, 500)
    for response in (wrong_method, too_large, failed):
        assert response.headers["Cache-Control"] == "no-store"
        assert response.headers["X-Frame-Options"] == "DENY"


def test_an_unknown_path_gets_a_json_404_that_doesnt_repeat_it(client: FlaskClient) -> None:
    """The 404 is JSON in the platform's error shape, and never echoes what was asked for."""
    response = client.get("/api/nowhere/<script>")

    assert response.status_code == 404
    assert response.mimetype == "application/json"
    assert response.get_json() == {"error": {"code": "not_found", "message": "There is nothing at this address."}}
    assert b"script" not in response.data


def test_a_wrong_method_says_what_is_allowed_without_echoing_anything(client: FlaskClient) -> None:
    """A 405 is JSON, and keeps the Allow header clients rely on."""
    response = client.post("/api/healthz")

    assert response.status_code == 405
    assert response.get_json()["error"]["code"] == "method_not_allowed"
    assert "GET" in response.headers["Allow"]


def test_a_server_error_reveals_nothing_and_logs_no_message(
    client: FlaskClient, site_key: SiteKey, caplog: pytest.LogCaptureFixture
) -> None:
    """An unexpected failure answers a generic 500; the log has its type and place, never its message."""
    with caplog.at_level(logging.ERROR):
        response = client.get("/api/lb99/boom", headers=site_key.headers("lb-99"))

    assert response.status_code == 500
    assert response.get_json() == {"error": {"code": "internal_error", "message": "The service hit an internal error."}}
    assert SECRET_WORDS.encode() not in response.data
    assert "RuntimeError" in caplog.text
    assert SECRET_WORDS not in caplog.text


def test_describe_failure_names_the_type_and_the_place_but_not_the_message() -> None:
    """The one line logged for a failure is enough to find it, and quotes nothing."""
    try:
        raise ValueError(SECRET_WORDS)
    except ValueError as error:
        described = describe_failure(error)

    assert described.startswith("ValueError at ")
    assert "test_http.py" in described
    assert SECRET_WORDS not in described
    assert describe_failure(ValueError("never raised")) == "ValueError"


def test_every_route_of_a_system_needs_a_visitor_token_for_it(client: FlaskClient, site_key: SiteKey) -> None:
    """No token, a token for another system, and a garbled one all get a 401 in the platform's error shape."""
    attempts = [{}, site_key.headers("lb-98"), {"Authorization": "Bearer not.a.token"}, {"Authorization": "Basic abc"}]

    for headers in attempts:
        response = client.get("/api/lb99/whoami", headers=headers)

        assert response.status_code == 401
        assert response.get_json()["error"]["code"] == "unauthorized"


def test_a_valid_token_names_the_visitor_by_their_session_hash(client: FlaskClient, site_key: SiteKey) -> None:
    """The visitor is known only by the subject of their token."""
    response = client.get("/api/lb99/whoami", headers=site_key.headers("lb-99", session="session-hash-0123456789abc"))

    assert response.get_json() == {"text": "session-hash-0123456789abc"}


def test_authentication_comes_before_validation(client: FlaskClient) -> None:
    """A caller without a token learns nothing about the request's expected shape."""
    response = client.post("/api/lb99/echo", json={"nonsense": True})

    assert response.status_code == 401


def test_a_malformed_body_gets_a_422_naming_fields_but_never_their_values(
    client: FlaskClient, site_key: SiteKey
) -> None:
    """The 422 lists the fields at fault, and doesn't echo what was sent."""
    response = client.post("/api/lb99/echo", json={"text": 5, "extra": SECRET_WORDS}, headers=site_key.headers("lb-99"))

    assert response.status_code == 422
    error = response.get_json()["error"]
    assert error["code"] == "invalid_request"
    assert error["fields"] == "extra, text"
    assert SECRET_WORDS.encode() not in response.data


def test_a_body_that_isnt_json_is_refused_like_any_malformed_one(client: FlaskClient, site_key: SiteKey) -> None:
    """Plain text, however it is labelled, fails closed with a 422."""
    response = client.post("/api/lb99/echo", data="text=hello", headers=site_key.headers("lb-99"))

    assert response.status_code == 422


def test_a_host_the_service_doesnt_answer_to_gets_a_400(client: FlaskClient) -> None:
    """Requests for any other Host header are refused, with the same headers and shape."""
    response = client.get("/api/healthz", headers={"Host": "evil.example"})

    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "bad_request"
    assert response.headers["Cache-Control"] == "no-store"


def test_serves_the_openapi_document_but_no_documentation_page(client: FlaskClient) -> None:
    """The document feeds the site's typed client; the live service has no interactive page."""
    document = client.get("/api/openapi.json")

    assert document.status_code == 200
    assert "/api/healthz" in document.get_json()["paths"]
    assert document.get_json()["openapi"].startswith("3.1")
    for path in ("/openapi", "/openapi/openapi.json", "/api/docs"):
        assert client.get(path).status_code == 404


def test_the_hosts_come_from_the_environment(site_key: SiteKey) -> None:
    """Whatever FLASK_ALLOWED_HOSTS lists is what the app answers to."""
    environment = make_environment(FLASK_ALLOWED_HOSTS="api.example.test")
    app = create_app(make_platform(environment=environment), [stand_in_system(site_key)])

    allowed = app.test_client().get("/api/healthz", headers={"Host": "api.example.test"})
    refused = app.test_client().get("/api/healthz", headers={"Host": "localhost"})

    assert (allowed.status_code, refused.status_code) == (200, 400)
