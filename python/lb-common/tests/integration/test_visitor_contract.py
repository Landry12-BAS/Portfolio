"""Contract test: the visitor tokens the site's TypeScript signer mints, checked by Python's real verifier.

The site's server (Nitro) signs a short-lived token for one system and one anonymous visitor
with `mintVisitorToken` from @lb/common, and every Python system checks it with
`verify_visitor_token`. These tests run the real signer in a Node process
(packages/common/test/support/mint-visitor-tokens.ts) and hand its tokens to the real
verifier, so a difference between the two ends of the format fails here and not in
production: the four systems' audiences, the subject, the lifetime and its limit, and
every way a token can be wrong (tampered, expired, for another system, too long-lived,
signed by anyone else).
"""

import base64
import json
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat

from lb_common.tokens import encode_base64url, public_key_of
from lb_common.visitors import (
    MAX_LIFETIME_SECONDS,
    Visitor,
    VisitorTokenError,
    load_public_key,
    verify_visitor_token,
    visitor_from_header,
)

pytestmark = pytest.mark.integration

REPO = Path(__file__).resolve().parents[4]
MINT_SCRIPT = REPO / "packages" / "common" / "test" / "support" / "mint-visitor-tokens.ts"
# How long the Node process may take to mint a batch of tokens.
MINT_SECONDS = 60
# The systems the site calls on a visitor's behalf.
SYSTEMS = ("lb-01", "lb-02", "lb-05", "lb-08")
# A session hash as the site makes it: a keyed SHA-256, 43 characters of base64url.
SESSION = "Zk3mQ9vP2xT7aB1cD4eF6gH8iJ0kL5nO-_sUvWxYzAB"


@dataclass(frozen=True)
class Minted:
    """The tokens the signer made in one run, the reasons it refused the others, and the key that signed."""

    tokens: dict[str, str]
    refusals: dict[str, str]
    key: Ed25519PrivateKey

    @property
    def encoded_public_key(self) -> str:
        """Return the signer's public key as LB_WEB_TOKEN_KEY holds it."""
        return public_key_of(self.key)


def jwk_of(key: Ed25519PrivateKey) -> dict[str, str]:
    """Write a private key in the JWK form `just gateway-token keygen` writes, which the signer reads."""
    private_part = key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    return {"kty": "OKP", "crv": "Ed25519", "d": encode_base64url(private_part), "x": public_key_of(key)}


def run_signer(key: Ed25519PrivateKey, requests: dict[str, dict[str, Any]]) -> Minted:
    """Run the real TypeScript signer on named requests, and sort its answers into tokens and refusals."""
    node = shutil.which("node")
    if node is None:
        pytest.fail("The contract test needs Node 22.18 or later on the PATH.")
    completed = subprocess.run(  # noqa: S603 - a fixed command: Node, and a script in this repository
        [node, str(MINT_SCRIPT)],
        input=json.dumps({"jwk": jwk_of(key), "requests": list(requests.values())}),
        capture_output=True,
        text=True,
        timeout=MINT_SECONDS,
        check=False,
    )
    if completed.returncode != 0:
        pytest.fail(f"The signer script failed:\n{completed.stderr}")
    answers: list[dict[str, str]] = json.loads(completed.stdout)
    tokens = {name: answer["token"] for name, answer in zip(requests, answers, strict=True) if "token" in answer}
    refusals = {name: answer["error"] for name, answer in zip(requests, answers, strict=True) if "error" in answer}
    return Minted(tokens=tokens, refusals=refusals, key=key)


def mint(system: str, now: int, session: str = SESSION, ttl: int | None = None) -> dict[str, Any]:
    """Ask the signer for a token the way the site's server does."""
    request: dict[str, Any] = {"kind": "mint", "system": system, "sessionKey": session, "now": now}
    if ttl is not None:
        request["ttl"] = ttl
    return request


def raw(claims: dict[str, Any], header: dict[str, Any] | None = None) -> dict[str, Any]:
    """Ask for a token the signer would never make, signed with its key, so the verifier can be shown refusing it."""
    return {"kind": "raw", "claims": claims, "header": header or {"alg": "EdDSA", "typ": "JWT"}}


