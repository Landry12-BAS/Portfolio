"""Helpers LB-10's tests share: a fake eval chat scripted per alias, and a pack and prompt to run it on."""

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

from core.structured import ChatMessage
from lb10.chat import EvalCompletion, ToolCall
from lb10.packs import EvalPack, ToolSpec, read_packs
from lb10.repository import ResultKey, StoredResult
from lb_common.run import Run, current_run

# The pack most tests run on: LB-01's classifier, whose output is one small JSON object.
CLASSIFIER = "lb01-classifier"


def committed_pack(name: str = CLASSIFIER) -> EvalPack:
    """Read one of the committed packs."""
    return read_packs()[name]


def classification(category: str = "late", order: str | None = None) -> str:
    """Write a classifier reply the pack's graders read."""
    order_json = f'"{order}"' if order else "null"
    return (
        f'{{"category": "{category}", "order_number": {order_json}, "senior_agent": null, '
        f'"search_query": "{category} parcel policy"}}'
    )


def right_answer(pack: EvalPack, case_id: str) -> str:
    """Write the reply that passes a classifier case: its expected category and order number."""
    case = pack.case_by_id(case_id)
    categories = case.expected.get("category") or ["other"]
    reply = classification(str(categories[0]), case.expected.get("order_number"))
    if case.expected.get("reason") == "senior_agent":
        reply = reply.replace('"senior_agent": null', '"senior_agent": "legal"')
    return reply


@dataclass
class FakeEvalChat:
    """Stands in for the gateway: answers by a function of the alias and the messages, and remembers every call.

    `answer` returns the reply's text (or raises an exception, as the gateway's errors are). Replies carry
    fixed tokens and a latency the test chooses.
    """

    answer: Callable[[str, Sequence[ChatMessage]], str | Exception]
    latency_ms: int = 120
    calls: list[tuple[str, list[ChatMessage], list[ToolSpec]]] = field(default_factory=list)
    runs: list[Run | None] = field(default_factory=list)
    timeouts: list[float] = field(default_factory=list)
    output_caps: list[int] = field(default_factory=list)

    def complete(
        self,
        alias: str,
        messages: Sequence[ChatMessage],
        tools: Sequence[ToolSpec],
        max_tokens: int,
        timeout_seconds: float,
    ) -> EvalCompletion:
        """Answer from the function, remembering the call, the run it was made in, and the timeout given."""
        self.calls.append((alias, list(messages), list(tools)))
        self.runs.append(current_run())
        self.timeouts.append(timeout_seconds)
        self.output_caps.append(max_tokens)
        reply = self.answer(alias, messages)
        if isinstance(reply, Exception):
            raise reply
        return EvalCompletion(
            text=reply,
            tool_calls=(),
            model=f"test/{alias}",
            input_tokens=100,
            output_tokens=20,
            latency_ms=self.latency_ms,
        )

    def asked(self, alias: str) -> list[list[ChatMessage]]:
        """Return the messages of every call made to one alias."""
        return [messages for requested, messages, _tools in self.calls if requested == alias]


def tool_completion(name: str, arguments: dict[str, object], text: str = "") -> EvalCompletion:
    """Build a completion that answered with one tool call."""
    return EvalCompletion(
        text=text,
        tool_calls=(ToolCall(name, arguments),),
        model="test/tools",
        input_tokens=50,
        output_tokens=10,
        latency_ms=90,
    )


@dataclass
class MemoryResultStore:
    """A result cache in memory, for the pipeline's unit tests."""

    rows: dict[ResultKey, StoredResult] = field(default_factory=dict)

    def cached_results(self, keys: Sequence[ResultKey]) -> dict[ResultKey, StoredResult]:
        """Return the usable results among the keys."""
        return {key: self.rows[key] for key in keys if key in self.rows and self.rows[key].error is None}

    def store_result(self, result: StoredResult) -> None:
        """Keep a result."""
        self.rows[result.key] = result
