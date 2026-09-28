"""The run a piece of work belongs to, and the span it is currently inside.

A run is one visitor action, such as filing a ticket, from start to finish. The
system's own steps and every model call behind them are recorded against the run's ID,
so the Scope can draw the whole trace, and the gateway counts the run's calls against
its quotas.

The current run and span live in context variables. They follow the code through
ordinary calls and into asyncio tasks, so the gateway client can label every call
without the run being passed along by hand. Start a run with `run_scope()`; the tracer
opens spans inside it.
"""

import re
import secrets
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Literal

# Whose content a run carries: a visitor's own input, or the site's synthetic samples.
type DataClass = Literal["visitor", "synthetic"]
DATA_CLASSES: tuple[DataClass, ...] = ("visitor", "synthetic")

# The formats the gateway accepts (services/gateway/src/call.ts). ASCII only, because
# Python's \w would otherwise match accented letters that the gateway refuses.
SYSTEM_KEY = re.compile(r"lb-\d{2}", re.ASCII)
RUN_ID = re.compile(r"[\w-]{8,64}", re.ASCII)
SESSION_KEY = re.compile(r"[\w-]{16,128}", re.ASCII)
SPAN_ID = re.compile(r"[0-9a-f]{16}")


@dataclass(frozen=True, slots=True)
class Run:
    """One visitor action from start to finish.

    `system` is a part number such as `lb-01`. `session` is the visitor's hashed session
    key, never the raw cookie: a visitor run must have one, so the visitor's daily quota
    applies. Runs over synthetic samples have none.
    """

    system: str
    run_id: str
    data_class: DataClass = "visitor"
    session: str | None = None

    def __post_init__(self) -> None:
        """Check every field against the gateway's rules, so a bad run fails before its first call."""
        if not SYSTEM_KEY.fullmatch(self.system):
            raise ValueError(f"{self.system!r} is not a system part number such as lb-01.")
        if not RUN_ID.fullmatch(self.run_id):
            raise ValueError("A run ID is 8 to 64 letters, digits, underscores or hyphens.")
        if self.data_class not in DATA_CLASSES:
            raise ValueError(f"{self.data_class!r} is not a data class: use visitor or synthetic.")
        if self.session is not None and not SESSION_KEY.fullmatch(self.session):
            raise ValueError("A session key is 16 to 128 letters, digits, underscores or hyphens.")
        if self.data_class == "visitor" and self.session is None:
            raise ValueError("A visitor run needs the visitor's session key, so their daily quota applies.")


def new_run_id() -> str:
    """Make a random run ID: 22 characters, safe in URLs and in Redis keys."""
    return secrets.token_urlsafe(16)


_current_run: ContextVar[Run | None] = ContextVar("lb_current_run", default=None)
_current_span_id: ContextVar[str | None] = ContextVar("lb_current_span_id", default=None)


def current_run() -> Run | None:
    """Return the run the code is running in, or None outside any run."""
    return _current_run.get()


def current_span_id() -> str | None:
    """Return the ID of the innermost open span, or None when no span is open."""
    return _current_span_id.get()


@contextmanager
def run_scope(run: Run) -> Iterator[Run]:
    """Make `run` the current run inside the `with` block, starting with no open span."""
    run_token = _current_run.set(run)
    span_token = _current_span_id.set(None)
    try:
        yield run
    finally:
        _current_span_id.reset(span_token)
        _current_run.reset(run_token)


@contextmanager
def span_scope(span_id: str) -> Iterator[str]:
    """Make `span_id` the innermost open span inside the `with` block.

    The tracer calls this; model calls made inside the block nest under the span.
    """
    if not SPAN_ID.fullmatch(span_id):
        raise ValueError("A span ID is 16 lowercase hex digits.")
    token = _current_span_id.set(span_id)
    try:
        yield span_id
    finally:
        _current_span_id.reset(token)
