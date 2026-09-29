"""Who is asking: the anonymous visitor behind a request, as the site vouches for them.

Visitors have no accounts. The site's server (Nuxt's Nitro routes) keeps each visitor's
anonymous session and mints a short-lived token for one system at a time
(docs/SECURITY.md, section 2): an Ed25519-signed JWT whose subject is a keyed hash of
the session, never the session cookie itself. The Django systems check that token on
every request, and know the visitor only by that subject.

The token, as the site must mint it:

    header   {"alg": "EdDSA", "typ": "JWT"}
    claims   {"iss": "lb-web", "aud": "<system, such as lb-01>", "sub": "<session hash>",
              "iat": <issued, Unix seconds>, "exp": <at most 300 seconds later>}

Without the site's public key (LB_WEB_TOKEN_KEY), no token verifies: the systems fail
closed rather than serve anyone unchecked.
"""

import base64
import binascii
import re
import time
from collections.abc import Callable
from dataclasses import dataclass

import jwt
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from django.conf import settings
from django.http import HttpRequest
from ninja.security import HttpBearer

# Who mints visitor tokens: the site's server.
ISSUER = "lb-web"
# The longest a token may live, as docs/SECURITY.md sets it, and the clock drift allowed.
MAX_LIFETIME_SECONDS = 300
LEEWAY_SECONDS = 30
# A session hash: the format the gateway accepts for session keys (lb_common.run).
SESSION_KEY = re.compile(r"[\w-]{16,128}", re.ASCII)


class VisitorTokenError(Exception):
    """The request's visitor token is missing, malformed, expired, or not for this system."""


@dataclass(frozen=True)
class Visitor:
    """An anonymous visitor, known by the hash of their session, calling one system."""

    session_key: str
    system: str


def load_public_key(encoded: str) -> Ed25519PublicKey:
    """Read the site's Ed25519 public key from its base64url form (a JWK's `x`)."""
    try:
        raw = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
    except (binascii.Error, ValueError):
        raise ValueError("LB_WEB_TOKEN_KEY isn't base64url.") from None
    if len(raw) != 32:
        raise ValueError("LB_WEB_TOKEN_KEY isn't an Ed25519 public key: it must be 32 bytes.")
    return Ed25519PublicKey.from_public_bytes(raw)


def verify_visitor_token(
    token: str, system: str, public_key: Ed25519PublicKey, now: Callable[[], float] = time.time
) -> Visitor:
    """Check a visitor token for `system`, and return the visitor it vouches for."""
    try:
        claims = jwt.decode(
            token,
            key=public_key,
            algorithms=["EdDSA"],
            audience=system,
            issuer=ISSUER,
            leeway=LEEWAY_SECONDS,
            options={"require": ["iss", "aud", "sub", "iat", "exp"]},
        )
    except jwt.PyJWTError as error:
        raise VisitorTokenError(type(error).__name__) from None
    issued, expires = claims["iat"], claims["exp"]
    if not isinstance(issued, int) or not isinstance(expires, int) or expires - issued > MAX_LIFETIME_SECONDS:
        raise VisitorTokenError("The token may live at most 300 seconds.")
    if issued > now() + LEEWAY_SECONDS:
        raise VisitorTokenError("The token was issued in the future.")
    subject = claims["sub"]
    if not isinstance(subject, str) or not SESSION_KEY.fullmatch(subject):
        raise VisitorTokenError("The token's subject isn't a session hash.")
    return Visitor(session_key=subject, system=system)


def visitor_from_token(token: str, system: str) -> Visitor:
    """Check a visitor token against the site's key in the settings, failing closed when there is none."""
    if not settings.WEB_TOKEN_KEY:
        raise VisitorTokenError("LB_WEB_TOKEN_KEY isn't set, so no visitor can be checked.")
    return verify_visitor_token(token, system, load_public_key(settings.WEB_TOKEN_KEY))


class VisitorBearer(HttpBearer):
    """Django Ninja authentication for one system's routes: a valid visitor token for that system, or 401."""

    def __init__(self, system: str) -> None:
        """Accept only tokens minted for `system`, such as lb-01."""
        super().__init__()
        self.system = system

    def authenticate(self, request: HttpRequest, token: str) -> Visitor | None:  # noqa: ARG002 - Ninja's signature
        """Return the visitor the token vouches for, or None, which Ninja answers with 401."""
        try:
            return visitor_from_token(token, self.system)
        except VisitorTokenError:
            return None
