"""Unit tests for service tokens: the claims the gateway checks, key files, and token reuse."""

import json
from pathlib import Path

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from lb_common.tokens import (
    GATEWAY_AUDIENCE,
    ServiceKeyError,
    ServiceTokens,
    load_service_key,
    mint_service_token,
    private_key_from_jwk,
    public_key_of,
)

NOW = 1_790_000_000.0


def decode(token: str, key: Ed25519PrivateKey) -> dict[str, object]:
    """Verify a token the way the gateway does, at the test's fixed time, and return its claims."""
    claims: dict[str, object] = jwt.decode(
        token,
        key.public_key(),
        algorithms=["EdDSA"],
        audience=GATEWAY_AUDIENCE,
        options={"verify_exp": False, "require": ["iss", "iat", "exp"]},
    )
    return claims


def test_a_token_carries_every_claim_the_gateway_checks(service_key: Ed25519PrivateKey) -> None:
    """EdDSA, the service as key ID and issuer, the gateway as audience, and a five-minute life."""
    token = mint_service_token("django-systems", service_key, NOW)

    header = jwt.get_unverified_header(token)
    claims = decode(token, service_key)
    assert header == {"alg": "EdDSA", "kid": "django-systems", "typ": "JWT"}
    assert claims["iss"] == "django-systems"
    assert claims["aud"] == GATEWAY_AUDIENCE
    assert claims["iat"] == int(NOW)
    assert claims["exp"] == int(NOW) + 300
    assert isinstance(claims["jti"], str)


def test_every_token_gets_its_own_id(service_key: Ed25519PrivateKey) -> None:
    """Two tokens minted in the same second still differ."""
    first = decode(mint_service_token("django-systems", service_key, NOW), service_key)
    second = decode(mint_service_token("django-systems", service_key, NOW), service_key)

    assert first["jti"] != second["jti"]


@pytest.mark.parametrize("service", ["Django", "a", "django_systems", "x" * 41, ""])
def test_a_malformed_service_name_is_refused(service_key: Ed25519PrivateKey, service: str) -> None:
    """Names follow the gateway's rule, so a typo fails before any call."""
    with pytest.raises(ValueError, match="not a service name"):
        mint_service_token(service, service_key, NOW)


@pytest.mark.parametrize("ttl", [0, 601])
def test_a_token_lives_ten_minutes_at_most(service_key: Ed25519PrivateKey, ttl: int) -> None:
    """The gateway refuses anything older than ten minutes, so nothing longer is minted."""
    with pytest.raises(ValueError, match="A token lives"):
        mint_service_token("django-systems", service_key, NOW, ttl)


def test_a_jwk_turns_back_into_the_same_key(service_key: Ed25519PrivateKey, service_jwk: dict[str, str]) -> None:
    """The key read from its JWK signs tokens the original public key verifies."""
    key = private_key_from_jwk(service_jwk)

    assert public_key_of(key) == public_key_of(service_key)


def test_a_jwk_whose_halves_differ_is_refused(service_jwk: dict[str, str]) -> None:
    """A public part from another key would only show up later as refused calls."""
    other = public_key_of(Ed25519PrivateKey.generate())

    with pytest.raises(ServiceKeyError, match="doesn't match"):
        private_key_from_jwk({**service_jwk, "x": other})


@pytest.mark.parametrize(
    "change",
    [{"kty": "EC"}, {"crv": "X25519"}, {"d": "not base64 at all!"}, {"d": "AAAA"}],
)
def test_a_jwk_that_is_not_an_ed25519_private_key_is_refused(
    service_jwk: dict[str, str], change: dict[str, str]
) -> None:
    """Wrong key types, curves and private parts all fail with the same error type."""
    with pytest.raises(ServiceKeyError):
        private_key_from_jwk({**service_jwk, **change})


def test_a_public_jwk_without_its_private_part_is_refused(service_jwk: dict[str, str]) -> None:
    """A JWK with only `x` can verify tokens but never sign them."""
    public_only = {key: value for key, value in service_jwk.items() if key != "d"}

    with pytest.raises(ServiceKeyError, match="not an Ed25519 private key"):
        private_key_from_jwk(public_only)


def test_a_private_key_file_is_read(key_file: Path, service_key: Ed25519PrivateKey) -> None:
    """A file only its owner can read loads as the service's key."""
    key = load_service_key(key_file)

    assert public_key_of(key) == public_key_of(service_key)


@pytest.mark.parametrize("mode", [0o640, 0o604, 0o620, 0o666])
def test_a_key_file_open_to_other_users_is_refused(key_file: Path, mode: int) -> None:
    """Like ssh, a private key others could read or change is not used."""
    key_file.chmod(mode)

    with pytest.raises(ServiceKeyError, match="chmod 600"):
        load_service_key(key_file)


def test_a_missing_key_file_says_where_it_looked(tmp_path: Path) -> None:
    """The error names the path, so a wrong LB_SERVICE_KEY_FILE is easy to spot."""
    missing = tmp_path / "nowhere.jwk.json"

    with pytest.raises(ServiceKeyError, match=r"nowhere\.jwk\.json"):
        load_service_key(missing)


def test_a_key_file_that_is_not_json_is_refused_without_quoting_it(key_file: Path) -> None:
    """The error never repeats the file's contents, which could be key material."""
    key_file.write_text("d=very-secret-material", encoding="utf-8")

    with pytest.raises(ServiceKeyError) as caught:
        load_service_key(key_file)
    assert "very-secret-material" not in str(caught.value)


def test_a_key_file_holding_a_list_is_refused(key_file: Path) -> None:
    """Valid JSON that isn't an object is not a key."""
    key_file.write_text(json.dumps(["not", "a", "key"]), encoding="utf-8")

    with pytest.raises(ServiceKeyError, match="not a readable JSON key file"):
        load_service_key(key_file)


class FakeClock:
    """A clock the test moves by hand, in Unix seconds."""

    def __init__(self, now: float) -> None:
        """Start the clock at `now`."""
        self.now = now

    def __call__(self) -> float:
        """Return the current test time."""
        return self.now


def test_tokens_are_reused_until_a_minute_before_they_expire(service_key: Ed25519PrivateKey) -> None:
    """A token is shared across calls while it has more than a minute left."""
    clock = FakeClock(NOW)
    tokens = ServiceTokens("django-systems", service_key, clock)

    first = tokens.current()
    clock.now += 239
    assert tokens.current() == first
    clock.now += 1
    assert tokens.current() != first


def test_a_fresh_token_always_has_at_least_a_minute_left(service_key: Ed25519PrivateKey) -> None:
    """Whenever a token is handed out, it expires more than a minute later."""
    clock = FakeClock(NOW)
    tokens = ServiceTokens("django-systems", service_key, clock)

    for _ in range(20):
        claims = decode(tokens.current(), service_key)
        assert isinstance(claims["exp"], int)
        assert claims["exp"] - clock.now > 60
        clock.now += 37


@pytest.mark.parametrize("ttl", [60, 601])
def test_token_lifetimes_must_leave_room_to_reuse_them(service_key: Ed25519PrivateKey, ttl: int) -> None:
    """A lifetime at or under the refresh margin would mint a token for every call."""
    with pytest.raises(ValueError, match="Tokens must live"):
        ServiceTokens("django-systems", service_key, ttl_seconds=ttl)
