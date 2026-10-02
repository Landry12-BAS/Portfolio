"""Who is asking: the anonymous visitor behind a request, as the site vouches for them.

Visitors have no accounts. The site's server (Nuxt's Nitro routes) keeps each visitor's
anonymous session and mints a short-lived token for one system at a time
(docs/SECURITY.md, section 2): an Ed25519-signed JWT whose subject is a keyed hash of
the session, never the session cookie itself. Every Python system checks that token on
every request, and knows the visitor only by that subject.

The token, as the site must mint it:

    header   {"alg": "EdDSA", "typ": "JWT"}
    claims   {"iss": "lb-web", "aud": "<system, such as lb-01>", "sub": "<session hash>",
              "iat": <issued, Unix seconds>, "exp": <at most 300 seconds later>}

This module holds the check, with no web framework in it: a Django or Flask system wraps
`verify_visitor_token` in its own authentication. Without the site's public key
(LB_WEB_TOKEN_KEY), no token verifies, so systems fail closed rather than serve anyone
unchecked.

It is the twin of packages/common's visitors.ts, which the Node systems use, and the two
accept and refuse exactly the same tokens. A lenient parser would let a token that only the
site's key could sign be read one way here and another there, and the two would disagree about
who is asking. So the text of a token has one spelling (no padding, no stray bits, no byte
order mark), its JSON holds only plain values, and a time is a whole number of seconds. One
corpus of signed tokens, with the verdict each must get
(packages/common/test/fixtures/visitor-tokens.json), is run by the tests of both checks, and
the corpus names every rule.
"""

import base64
import binascii
import json
import re
import time
from collections.abc import Callable, Container
from dataclasses import dataclass
from typing import Any, NoReturn, TypeGuard

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

# Who mints visitor tokens: the site's server.
ISSUER = "lb-web"
# The longest a token may live, as docs/SECURITY.md sets it, and the clock drift allowed.
MAX_LIFETIME_SECONDS = 300
LEEWAY_SECONDS = 30
# No honest token comes near this length; refusing larger input early keeps a flood of junk cheap.
MAX_TOKEN_LENGTH = 2048
# An Ed25519 signature is always 64 bytes, and a public key 32.
SIGNATURE_BYTES = 64
PUBLIC_KEY_BYTES = 32
# The largest whole number of seconds a double holds exactly: what a JSON number may be here.
MAX_SAFE_INTEGER = 2**53 - 1
# A session hash: the format the gateway accepts for session keys (lb_common.run).
SESSION_KEY = re.compile(r"[\w-]{16,128}", re.ASCII)
# A compact JWT is three base64url segments of letters, digits, "-" and "_": no padding, nothing else.
SEGMENT = re.compile(r"[A-Za-z0-9_-]+")
# What the Authorization header's scheme is called, in any case, in ASCII only.
BEARER_SCHEME = re.compile(r"bearer", re.ASCII | re.IGNORECASE)
BEARER_LENGTH = len("bearer")
# The claims every token must carry.
REQUIRED_CLAIMS = ("iss", "aud", "sub", "iat", "exp")
# The one member that may hold a list, and only of strings: who the token is for.
LIST_CLAIMS = frozenset({"aud"})
# The error every malformed token gets, whatever is wrong with it, so a caller can't probe which check failed.
MALFORMED = "The token is malformed."


class VisitorTokenError(Exception):
    """The request's visitor token is missing, malformed, expired, or not for this system."""


@dataclass(frozen=True)
class Visitor:
    """An anonymous visitor, known by the hash of their session, calling one system."""

    session_key: str
    system: str


def _decode_segment(segment: str, error: Callable[[], Exception]) -> bytes:
    """Decode one base64url segment to its bytes, which the text must write canonically.

    Canonical means exactly what encoding those bytes writes, so a stray bit or a dangling
    character is refused: the TypeScript check's decoder would drop it, and the two must agree.
    `error` makes what is raised, since a token and a configured key fail differently.
    """
    try:
        data = base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))
    except (binascii.Error, ValueError):
        raise error() from None
    if base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii") != segment:
        raise error()
    return data


def _malformed() -> VisitorTokenError:
    """Make the error every malformed token gets."""
    return VisitorTokenError(MALFORMED)


