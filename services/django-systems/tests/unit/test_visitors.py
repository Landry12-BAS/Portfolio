"""Tests for core.visitors: only a fresh token the site signed for this system lets a visitor in."""

import base64
import time
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from pytest_django.fixtures import Settings

from core.visitors import (
    MAX_LIFETIME_SECONDS,
    Visitor,
    VisitorTokenError,
    load_public_key,
    verify_visitor_token,
    visitor_from_token,
)

SESSION = "session-hash-0123456789abcdef"


@pytest.fixture
def site_key() -> Ed25519PrivateKey:
    """Make the site's signing key for one test."""
    return Ed25519PrivateKey.generate()


def public_text(key: Ed25519PrivateKey) -> str:
    """Write a key's public half as LB_WEB_TOKEN_KEY holds it: unpadded base64url."""
    raw = key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def mint(key: Ed25519PrivateKey, **changes: Any) -> str:
    """Mint a visitor token as the site does, with some claims changed; None removes a claim."""
    now = int(time.time())
    claims: dict[str, Any] = {"iss": "lb-web", "aud": "lb-01", "sub": SESSION, "iat": now, "exp": now + 300}
    for name, value in changes.items():
        if value is None:
            claims.pop(name)
        else:
            claims[name] = value
    return jwt.encode(claims, key, algorithm="EdDSA")


def test_a_fresh_token_for_the_system_names_its_visitor(site_key: Ed25519PrivateKey) -> None:
    """The visitor is known by the token's subject: their session's hash."""
    visitor = verify_visitor_token(mint(site_key), "lb-01", site_key.public_key())

    assert visitor == Visitor(session_key=SESSION, system="lb-01")


@pytest.mark.parametrize(
    "changes",
    [
        {"aud": "lb-02"},
        {"iss": "someone-else"},
        {"exp": int(time.time()) - 60},
        {"exp": int(time.time()) + MAX_LIFETIME_SECONDS + 100},
        {"iat": int(time.time()) + 600, "exp": int(time.time()) + 700},
        {"sub": "short"},
        {"sub": "not a session; DROP TABLE"},
        {"sub": None},
        {"exp": None},
        {"iat": None},
    ],
)
def test_a_token_that_breaks_a_rule_is_refused(site_key: Ed25519PrivateKey, changes: dict[str, Any]) -> None:
    """Another system's token, an expired one, a long-lived one, or one without a proper subject is refused."""
    with pytest.raises(VisitorTokenError):
        verify_visitor_token(mint(site_key, **changes), "lb-01", site_key.public_key())


def test_a_token_signed_by_another_key_is_refused(site_key: Ed25519PrivateKey) -> None:
    """Only the site's own key can vouch for a visitor."""
    forged = mint(Ed25519PrivateKey.generate())

    with pytest.raises(VisitorTokenError):
        verify_visitor_token(forged, "lb-01", site_key.public_key())


def test_unsigned_and_shared_secret_tokens_are_refused(site_key: Ed25519PrivateKey) -> None:
    """The algorithm is fixed to EdDSA: `none`, and HMAC keyed with the public key, both fail."""
    claims = {"iss": "lb-web", "aud": "lb-01", "sub": SESSION, "iat": int(time.time()), "exp": int(time.time()) + 60}
    unsigned = jwt.encode(claims, key="", algorithm="none")
    header, payload, _ = jwt.encode(claims, "x" * 32, algorithm="HS256").split(".")

    for token in (unsigned, f"{header}.{payload}.c2lnbmF0dXJl"):
        with pytest.raises(VisitorTokenError):
            verify_visitor_token(token, "lb-01", site_key.public_key())


def test_without_the_sites_key_nobody_gets_in(site_key: Ed25519PrivateKey, settings: Settings) -> None:
    """With LB_WEB_TOKEN_KEY unset, even a valid token is refused: the service fails closed."""
    settings.WEB_TOKEN_KEY = None

    with pytest.raises(VisitorTokenError, match="LB_WEB_TOKEN_KEY isn't set"):
        visitor_from_token(mint(site_key), "lb-01")


def test_the_sites_key_is_read_from_base64url(site_key: Ed25519PrivateKey) -> None:
    """The key reads from unpadded base64url, and anything that isn't a 32-byte key is refused."""
    assert load_public_key(public_text(site_key)) == site_key.public_key()
    with pytest.raises(ValueError, match="32 bytes"):
        load_public_key("c2hvcnQ")
    with pytest.raises(ValueError, match="isn't base64url"):
        load_public_key("not/base64url!")
