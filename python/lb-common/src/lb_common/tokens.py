"""Service tokens: the short-lived JWTs a service signs to call the AI gateway.

Each service holds its own Ed25519 private key, and the gateway holds only the public
halves (docs/SECURITY.md, section 5). A token names the service as both its key ID and
its issuer, names the gateway as its audience, and lives for minutes: a leaked token
expires quickly, and a leaked gateway config can't mint new ones. The gateway's side of
this contract is services/gateway/src/auth/service-token.ts.
"""

import base64
import binascii
import json
import re
import stat
import threading
import time
import uuid
from collections.abc import Callable, Mapping
from pathlib import Path

import jwt
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

# The audience every token names; the gateway refuses a token meant for anything else.
GATEWAY_AUDIENCE = "lb-gateway"
# The gateway refuses a token older than this, whatever its expiry says.
MAX_TOKEN_AGE_SECONDS = 600
# How long a new token lives.
DEFAULT_TTL_SECONDS = 300
# A token is replaced this long before it expires, so no request leaves with one about
# to lapse on the way.
REFRESH_MARGIN_SECONDS = 60

# A service name such as `django-systems`: the rule the gateway applies too.
SERVICE_NAME = re.compile(r"[a-z][a-z0-9-]{1,39}")


class ServiceKeyError(ValueError):
    """A service's private key is missing, malformed, or open to other users."""


def check_service_name(service: str) -> str:
    """Return the service name if it is valid, so a typo fails here and not at the gateway."""
    if not SERVICE_NAME.fullmatch(service):
        raise ValueError(f"{service!r} is not a service name: use lowercase letters, digits and hyphens.")
    return service


def decode_base64url(text: str) -> bytes:
    """Decode unpadded base64url, the encoding JWKs use for key material."""
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def encode_base64url(data: bytes) -> str:
    """Encode bytes as unpadded base64url."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def public_key_of(key: Ed25519PrivateKey) -> str:
    """Return the base64url public half of a key: the service's entry in the gateway's LB_SERVICE_KEYS."""
    return encode_base64url(key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw))


def private_key_from_jwk(jwk: Mapping[str, object]) -> Ed25519PrivateKey:
    """Build an Ed25519 private key from its JWK form, checking that its two halves match.

    The JWK is what `just gateway-token keygen` writes: key type OKP, curve Ed25519, the
    private part `d` and the public part `x`, both in base64url.
    """
    private_part = jwk.get("d")
    if jwk.get("kty") != "OKP" or jwk.get("crv") != "Ed25519" or not isinstance(private_part, str):
        raise ServiceKeyError("The key is not an Ed25519 private key in JWK form.")
    try:
        key = Ed25519PrivateKey.from_private_bytes(decode_base64url(private_part))
    except (binascii.Error, ValueError) as error:
        raise ServiceKeyError("The key's private part is not a valid Ed25519 key.") from error
    # The gateway knows the service by the public half. A mismatch would only show up
    # later, as refused calls, so it is caught here instead.
    public_part = jwk.get("x")
    if public_part is not None and public_part != public_key_of(key):
        raise ServiceKeyError("The key's public part doesn't match its private part.")
    return key


def load_service_key(path: Path) -> Ed25519PrivateKey:
    """Read a service's private key from its JWK file.

    Refuses a file that other users could read or change, the way ssh refuses a private
    key with loose permissions: the key is the service's whole identity at the gateway.
    Error messages name the file, never its contents.
    """
    try:
        mode = path.stat().st_mode
    except FileNotFoundError as error:
        raise ServiceKeyError(f"There is no service key at {path}.") from error
    if mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise ServiceKeyError(f"{path} is open to other users. Restrict it with: chmod 600 {path}")
    try:
        jwk = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ServiceKeyError(f"{path} is not a readable JSON key file.") from error
    if not isinstance(jwk, dict):
        raise ServiceKeyError(f"{path} is not a readable JSON key file.")
    return private_key_from_jwk(jwk)


def mint_service_token(service: str, key: Ed25519PrivateKey, now: float, ttl_seconds: int = DEFAULT_TTL_SECONDS) -> str:
    """Sign a service token the way the gateway requires.

    EdDSA, the service's name as key ID and issuer, the gateway as audience, a unique
    token ID, and a lifetime of `ttl_seconds` from `now` (Unix time in seconds).
    """
    check_service_name(service)
    if not 1 <= ttl_seconds <= MAX_TOKEN_AGE_SECONDS:
        raise ValueError(f"A token lives from 1 to {MAX_TOKEN_AGE_SECONDS} seconds, not {ttl_seconds}.")
    issued_at = int(now)
    claims = {
        "iss": service,
        "aud": GATEWAY_AUDIENCE,
        "iat": issued_at,
        "exp": issued_at + ttl_seconds,
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(claims, key, algorithm="EdDSA", headers={"kid": service, "typ": "JWT"})


class ServiceTokens:
    """Hands out tokens for one service, minting a new one only when the current one nears expiry.

    One instance serves the whole process; `current()` is safe to call from several
    threads at once.
    """

    def __init__(
        self,
        service: str,
        key: Ed25519PrivateKey,
        clock: Callable[[], float] = time.time,
        ttl_seconds: int = DEFAULT_TTL_SECONDS,
    ) -> None:
        """Prepare to sign as `service` with `key`. `clock` returns Unix time in seconds."""
        if not REFRESH_MARGIN_SECONDS < ttl_seconds <= MAX_TOKEN_AGE_SECONDS:
            raise ValueError(
                f"Tokens must live longer than {REFRESH_MARGIN_SECONDS} seconds and at most {MAX_TOKEN_AGE_SECONDS}."
            )
        self.service = check_service_name(service)
        self._key = key
        self._clock = clock
        self._ttl_seconds = ttl_seconds
        self._lock = threading.Lock()
        self._token: str | None = None
        self._expires_at = 0

    def current(self) -> str:
        """Return a token with at least a minute left, minting a fresh one when needed."""
        with self._lock:
            now = self._clock()
            if self._token is None or now >= self._expires_at - REFRESH_MARGIN_SECONDS:
                self._token = mint_service_token(self.service, self._key, now, self._ttl_seconds)
                self._expires_at = int(now) + self._ttl_seconds
            return self._token
