"""Helpers the Django systems' tests share: stand-in vectors, and fakes of the gateway and the span store."""

from collections.abc import Sequence
from dataclasses import dataclass, field

from core.structured import ChatMessage, Completion
from lb01.models import EMBEDDING_DIMENSIONS
from lb_common.gateway import GatewayResponseError
from lb_common.run import Run, current_run
from lb_common.tracing import Span


def one_hot(position: int) -> list[float]:
    """Make a unit vector along one dimension: a stand-in embedding that is close only to itself."""
    vector = [0.0] * EMBEDDING_DIMENSIONS
    vector[position] = 1.0
    return vector


@dataclass(frozen=True)
class FakeVerdict:
    """The injection screen's verdict."""

    flagged: bool
    score: float


@dataclass(frozen=True)
class FakeRanked:
    """One document's place in a ranking."""

    index: int
    relevance_score: float


@dataclass
class FakeGateway:
    """Stands in for the gateway's guard, embedding and rerank calls. The reranker keeps the order it is given.

    The screen flags every text when `flag` is set, or the texts containing `flag_when`.
    """

    flag: bool = False
    flag_when: str | None = None
    guard_fails: bool = False
    embed_fails: bool = False
    rerank_fails: bool = False
    guarded: list[str] = field(default_factory=list)
    rerank_queries: list[str] = field(default_factory=list)

    def guard(self, text: str) -> FakeVerdict:
        """Screen a text, or fail like an unavailable classifier."""
        self.guarded.append(text)
        if self.guard_fails:
            raise GatewayResponseError("lb-guard is unavailable.")
        flagged = self.flag or (self.flag_when is not None and self.flag_when in text)
        return FakeVerdict(flagged=flagged, score=0.99 if flagged else 0.01)

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        """Embed the query, or fail."""
        if self.embed_fails:
            raise GatewayResponseError("lb-embed is unavailable.")
        return [one_hot(0) for _ in texts]

    def rerank(self, query: str, documents: Sequence[str]) -> list[FakeRanked]:
        """Keep the documents' order, with falling scores, or fail; remember the query."""
        self.rerank_queries.append(query)
        if self.rerank_fails:
            raise GatewayResponseError("lb-rerank is unavailable.")
        return [FakeRanked(index, 1.0 - index / 10) for index in range(len(documents))]


@dataclass
class FakeChat:
    """Stands in for the gateway's chat: replies to each alias from a script, and remembers every request and run."""

    replies: dict[str, list[str]]
    fails: bool = False
    requests: list[tuple[str, list[ChatMessage]]] = field(default_factory=list)
    runs: list[Run | None] = field(default_factory=list)
    output_caps: dict[str, int] = field(default_factory=dict)

    def complete(self, alias: str, messages: Sequence[ChatMessage], max_tokens: int) -> Completion:
        """Return the alias's next scripted reply, or fail like the gateway; remember the request."""
        self.requests.append((alias, list(messages)))
        self.runs.append(current_run())
        self.output_caps[alias] = max_tokens
        if self.fails:
            raise GatewayResponseError("The gateway is unavailable.")
        return Completion(text=self.replies[alias].pop(0), model=f"test/{alias}")

    def asked(self, alias: str) -> list[list[ChatMessage]]:
        """Return the messages of every request made to one alias."""
        return [messages for requested, messages in self.requests if requested == alias]


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
