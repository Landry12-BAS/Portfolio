"""Run the shared corpus of visitor tokens through Django's own authentication.

lb_common's tests run the corpus against the check itself (python/lb-common/tests/unit/test_visitor_corpus.py).
Here it goes through what Django adds: the Ninja bearer that guards LB-01's and LB-02's routes, which reads
the `Authorization` header, and `visitor_from_token`, which LB-02's WebSocket uses for the token in its first
frame. Every system accepts and refuses exactly the same tokens (docs/SECURITY.md, section 2).
"""

from typing import Any

import pytest
from django.http import HttpRequest
from ninja import Router
from ninja.testing import TestClient
from pytest_django.fixtures import Settings

from core.visitors import VisitorBearer, VisitorTokenError, visitor_from_token
from lb_common.testing import CorpusHeader, CorpusToken, load_visitor_token_corpus

CORPUS = load_visitor_token_corpus()
# Where the HTTP tests ask: one route behind the bearer of each system.
WHOAMI = "/whoami"


def now() -> float:
    """Return the moment every case is judged at."""
    return float(CORPUS.now)


def case_id(case: Any) -> str:
    """Name a case for the test report by what it says and the rule it tests."""
    return f"{case.name} ({case.rule})"


def reachable(value: str) -> bool:
    """Tell whether a header value can arrive over HTTP: tabs and printable Latin-1, no line breaks or controls."""
    return all(character == "\t" or ("\x20" <= character <= "\xff" and character != "\x7f") for character in value)


def survives_a_bearer_header(token: str) -> bool:
    """Tell whether a token can be sent as `Bearer <token>`: it can arrive, and has no space or tab at its ends."""
    return reachable(f"Bearer {token}") and token == token.strip(" \t")


def whoami(request: HttpRequest) -> dict[str, str]:
    """Answer with the session of the visitor the token named, so a test sees who was let in."""
    return {"session": getattr(request, "auth").session_key}  # noqa: B009 - Ninja sets `auth` on the request


def client_for(system: str) -> TestClient:
    """Make a client for one route that only a visitor of `system` may call, judged at the corpus's moment."""
    router = Router(auth=VisitorBearer(system, now=now))
    router.get(WHOAMI)(whoami)
    return TestClient(router)


@pytest.fixture(autouse=True)
def sites_key(settings: Settings) -> None:
    """Give the service the public key the corpus was signed for."""
    settings.WEB_TOKEN_KEY = CORPUS.public_key


@pytest.mark.parametrize(
    "case",
    [case for case in CORPUS.tokens if case.expect == "ok" and survives_a_bearer_header(case.token)],
    ids=case_id,
)
def test_the_bearer_lets_in(case: CorpusToken) -> None:
    """A token the corpus says is good gets through the bearer, as the visitor it names."""
    response = client_for(case.system).get(WHOAMI, headers={"Authorization": f"Bearer {case.token}"})

    assert response.status_code == 200
    assert response.json() == {"session": case.session_key}


@pytest.mark.parametrize(
    "case",
    [case for case in CORPUS.tokens if case.expect == "refuse" and survives_a_bearer_header(case.token)],
    ids=case_id,
)
def test_the_bearer_answers_401_to(case: CorpusToken) -> None:
    """A token the corpus says is bad is answered with 401 by the bearer."""
    response = client_for(case.system).get(WHOAMI, headers={"Authorization": f"Bearer {case.token}"})

    assert response.status_code == 401


@pytest.mark.parametrize(
    "case",
    [case for case in CORPUS.headers if case.expect == "ok" and reachable(case.authorization or "")],
    ids=case_id,
)
def test_the_bearer_reads_this_header(case: CorpusHeader) -> None:
    """A header the corpus says is good gets through, however Ninja's own reading of it would have gone."""
    response = client_for(case.system).get(WHOAMI, headers={"Authorization": case.authorization or ""})

    assert response.status_code == 200


@pytest.mark.parametrize(
    "case",
    [
        case
        for case in CORPUS.headers
        if case.expect == "refuse" and case.authorization is not None and reachable(case.authorization)
    ],
    ids=case_id,
)
def test_the_bearer_refuses_this_header(case: CorpusHeader) -> None:
    """A header the corpus says is bad is answered with 401."""
    response = client_for(case.system).get(WHOAMI, headers={"Authorization": case.authorization or ""})

    assert response.status_code == 401


def test_the_bearer_refuses_a_request_with_no_header() -> None:
    """A request with no `Authorization` header at all is answered with 401."""
    assert client_for("lb-01").get(WHOAMI).status_code == 401


@pytest.mark.parametrize("case", [case for case in CORPUS.tokens if case.expect == "ok"], ids=case_id)
def test_a_websocket_frame_lets_in(case: CorpusToken) -> None:
    """The token in a WebSocket's first frame is judged by the same rules, and names the same visitor."""
    visitor = visitor_from_token(case.token, case.system, now)

    assert visitor.session_key == case.session_key
    assert visitor.system == case.system


@pytest.mark.parametrize("case", [case for case in CORPUS.tokens if case.expect == "refuse"], ids=case_id)
def test_a_websocket_frame_refuses(case: CorpusToken) -> None:
    """A token the corpus says is bad is refused with a VisitorTokenError, whatever way it arrives."""
    with pytest.raises(VisitorTokenError):
        visitor_from_token(case.token, case.system, now)
