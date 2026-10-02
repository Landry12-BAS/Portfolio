"""Flask's side of visitor authentication: a hook that checks the visitor token of one system.

The token check itself, and the token's format, are in lb_common.visitors, which every
Python system shares. Here the check runs before each request of a system's blueprint,
with the site's public key from the environment. Visitors have no accounts: the only
thing known about one is the hash of their session, from the token's subject.
"""

import time
from collections.abc import Callable

from flask import Response, g, request

from core.errors import error_response
from lb_common.visitors import Visitor, VisitorTokenError, visitor_from_header

# Where the checked visitor is kept for the length of the request.
VISITOR_KEY = "lb_visitor"


def require_visitor(
    system: str, encoded_key: str | None, now: Callable[[], float] = time.time
) -> Callable[[], Response | None]:
    """Build the before-request hook for one system: a valid visitor token for it, or a 401.

    `system` is a part number such as `lb-05`. A token minted for another system never
    passes. Without the site's key (`encoded_key`), nobody does: the service fails closed.
    `now` is the clock tokens are judged by, which tests set.
    """

    def check() -> Response | None:
        """Check the request's bearer token, and remember the visitor it names."""
        try:
            visitor = visitor_from_header(request.headers.get("Authorization"), system, encoded_key, now)
        except VisitorTokenError:
            return error_response(401, "unauthorized", "This route needs a valid visitor token for its system.")
        setattr(g, VISITOR_KEY, visitor)
        return None

    return check


def visitor_of_request() -> Visitor:
    """Return the visitor the current request's token vouched for.

    Only valid inside a route guarded by `require_visitor`; anywhere else it is a bug,
    and it fails rather than guess.
    """
    visitor = getattr(g, VISITOR_KEY, None)
    if not isinstance(visitor, Visitor):
        raise RuntimeError("This route has no checked visitor: guard its blueprint with require_visitor().")
    return visitor
