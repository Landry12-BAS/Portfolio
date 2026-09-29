"""Security headers on every response of the Django systems (docs/SECURITY.md, section 3).

The service answers JSON and streams events, never pages, so its content security policy
allows nothing at all, and no response may be cached: they carry a visitor's own data.
"""

from collections.abc import Callable

from django.http import HttpRequest, HttpResponseBase

SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Cross-Origin-Opener-Policy": "same-origin",
    # The site calls the API from its own subdomain.
    "Cross-Origin-Resource-Policy": "same-site",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cache-Control": "no-store",
}


class SecurityHeadersMiddleware:
    """Adds the security headers above to every response, replacing any a view set."""

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponseBase]) -> None:
        """Wrap the next handler in the chain."""
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponseBase:
        """Let the request through, then stamp the headers on its response."""
        response = self.get_response(request)
        for name, value in SECURITY_HEADERS.items():
            response[name] = value
        return response