@pytest.fixture(scope="module")
def minted() -> Minted:
    """Mint every token the tests need in one Node run, with a key made for this module."""
    now = int(time.time())
    claims = {"iss": "lb-web", "aud": "lb-01", "sub": SESSION, "iat": now}
    requests: dict[str, dict[str, Any]] = {f"ok:{system}": mint(system, now) for system in SYSTEMS}
    requests |= {
        "session:shortest": mint("lb-01", now, "a" * 16),
        "session:longest": mint("lb-01", now, "b" * 128),
        "one-minute": mint("lb-01", now, ttl=60),
        "expired": mint("lb-01", now - 600),
        "from-the-future": mint("lb-01", now + 600),
        "refused:lifetime-301": mint("lb-01", now, ttl=MAX_LIFETIME_SECONDS + 1),
        "refused:lifetime-0": mint("lb-01", now, ttl=0),
        "refused:system": mint("lb-1", now),
        "refused:subject": mint("lb-01", now, session="too short"),
        "raw:lifetime-300": raw({**claims, "exp": now + 300}),
        "raw:lifetime-301": raw({**claims, "exp": now + 301}),
        "raw:lifetime-3600": raw({**claims, "exp": now + 3600}),
        "raw:subject-with-spaces": raw({**claims, "exp": now + 300, "sub": "has spaces in the subject"}),
        "raw:other-issuer": raw({**claims, "exp": now + 300, "iss": "lb-gateway"}),
        "raw:hmac-header": raw({**claims, "exp": now + 300}, {"alg": "HS256", "typ": "JWT"}),
    }
    return run_signer(Ed25519PrivateKey.generate(), requests)


def check(minted: Minted, name: str, system: str = "lb-01", key: Ed25519PrivateKey | None = None) -> Visitor:
    """Verify one minted token for `system` against a key (the signer's by default), as a Python system does."""
    return verify_visitor_token(minted.tokens[name], system, (key or minted.key).public_key())


def forged(token: str, change: dict[str, Any]) -> str:
    """Change claims of a token without signing again: the header and signature are left as they were."""
    header, payload, signature = token.split(".")
    claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    claims.update(change)
    edited = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"{header}.{edited}.{signature}"


@pytest.mark.parametrize("system", SYSTEMS)
def test_python_accepts_a_token_for_each_system_the_site_calls(minted: Minted, system: str) -> None:
    """The visitor is the session hash the signer put in the subject, calling the system the token is for."""
    assert check(minted, f"ok:{system}", system) == Visitor(session_key=SESSION, system=system)


def test_a_token_is_good_for_one_system_only(minted: Minted) -> None:
    """A token for LB-01 is refused by every other system's check."""
    for other in SYSTEMS[1:]:
        with pytest.raises(VisitorTokenError):
            check(minted, "ok:lb-01", other)


def test_python_reads_the_token_from_a_bearer_header_with_the_key_as_configured(minted: Minted) -> None:
    """The header form every system uses, with LB_WEB_TOKEN_KEY as the deploy writes it, accepts the signer's token."""
    visitor = visitor_from_header(f"Bearer {minted.tokens['ok:lb-02']}", "lb-02", minted.encoded_public_key)

    assert visitor == Visitor(session_key=SESSION, system="lb-02")


def test_the_shortest_and_longest_session_hashes_the_systems_accept_are_signed_and_verified(minted: Minted) -> None:
    """The subject's length limits are the same in the signer and the verifier."""
    assert check(minted, "session:shortest").session_key == "a" * 16
    assert check(minted, "session:longest").session_key == "b" * 128


def test_a_one_minute_token_lives_one_minute(minted: Minted) -> None:
    """The lifetime the signer is asked for is the one in the token, and the verifier takes a shorter one."""
    claims = json.loads(base64.urlsafe_b64decode(minted.tokens["one-minute"].split(".")[1] + "=="))

    assert claims["exp"] - claims["iat"] == 60
    assert check(minted, "one-minute").system == "lb-01"


