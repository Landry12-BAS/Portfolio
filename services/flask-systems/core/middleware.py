"""Security headers on every response of the Flask systems (docs/SECURITY.md, section 3).

The service answers JSON, never pages, so its content security policy allows nothing at
all, and no response may be cached: they carry a visitor's own data. These are the same
headers the Django systems send (services/django-systems/core/middleware.py).
"""

from flask import Flask, Response

SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Cross-Origin-Opener-Policy": "same-origin",
    # The site calls the API from its own subdomain.
    "Cross-Origin-Resource-Policy": "same-site",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
}


def add_security_headers(response: Response) -> Response:
    """Stamp the security headers on a response, replacing any a view set."""
    for name, value in SECURITY_HEADERS.items():
        response.headers[name] = value
    return response


def register_security_headers(app: Flask) -> None:
    """Add the security headers to every response the app sends, errors included."""
    app.after_request(add_security_headers)
