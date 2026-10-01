"""Blocking work from async code: on a worker thread of its own, with that thread's database connections closed after.

A model call blocks for seconds, and a database query blocks for a moment, and neither may block
the event loop that serves every open WebSocket. `run_blocking` runs such work on a worker thread.

It deliberately is not Channels' `database_sync_to_async`, which by default runs everything on one
thread shared by the whole process: one visitor's slow model call would then hold up every other
visitor's database work. And it closes the thread's connections when the work is done, so a pool
thread never sits on an idle connection, and a thread that ends doesn't leave one open behind it.
Reconnecting costs a few milliseconds, which is nothing next to the work it wraps.
"""

from collections.abc import Callable
from functools import wraps

from asgiref.sync import sync_to_async
from django.db import connections


def closing_connections[**Parameters, Result](work: Callable[Parameters, Result]) -> Callable[Parameters, Result]:
    """Wrap blocking work so the connections of the thread it runs on are closed when it ends, however it ends."""

    @wraps(work)
    def run(*args: Parameters.args, **kwargs: Parameters.kwargs) -> Result:
        """Do the work, then close this thread's connections."""
        try:
            return work(*args, **kwargs)
        finally:
            connections.close_all()

    return run


async def run_blocking[**Parameters, Result](
    work: Callable[Parameters, Result], *args: Parameters.args, **kwargs: Parameters.kwargs
) -> Result:
    """Run blocking `work` on a worker thread, without blocking the event loop, and return what it returns."""
    on_a_thread = sync_to_async(closing_connections(work), thread_sensitive=False)
    return await on_a_thread(*args, **kwargs)
