"""Tests for what every HTTP answer carries: JSON bodies, and the security headers from docs/SECURITY.md."""

import pytest
from django.test import Client, RequestFactory

from core.middleware import SECURITY_HEADERS
from core.views import server_error


def test_health_answers_without_the_database(client: Client) -> None:
    """The liveness check touches nothing, so a database blip never restarts the service."""
    response = client.get("/api/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.parametrize("path", ["/api/healthz", "/api/openapi.json", "/nowhere"])
def test_every_answer_carries_the_security_headers(client: Client, path: str) -> None:
    """Found or not, every answer is uncacheable, unframeable and allows no content."""
    response = client.get(path)

    for name, value in SECURITY_HEADERS.items():
        assert response[name] == value
    assert response["X-Frame-Options"] == "DENY"
    assert response["X-Content-Type-Options"] == "nosniff"


def test_an_unknown_path_gets_a_json_404_that_doesnt_repeat_it(client: Client) -> None:
    """The 404 is JSON in the platform's error shape, and never echoes what was asked for."""
    response = client.get("/api/nowhere/<script>")

    assert response.status_code == 404
    assert response["Content-Type"] == "application/json"
    assert response.json() == {"error": {"code": "not_found", "message": "There is nothing at this address."}}
    assert b"script" not in response.content


def test_a_server_error_reveals_nothing() -> None:
    """An unexpected failure answers a generic JSON 500."""
    response = server_error(RequestFactory().get("/api/anything"))

    assert response.status_code == 500
    assert response["Content-Type"] == "application/json"
    assert b'"internal_error"' in response.content


def test_readiness_fails_when_a_system_cant_reach_its_schema(client: Client, monkeypatch: pytest.MonkeyPatch) -> None:
    """The readiness check answers 503 and names the system that can't query."""
    monkeypatch.setattr("config.api.can_query", lambda _alias: False)

    response = client.get("/api/readyz")

    assert response.status_code == 503
    assert response.json() == {"lb01": False, "lb02": False}


def test_serves_the_openapi_schema_but_no_documentation_page(client: Client) -> None:
    """The schema feeds the site's typed client; the live service has no interactive page."""
    schema = client.get("/api/openapi.json")

    assert schema.status_code == 200
    assert "/api/healthz" in schema.json()["paths"]
    assert client.get("/api/docs").status_code == 404