def test_the_default_lifetime_is_the_longest_the_verifier_allows(minted: Minted) -> None:
    """Five minutes is what the signer makes by default, and what the verifier accepts as the most."""
    claims = json.loads(base64.urlsafe_b64decode(minted.tokens["ok:lb-01"].split(".")[1] + "=="))

    assert claims["exp"] - claims["iat"] == MAX_LIFETIME_SECONDS
    assert check(minted, "raw:lifetime-300").system == "lb-01"


@pytest.mark.parametrize("name", ["raw:lifetime-301", "raw:lifetime-3600"])
def test_python_refuses_a_token_that_lives_longer_than_five_minutes(minted: Minted, name: str) -> None:
    """A token the signer would never make, with a long life, is refused: the limit is one number on both sides."""
    with pytest.raises(VisitorTokenError, match="300 seconds"):
        check(minted, name)


def test_python_refuses_an_expired_token_and_one_from_the_future(minted: Minted) -> None:
    """Ten minutes old, or ten minutes ahead, is outside the clock drift the verifier forgives."""
    for name in ("expired", "from-the-future"):
        with pytest.raises(VisitorTokenError):
            check(minted, name)


def test_python_refuses_a_token_signed_by_anyone_else(minted: Minted) -> None:
    """A token is only as good as the site's key: another key's token is refused, and this one under another key."""
    stranger = run_signer(Ed25519PrivateKey.generate(), {"token": mint("lb-01", int(time.time()))})

    with pytest.raises(VisitorTokenError):
        check(stranger, "token", key=minted.key)
    with pytest.raises(VisitorTokenError):
        verify_visitor_token(minted.tokens["ok:lb-01"], "lb-01", load_public_key(stranger.encoded_public_key))


@pytest.mark.parametrize(
    "change",
    [{"sub": "someone-elses-session-0123456789"}, {"aud": "lb-02"}, {"exp": 9_999_999_999}, {"iss": "lb-gateway"}],
)
def test_python_refuses_a_token_whose_claims_were_changed_after_signing(minted: Minted, change: dict[str, Any]) -> None:
    """Changing any claim without signing again breaks the signature, whatever the claim."""
    token = forged(minted.tokens["ok:lb-01"], change)

    with pytest.raises(VisitorTokenError):
        verify_visitor_token(token, change.get("aud", "lb-01"), minted.key.public_key())


def test_python_refuses_a_damaged_signature_or_a_truncated_token(minted: Minted) -> None:
    """A flipped bit in the signature, a missing signature and a missing segment are all refused."""
    header, payload, signature = minted.tokens["ok:lb-01"].split(".")
    flipped = signature[:-2] + ("A" if signature[-2] != "A" else "B") + signature[-1]

    for damaged in (f"{header}.{payload}.{flipped}", f"{header}.{payload}.", f"{header}.{payload}", header):
        with pytest.raises(VisitorTokenError):
            verify_visitor_token(damaged, "lb-01", minted.key.public_key())


def test_python_refuses_a_subject_that_is_not_a_session_hash_and_a_foreign_issuer_or_algorithm(minted: Minted) -> None:
    """The subject's shape, the issuer and the algorithm are checked, even on a token the right key signed."""
    for name in ("raw:subject-with-spaces", "raw:other-issuer", "raw:hmac-header"):
        with pytest.raises(VisitorTokenError):
            check(minted, name)


@pytest.mark.parametrize(
    ("name", "rule"),
    [
        ("refused:lifetime-301", "1 to 300 seconds"),
        ("refused:lifetime-0", "1 to 300 seconds"),
        ("refused:system", "named like lb-08"),
        ("refused:subject", "session hash"),
    ],
)
def test_the_signer_refuses_what_the_verifier_would_refuse_and_says_which_rule(
    minted: Minted, name: str, rule: str
) -> None:
    """A mistake fails at the signer with the rule's name, never as a surprise 401 from a system."""
    assert name not in minted.tokens
    assert rule in minted.refusals[name]
    assert "too short" not in minted.refusals[name]
