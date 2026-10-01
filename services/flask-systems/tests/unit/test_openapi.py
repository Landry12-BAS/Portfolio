"""Tests for the committed OpenAPI document (openapi.json): it is current, and it says what the API enforces.

The site's typed client is generated from this file, so a change to the API that isn't written into it would leave
the client wrong without anything failing. The drift test closes that gap, and the others read the document the way
the client's generator does: which routes need a token, what a question may hold, and which values come back.
"""

import json
from pathlib import Path
from typing import Any

import pytest

from config.systems import SYSTEMS
from core.app import create_app, render_openapi
from core.cli import OPENAPI_FILE, SERVICE_DIRECTORY
from lb05.api import MIN_QUESTION_CHARS
from lb05.pipeline import Outcome
from lb05.prompts import MAX_QUESTION_CHARS
from lb05.safety import Layer, Rule
from tests.support import make_environment, make_platform


@pytest.fixture(scope="module")
def current(tmp_path_factory: pytest.TempPathFactory) -> str:
    """Render the document the code makes now, on a platform with no data, which the document doesn't depend on."""
    empty = tmp_path_factory.mktemp("no-data")
    platform = make_platform(environment=make_environment(LB05_WAREHOUSE_DIR=str(empty)))
    return render_openapi(create_app(platform, SYSTEMS))


@pytest.fixture(scope="module")
def document(current: str) -> dict[str, Any]:
    """Read the current document as data."""
    loaded: dict[str, Any] = json.loads(current)
    return loaded


def test_the_committed_openapi_file_is_current(current: str) -> None:
    """The file in the repository is what the code generates: if not, run `just openapi-flask` and commit it."""
    committed = (SERVICE_DIRECTORY / OPENAPI_FILE).read_text(encoding="utf-8")

    if committed != current:
        pytest.fail("services/flask-systems/openapi.json is stale: run `just openapi-flask` and commit the result.")


def test_it_is_an_openapi_3_1_document_with_a_visitor_scheme(document: dict[str, Any]) -> None:
    """The visitor's bearer token is the one security scheme, as the site signs it."""
    assert document["openapi"].startswith("3.1")
    assert document["components"]["securitySchemes"] == {
        "visitor": {"type": "http", "scheme": "bearer", "bearerFormat": "JWT"}
    }


def test_every_lb_05_route_needs_a_visitor_token_and_the_probes_need_none(document: dict[str, Any]) -> None:
    """Each of LB-05's operations says it needs the token, and can answer 401; the health probes are open."""
    lb05 = {path: item for path, item in document["paths"].items() if path.startswith("/api/lb05/")}

    assert sorted(lb05) == ["/api/lb05/ask", "/api/lb05/quota", "/api/lb05/semantic-layer"]
    for item in lb05.values():
        for operation in item.values():
            assert operation["security"] == [{"visitor": []}]
            assert "401" in operation["responses"]
    for probe in ("/api/healthz", "/api/readyz"):
        assert all("security" not in operation for operation in document["paths"][probe].values())


def test_a_question_is_documented_with_the_limits_the_api_enforces(document: dict[str, Any]) -> None:
    """The body takes one field and nothing else, between the lengths the code checks; each way it can end is listed."""
    schemas = document["components"]["schemas"]
    ask = document["paths"]["/api/lb05/ask"]["post"]

    assert schemas["AskIn"]["additionalProperties"] is False
    assert schemas["AskIn"]["required"] == ["question"]
    assert (schemas["Question"]["minLength"], schemas["Question"]["maxLength"]) == (
        MIN_QUESTION_CHARS,
        MAX_QUESTION_CHARS,
    )
    assert sorted(ask["responses"]) == ["200", "401", "422", "429", "503"]


def test_the_values_the_client_will_switch_on_are_the_ones_the_code_has(document: dict[str, Any]) -> None:
    """An outcome, a layer or a rule added in the code appears in the document, so the client's types follow it."""
    schemas = document["components"]["schemas"]

    assert set(schemas["Outcome"]["enum"]) == {outcome.value for outcome in Outcome}
    assert set(schemas["Layer"]["enum"]) == {layer.value for layer in Layer}
    assert set(schemas["Rule"]["enum"]) == {rule.value for rule in Rule}


def test_the_committed_file_is_stored_the_way_the_command_writes_it() -> None:
    """Sorted keys, two-space indents and a closing newline, so a regenerated file differs only where the API did."""
    text = Path(SERVICE_DIRECTORY / OPENAPI_FILE).read_text(encoding="utf-8")

    assert text == json.dumps(json.loads(text), indent=2, sort_keys=True, ensure_ascii=False) + "\n"
