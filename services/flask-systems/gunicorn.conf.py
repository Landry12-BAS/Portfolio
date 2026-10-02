"""Gunicorn settings for the Flask systems: threaded workers, small request limits, and no personal data in logs.

LB-05 is synchronous on purpose (docs/STACK.md, Flask systems): its queries are short and
CPU-bound, and threads cover the wait for a model, so the worker class is `gthread`. One
worker process holds the DuckDB limits (its memory limit is per process) and its threads
share them. The app is never preloaded: DuckDB and the database pool must be made after
the fork, in the worker that uses them.
"""

import os

bind = os.environ.get("GUNICORN_BIND", "127.0.0.1:8102")
worker_class = "gthread"
workers = int(os.environ.get("GUNICORN_WORKERS", "1"))
threads = int(os.environ.get("GUNICORN_THREADS", "8"))
preload_app = False
# Gunicorn's admin control socket is a channel nobody here uses: left closed (least privilege).
control_socket_disable = True

# A question's own deadline (lb05.pipeline) is shorter than this; it only bounds a stuck worker.
timeout = 120
graceful_timeout = 30
keepalive = 5
# Replace each worker now and then, so a slow leak can never grow into an outage.
max_requests = 2_000
max_requests_jitter = 200

# Requests are small JSON documents (an upload is a body, not a header: its size is limited by the route that takes
# it); a larger line, header or field is refused outright.
limit_request_line = 2_048
limit_request_fields = 40
limit_request_field_size = 4_096

# Only the reverse proxy in front of the service may say which scheme a request used.
forwarded_allow_ips = os.environ.get("GUNICORN_FORWARDED_ALLOW_IPS", "127.0.0.1")
worker_tmp_dir = "/dev/shm"  # noqa: S108 - gunicorn's own heartbeat files, in memory

# One line per request: method, path (never the query string), status and seconds. No
# address, header or body: IP addresses are never kept in the clear (docs/SECURITY.md).
accesslog = "-"
access_log_format = "%(m)s %(U)s %(s)s %(L)s"
errorlog = "-"
loglevel = "info"


def worker_exit(server: object, worker: object) -> None:  # noqa: ARG001 - gunicorn's hook signature
    """Let each system end the work its worker was doing, before the process finishes (core/shutdown.py).

    Imported here, not at the top: this file is read by the gunicorn master, which must not load the service.
    """
    from core.shutdown import run_all

    run_all()
