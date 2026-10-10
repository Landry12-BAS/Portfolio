"""Run the shared corpus of visitor tokens through Flask's own authentication.

lb_common's tests run the corpus against the check itself (python/lb-common/tests/unit/test_visitor_corpus.py).
Here it goes through what Flask adds: the before-request hook that guards each system's blueprint and reads the
`Authorization` header. Every system accepts and refuses exactly the same tokens (docs/SECURITY.md, section 2).
"""

from typing import Any

import pytest
from flask import Blueprint, Flask
from flask.testing import FlaskClient

from core.visitors import require_visitor, visitor_of_request
from lb_common.testing import CorpusHeader, CorpusToken, load_visitor_token_corpus

CORPUS = load_visitor_token_corpus()
# The systems the corpus asks about, and the one route each is asked on.
SYSTEMS = sorted({case.system for case in CORPUS.tokens} | {case.system for case in CORPUS.headers})
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


def app_for(system: str) -> Flask:
    """Make an app with one route that only a visitor of `system` may call, judged at the corpus's moment."""
    app = Flask(f"corpus-{system}")
    guarded = Blueprint("guarded", __name__)
    guarded.before_request(require_visitor(system, CORPUS.public_key, now))

    @guarded.get(WHOAMI)
    def whoami() -> dict[str, str]:
        """Say which visitor the token vouched for."""
        return {"session": visitor_of_request().session_key}

    app.register_blueprint(guarded)
    return app


@pytest.fixture(scope="module")
def clients() -> dict[str, FlaskClient]:
    """Make a client for each system the corpus asks about."""
    return {system: app_for(system).test_client() for system in SYSTEMS}


@pytest.mark.parametrize(
    "case",
    [case for case in CORPUS.tokens if case.expect == "ok" and survives_a_bearer_header(case.token)],
    ids=case_id,
)
def test_the_hook_lets_in(case: CorpusToken, clients: dict[str, FlaskClient]) -> None:
    """A token the corpus says is good gets through the hook, as the visitor it names."""
    response = clients[case.system].get(WHOAMI, headers={"Authorization": f"Bearer {case.token}"})

    assert response.status_code == 200
    assert response.get_json() == {"session": case.session_key}


@pytest.mark.parametrize(
    "case",
    [case for case in CORPUS.tokens if case.expect == "refuse" and survives_a_bearer_header(case.token)],
    ids=case_id,
)
def test_the_hook_answers_401_to(case: CorpusToken, clients: dict[str, FlaskClient]) -> None:
    """A token the corpus says is bad is answered with 401 by the hook."""
    response = clients[case.system].get(WHOAMI, headers={"Authorization": f"Bearer {case.token}"})

    assert response.status_code == 401


@pytest.mark.parametrize(
    "case",
    [case for case in CORPUS.headers if case.expect == "ok" and reachable(case.authorization or "")],
    ids=case_id,
)
def test_the_hook_reads_this_header(case: CorpusHeader, clients: dict[str, FlaskClient]) -> None:
    """A header the corpus says is good gets through."""
    response = clients[case.system].get(WHOAMI, headers={"Authorization": case.authorization or ""})

    assert response.status_code == 200


@pytest.mark.parametrize(
    "case",
    [case for case in CORPUS.headers if case.expect == "refuse" and reachable(case.authorization or "")],
    ids=case_id,
)
def test_the_hook_refuses_this_header(case: CorpusHeader, clients: dict[str, FlaskClient]) -> None:
    """A header the corpus says is bad is answered with 401, including a request with no header at all."""
    headers = {} if case.authorization is None else {"Authorization": case.authorization}

    assert clients[case.system].get(WHOAMI, headers=headers).status_code == 401
