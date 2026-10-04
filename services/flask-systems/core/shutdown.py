"""What a worker process does as it stops: each system's own last duties, run before the process finishes.

A gunicorn worker that is told to stop leaves its request threads to finish, and then exits. A system that does work
outside requests (LB-03 reads documents on a loop of its own, for up to a couple of minutes each) must end that work
cleanly: give a document a few seconds, then end it as interrupted and settle the visitor, instead of leaving it to be
found lost. That has to happen while the process can still use its thread pools, which is before Python starts to
tear the interpreter down, so it can't wait for `atexit`: gunicorn's `worker_exit` hook runs it (gunicorn.conf.py).

A system registers a callback here when it starts its background work. Callbacks run last to first, each in its own
guard, so one that fails never stops the others.
"""

import logging
from collections.abc import Callable

from core.errors import describe_failure

logger = logging.getLogger(__name__)

_callbacks: list[Callable[[], object]] = []


def register(callback: Callable[[], object]) -> None:
    """Run `callback` when the worker stops."""
    _callbacks.append(callback)


def run_all() -> None:
    """Run every registered callback, the last registered first; a failure is logged by its type and place."""
    while _callbacks:
        callback = _callbacks.pop()
        try:
            callback()
        except Exception as error:  # noqa: BLE001 - one system failing to wind down must not stop the others
            logger.error("A shutdown step failed: %s", describe_failure(error))
