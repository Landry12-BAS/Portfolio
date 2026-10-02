"""Django's side of visitor authentication: the settings glue and the Ninja bearer.

The token check itself, and the token's format, are in lb_common.visitors, which every
Python system shares. Here the site's public key comes from Django's settings.
"""

import time
from collections.abc import Callable

from django.conf import settings
from django.http import HttpRequest
from ninja.security import HttpBearer

from lb_common.visitors import Visitor, VisitorTokenError, load_public_key, verify_visitor_token, visitor_from_header

__all__ = (
    "Visitor",
    "VisitorBearer",
    "VisitorTokenError",
    "load_public_key",
    "verify_visitor_token",
    "visitor_from_token",
)


def visitor_from_token(token: str, system: str, now: Callable[[], float] = time.time) -> Visitor:
    """Check a visitor token against the site's key in the settings, failing closed when there is none."""
    if not settings.WEB_TOKEN_KEY:
        raise VisitorTokenError("LB_WEB_TOKEN_KEY isn't set, so no visitor can be checked.")
    return verify_visitor_token(token, system, load_public_key(settings.WEB_TOKEN_KEY), now)


class VisitorBearer(HttpBearer):
    """Django Ninja authentication for one system's routes: a valid visitor token for that system, or 401."""

    def __init__(self, system: str, now: Callable[[], float] = time.time) -> None:
        """Accept only tokens minted for `system`, such as lb-01. `now` is the clock, which tests set."""
        super().__init__()
        self.system = system
        self.now = now

    def __call__(self, request: HttpRequest) -> Visitor | None:
        """Return the visitor the request's `Authorization` header vouches for, or None, which Ninja answers with 401.

        Ninja's own reading of the header splits it on single spaces, so it takes `Bearer   token` for
        a token with leading spaces and `  Bearer token` for another scheme: it would accept and refuse
        different headers from the Node and Flask systems. The reading in lb_common.visitors is used
        instead, so every system treats the same header the same way.
        """
        try:
            return visitor_from_header(
                request.headers.get("Authorization"), self.system, settings.WEB_TOKEN_KEY, self.now
            )
        except VisitorTokenError:
            return None

    def authenticate(self, request: HttpRequest, token: str) -> Visitor | None:  # noqa: ARG002 - Ninja's signature
        """Return the visitor a bare token vouches for, or None (Ninja requires this; `__call__` is what it runs)."""
        try:
            return visitor_from_token(token, self.system, self.now)
        except VisitorTokenError:
            return None
