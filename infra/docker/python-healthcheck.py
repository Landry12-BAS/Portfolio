#!/usr/bin/env python
"""Container health check of the Python systems' APIs (Django and Flask): asks the service's own readiness route.

Run as `lb-healthcheck <port> <hosts variable>`, such as `lb-healthcheck 8000 DJANGO_ALLOWED_HOSTS`
or `lb-healthcheck 8102 FLASK_ALLOWED_HOSTS`. `/api/readyz` answers 200 only when every
system's connection can run a query (and, for LB-05, its data is in place), so a container with
an unreachable database or a missing dataset reports itself unhealthy and the deploy notices.
The request carries the first allowed host as its Host header, because both frameworks answer
nothing else: the allowed hosts hold only the public API hostname, which keeps Host-header games
out without opening the service to `localhost`.

Exit status 0 means healthy; any failure (refused connection, a 503, a timeout, a mistake in the
arguments) is 1, or a message and 1 for the arguments.
"""

import os
import sys
import urllib.error
import urllib.request

PATH = "/api/readyz"
TIMEOUT_SECONDS = 4


def allowed_host(variable: str) -> str:
    """Return the first host in the named variable, the name the service will accept."""
    hosts = [host.strip() for host in os.environ.get(variable, "").split(",") if host.strip()]
    if not hosts:
        raise SystemExit(f"{variable} is not set")
    return hosts[0]


def main(arguments: list[str]) -> int:
    """Return 0 when the readiness route answers 200, and 1 for anything else."""
    if len(arguments) != 2 or not arguments[0].isdigit():
        raise SystemExit("usage: lb-healthcheck <port> <name of the variable that lists the allowed hosts>")
    request = urllib.request.Request(
        f"http://127.0.0.1:{int(arguments[0])}{PATH}", headers={"Host": allowed_host(arguments[1])}
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:  # noqa: S310 - the same fixed URL
            return 0 if response.status == 200 else 1
    except (urllib.error.URLError, TimeoutError, OSError):
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
