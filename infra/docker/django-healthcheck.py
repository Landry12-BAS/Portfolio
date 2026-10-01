#!/usr/bin/env python
"""Container health check of the Django API: asks the service's own readiness route.

`/api/readyz` answers 200 only when every system's connection can run a query, so a
container with an unreachable database reports itself unhealthy and the deploy notices.
The request carries the first allowed host as its Host header, because Django answers
nothing else: ALLOWED_HOSTS holds only the public API hostname, which keeps Host-header
games out without opening the service to `localhost`.

Exit status 0 means healthy; any failure (refused connection, a 503, a timeout) is 1.
"""

import os
import sys
import urllib.error
import urllib.request

URL = "http://127.0.0.1:8000/api/readyz"
TIMEOUT_SECONDS = 4


def allowed_host() -> str:
    """Return the first host in DJANGO_ALLOWED_HOSTS, the name Django will accept."""
    hosts = [host.strip() for host in os.environ.get("DJANGO_ALLOWED_HOSTS", "").split(",") if host.strip()]
    if not hosts:
        raise SystemExit("DJANGO_ALLOWED_HOSTS is not set")
    return hosts[0]


def main() -> int:
    """Return 0 when the readiness route answers 200, and 1 for anything else."""
    request = urllib.request.Request(URL, headers={"Host": allowed_host()})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:  # noqa: S310 - a fixed http:// URL
            return 0 if response.status == 200 else 1
    except (urllib.error.URLError, TimeoutError, OSError):
        return 1


if __name__ == "__main__":
    sys.exit(main())
