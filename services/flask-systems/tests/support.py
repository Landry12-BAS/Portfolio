"""Helpers the Flask systems' tests share: a platform of fakes, a fake chat, a span store and visitor tokens.

Nothing here calls a provider. The gateway is replaced by `FakeChat`, which answers each
alias from a script and remembers every request, and the span store by an in-memory one.
"""

import base64
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime

import jwt
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from sqlalchemy import Engine

from config.environment import Environment, read_environment
from core.platform import Platform
from core.structured import ChatMessage, ChatModels, Completion
from lb_common.gateway import GatewayResponseError
from lb_common.run import Run, current_run
from lb_common.tracing import Span, Tracer

# A complete, valid environment; each test changes what it is about.
VALID_ENVIRONMENT = {
    "FLASK_ALLOWED_HOSTS": "localhost",
    "LB_DATABASE_URL": "postgres://lb:lb@127.0.0.1:5432/lb",
    "LB_REDIS_URL": "redis://127.0.0.1:6379/0",
}
# The day tests treat as today, so every date a test checks is the same on every run.
TODAY = datetime(2026, 10, 1, 9, 30, tzinfo=UTC)
SESSION = "session-of-sam-visitor-0001"


def make_environment(**variables: str) -> Environment:
    """Read a valid environment, with the given variables added or replaced."""
    return read_environment({**VALID_ENVIRONMENT, **variables})


class MemorySpanWriter:
    """Keeps finished spans in memory, for the tests to read."""

    def __init__(self) -> None:
        """Start with no spans."""
        self.spans: list[Span] = []

    def write(self, spans: Sequence[Span]) -> None:
        """Keep the spans."""
        self.spans.extend(spans)

    def names(self) -> list[str]:
        """Return the spans' names, in the order they finished."""
        return [span.name for span in self.spans]

    def named(self, name: str) -> Span:
        """Return the one span with this name."""
        return next(span for span in self.spans if span.name == name)


@dataclass
class FakeChat:
    """Stands in for the gateway's chat: replies to each alias from a script, and remembers every request and run.

    A reply that is an exception is raised instead of returned, as the gateway's errors are.
    """

    replies: dict[str, list[str | Exception]]
    requests: list[tuple[str, list[ChatMessage]]] = field(default_factory=list)
    runs: list[Run | None] = field(default_factory=list)
    output_caps: dict[str, int] = field(default_factory=dict)
    timeouts: list[float | None] = field(default_factory=list)

    def complete(
        self, alias: str, messages: Sequence[ChatMessage], max_tokens: int, timeout_seconds: float | None = None
    ) -> Completion:
        """Return the alias's next scripted reply, or raise it; remember the request, the run and the caps."""
        self.requests.append((alias, list(messages)))
        self.runs.append(current_run())
        self.output_caps[alias] = max_tokens
        self.timeouts.append(timeout_seconds)
        reply = self.replies[alias].pop(0)
        if isinstance(reply, Exception):
            raise reply
        return Completion(text=reply, model=f"test/{alias}")

    def asked(self, alias: str) -> list[list[ChatMessage]]:
        """Return the messages of every request made to one alias."""
        return [messages for requested, messages in self.requests if requested == alias]

    def calls(self) -> int:
        """Count the requests made so far, across every alias."""
        return len(self.requests)


def unavailable() -> GatewayResponseError:
    """Make the error a gateway failure raises, for scripting a failed call."""
    return GatewayResponseError("The gateway is unavailable.")


def make_platform(
    chat: ChatModels | None = None,
    writer: MemorySpanWriter | None = None,
    engines: Mapping[str, Engine] | None = None,
    environment: Environment | None = None,
) -> Platform:
    """Build a platform of fakes: a fixed clock, the given chat and span store, and the given engines."""
    return Platform(
        environment=environment or make_environment(),
        engines=engines or {},
        chat=chat,
        tracer=Tracer(writer or MemorySpanWriter()),
        clock=lambda: TODAY,
    )


class SiteKey:
    """The site's signing key: gives the service its public half, and mints visitor tokens as the site does."""

    def __init__(self) -> None:
        """Make a fresh Ed25519 key, so no test depends on a key in the repository."""
        self._key = Ed25519PrivateKey.generate()
        raw = self._key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        self.public = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    def mint(self, system: str = "lb-05", session: str = SESSION, lifetime: int = 300) -> str:
        """Mint a visitor token for one system, valid for `lifetime` seconds."""
        now = int(time.time())
        claims = {"iss": "lb-web", "aud": system, "sub": session, "iat": now, "exp": now + lifetime}
        return jwt.encode(claims, self._key, algorithm="EdDSA")

    def headers(self, system: str = "lb-05", session: str = SESSION) -> dict[str, str]:
        """Return the Authorization header a visitor's request carries."""
        return {"Authorization": f"Bearer {self.mint(system, session)}"}