def _stray_key_bits() -> ValueError:
    """Make the error for a configured key that isn't written the one canonical way."""
    return ValueError("LB_WEB_TOKEN_KEY isn't canonical base64url: its last character carries stray bits.")


def load_public_key(encoded: str) -> Ed25519PublicKey:
    """Read the site's Ed25519 public key from its base64url form (a JWK's `x`): unpadded, canonical, 32 bytes."""
    if not SEGMENT.fullmatch(encoded):
        raise ValueError("LB_WEB_TOKEN_KEY isn't base64url.")
    raw = _decode_segment(encoded, _stray_key_bits)
    if len(raw) != PUBLIC_KEY_BYTES:
        raise ValueError("LB_WEB_TOKEN_KEY isn't an Ed25519 public key: it must be 32 bytes.")
    return Ed25519PublicKey.from_public_bytes(raw)


def _refuse_constant(constant: str) -> NoReturn:
    """Refuse the constants Python's JSON reader accepts and JSON does not: NaN, Infinity and -Infinity."""
    raise ValueError(constant)


def _is_plain_value(value: object) -> bool:
    """Tell whether a JSON value is a string, number, boolean or null: the plain values a token's members may hold."""
    return value is None or isinstance(value, str | int | float | bool)


def _is_list_of_strings(value: object) -> TypeGuard[list[str]]:
    """Tell whether a JSON value is a list of strings."""
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def _decode_object(segment: str, list_members: Container[str]) -> dict[str, Any]:
    """Decode one segment of a token as a JSON object, or fail as a malformed token.

    The bytes must be UTF-8 with no byte order mark, and every member a plain value (a string,
    number, boolean or null). Only the members named in `list_members` may hold a list, and then
    only of strings. Nothing deeper is allowed, so there is no nesting for two JSON parsers to
    disagree about.
    """
    data = _decode_segment(segment, _malformed)
    try:
        value = json.loads(data.decode("utf-8"), parse_constant=_refuse_constant)
    except (ValueError, RecursionError):
        # Not UTF-8, not JSON, or too deep to read: the error below doesn't repeat which.
        raise _malformed() from None
    if not isinstance(value, dict):
        raise _malformed()
    for name, member in value.items():
        if not (_is_plain_value(member) or (name in list_members and _is_list_of_strings(member))):
            raise _malformed()
    return value


def _is_seconds(value: object) -> bool:
    """Tell whether a claim is a whole number of seconds a double holds exactly.

    1790000000, 1.79e9 and 1790000000.0 are; 1790000000.5 and 2**53 are not. A boolean is not a
    number here, though Python counts it as one.
    """
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return abs(value) <= MAX_SAFE_INTEGER
    if isinstance(value, float):
        return value.is_integer() and abs(value) <= MAX_SAFE_INTEGER
    return False


def _check_header(header: dict[str, Any]) -> None:
    """Check that a token's header asks for the one algorithm accepted, and nothing the verifier doesn't understand."""
    # Only Ed25519 signatures: no `none`, and no shared-secret HMAC the site's public key could be misused as.
    if header.get("alg") != "EdDSA":
        raise VisitorTokenError("The token isn't signed with EdDSA.")
    # A `crit` header lists extensions the verifier must understand, and this one understands none.
    if "crit" in header:
        raise VisitorTokenError("The token uses extensions this service doesn't understand.")


def _audience_includes(audience: object, system: str) -> bool:
    """Tell whether the audience claim names this system, as a string or in a list that holds nothing but strings."""
    return audience == system or (_is_list_of_strings(audience) and system in audience)


def _check_times(claims: dict[str, Any], now: float) -> None:
    """Check a token's times at a moment given in Unix seconds: whole, a lifetime of 1 to 300 seconds, and in range."""
    issued, expires = claims["iat"], claims["exp"]
    # A token with no "not before" is valid from the moment it was issued.
    not_before = claims.get("nbf", issued)
    if not all(_is_seconds(moment) for moment in (issued, expires, not_before)):
        raise VisitorTokenError("The token's times aren't whole seconds.")
    if expires <= issued:
        raise VisitorTokenError("The token expires before it was issued.")
    if expires - issued > MAX_LIFETIME_SECONDS:
        raise VisitorTokenError("The token may live at most 300 seconds.")
    if expires <= now - LEEWAY_SECONDS:
        raise VisitorTokenError("The token has expired.")
    if issued > now + LEEWAY_SECONDS:
        raise VisitorTokenError("The token was issued in the future.")
    if not_before > now + LEEWAY_SECONDS:
        raise VisitorTokenError("The token isn't valid yet.")


