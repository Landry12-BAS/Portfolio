"""Tests for core.visitors, Django's side of visitor authentication: the settings glue and the Ninja bearer."""

import base64
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from django.http import HttpRequest
from pytest_django.fixtures import Settings

from core.visitors import Visitor, VisitorBearer, VisitorTokenError, visitor_from_token

SESSION = "session-hash-0123456789abcdef"


@pytest.fixture
def site_key(settings: Settings) -> Ed25519PrivateKey:
    """Make the site's signing key, and give the service its public half."""
    key = Ed25519PrivateKey.generate()
    raw = key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    settings.WEB_TOKEN_KEY = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    return key


def mint(key: Ed25519PrivateKey, system: str = "lb-01") -> str:
    """Mint a visitor token as the site does."""
    now = int(time.time())
    claims = {"iss": "lb-web", "aud": system, "sub": SESSION, "iat": now, "exp": now + 300}
    return jwt.encode(claims, key, algorithm="EdDSA")


def test_the_key_comes_from_the_settings(site_key: Ed25519PrivateKey) -> None:
    """A token signed by the site's key names its visitor."""
    assert visitor_from_token(mint(site_key), "lb-01") == Visitor(session_key=SESSION, system="lb-01")


def test_without_the_sites_key_nobody_gets_in(site_key: Ed25519PrivateKey, settings: Settings) -> None:
    """With LB_WEB_TOKEN_KEY unset, even a valid token is refused: the service fails closed."""
    settings.WEB_TOKEN_KEY = None

    with pytest.raises(VisitorTokenError, match="LB_WEB_TOKEN_KEY isn't set"):
        visitor_from_token(mint(site_key), "lb-01")


def test_the_bearer_answers_none_for_a_token_that_isnt_good(site_key: Ed25519PrivateKey) -> None:
    """Ninja turns None into a 401: another system's token, or garbage, never authenticates."""
    bearer = VisitorBearer("lb-01")
    request = HttpRequest()

    assert bearer.authenticate(request, mint(site_key)) == Visitor(session_key=SESSION, system="lb-01")
    assert bearer.authenticate(request, mint(site_key, system="lb-02")) is None
    assert bearer.authenticate(request, "not.a.token") is None