def _check_claims(claims: dict[str, Any], system: str, now: float) -> str:
    """Check a token's claims at a moment given in Unix seconds, and return the session they vouch for."""
    for name in REQUIRED_CLAIMS:
        if name not in claims:
            raise VisitorTokenError(f"The token has no {name} claim.")
    if claims["iss"] != ISSUER:
        raise VisitorTokenError("The token wasn't issued by the site.")
    if not _audience_includes(claims["aud"], system):
        raise VisitorTokenError("The token isn't for this system.")
    _check_times(claims, now)
    subject = claims["sub"]
    if not isinstance(subject, str) or not SESSION_KEY.fullmatch(subject):
        raise VisitorTokenError("The token's subject isn't a session hash.")
    return subject


def _check_signature(header_part: str, claims_part: str, signature_part: str, public_key: Ed25519PublicKey) -> None:
    """Check the signature over the first two segments as written: 64 canonical bytes that verify under the key."""
    signature = _decode_segment(signature_part, _malformed)
    if len(signature) != SIGNATURE_BYTES:
        raise VisitorTokenError("The token's signature is wrong.")
    try:
        public_key.verify(signature, f"{header_part}.{claims_part}".encode("ascii"))
    except InvalidSignature:
        raise VisitorTokenError("The token's signature is wrong.") from None


def verify_visitor_token(
    token: str, system: str, public_key: Ed25519PublicKey, now: Callable[[], float] = time.time
) -> Visitor:
    """Check a visitor token for `system`, and return the visitor it vouches for.

    `now` returns Unix time in seconds. Any problem raises VisitorTokenError, which a system
    answers with 401, and nothing else escapes, whatever bytes the token holds.
    """
    if len(token) > MAX_TOKEN_LENGTH:
        raise _malformed()
    segments = token.split(".")
    if len(segments) != 3 or not all(SEGMENT.fullmatch(segment) for segment in segments):
        raise _malformed()
    header_part, claims_part, signature_part = segments
    _check_header(_decode_object(header_part, frozenset()))
    _check_signature(header_part, claims_part, signature_part, public_key)
    subject = _check_claims(_decode_object(claims_part, LIST_CLAIMS), system, now())
    return Visitor(session_key=subject, system=system)


def bearer_token(authorization: str | None) -> str:
    """Take the token out of an `Authorization` header, or raise VisitorTokenError.

    The header stripped of spaces and tabs at both ends is `Bearer` in any case, one or more
    spaces, and the token. Nothing else is stripped (`str.strip()` with no argument would also
    strip line breaks, no-break spaces and byte order marks, which the TypeScript check leaves
    alone). The token's own rules then judge what follows as a whole, so a tab, a line break or
    a second word in it makes the token malformed.
    """
    text = (authorization or "").strip(" \t")
    scheme, rest = text[:BEARER_LENGTH], text[BEARER_LENGTH:]
    if not BEARER_SCHEME.fullmatch(scheme) or not rest.startswith(" "):
        raise VisitorTokenError("The request has no bearer token.")
    return rest.lstrip(" ")


def visitor_from_header(
    authorization: str | None, system: str, encoded_key: str | None, now: Callable[[], float] = time.time
) -> Visitor:
    """Check an `Authorization: Bearer <token>` header for `system`, failing closed.

    `encoded_key` is the site's public key as configured (LB_WEB_TOKEN_KEY); without one,
    nobody is let in. Any problem raises VisitorTokenError, which a system answers with 401.
    """
    if not encoded_key:
        raise VisitorTokenError("LB_WEB_TOKEN_KEY isn't set, so no visitor can be checked.")
    return verify_visitor_token(bearer_token(authorization), system, load_public_key(encoded_key), now)
