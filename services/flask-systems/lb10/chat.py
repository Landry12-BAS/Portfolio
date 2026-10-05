"""Model calls as Eval Lab makes them: pinned, timed, counted in tokens, and with tool calls kept as data.

An eval needs more from a call than the pipelines do: how long it took, how many tokens it cost, and the tool
calls a tool-calling prompt answered with, as data to grade. So the lab has a chat protocol of its own, next to
`core.structured.ChatModels`: `complete` takes the alias and the tools, and returns the reply's text or its tool
calls with the model, the tokens the provider reported and the wall-clock latency. Every call goes through the
gateway (`GatewayEvalChat`), labelled with the current run so quotas and the trace apply; tests use a fake.

A reply is untrusted text. It is graded as it is, never repaired: a malformed answer is a failed case, which is
part of what a prompt is measured on, and no call is spent twice.
"""

import json
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from openai.types.chat import ChatCompletionMessageParam, ChatCompletionToolParam

from core.structured import ChatMessage, openai_message
from lb10.packs import OutputKind, ToolSpec
from lb_common.gateway import Gateway

# How much of a tool call's arguments the output keeps: enough to grade, never a flood.
MAX_ARGUMENTS_CHARS = 4_000


@dataclass(frozen=True)
class ToolCall:
    """One tool call a model answered with: the tool's name and its arguments, parsed when they are JSON."""

    name: str
    arguments: Any


@dataclass(frozen=True)
class EvalCompletion:
    """A model's reply as the lab records it: text or tool calls, who answered, what it cost and how long it took."""

    text: str
    tool_calls: tuple[ToolCall, ...]
    model: str
    input_tokens: int
    output_tokens: int
    latency_ms: int

    def output(self, kind: OutputKind) -> str:
        """Return the text the graders read: the reply itself, or for a tool-calling prompt the JSON of its calls.

        A tool-calling prompt's output always has the same shape, calls or none, so a rule can say "no tool
        was called" as `tool_call_count` 0.
        """
        if kind != "tool_calls":
            return self.text
        document = {
            "text": self.text,
            "tool_calls": [{"name": call.name, "arguments": call.arguments} for call in self.tool_calls],
            "tool_call_count": len(self.tool_calls),
        }
        return json.dumps(document, ensure_ascii=False)


class EvalChat(Protocol):
    """Pinned chat completions by eval alias, with tools when the pack has them."""

    def complete(
        self,
        alias: str,
        messages: Sequence[ChatMessage],
        tools: Sequence[ToolSpec],
        max_tokens: int,
        timeout_seconds: float,
    ) -> EvalCompletion:
        """Ask the alias for one reply, waiting at most `timeout_seconds`; a failure raises an `openai` error."""
        ...


def tool_parameter(tool: ToolSpec) -> ChatCompletionToolParam:
    """Describe a pack tool the way the OpenAI API takes it."""
    return {
        "type": "function",
        "function": {"name": tool.name, "description": tool.description, "parameters": tool.parameters},
    }


def parse_arguments(text: str) -> Any:
    """Parse a tool call's arguments as JSON, keeping the text when it is not JSON (the graders then fail it)."""
    cut = text[:MAX_ARGUMENTS_CHARS]
    try:
        return json.loads(cut)
    except ValueError:
        return cut


@dataclass
class GatewayEvalChat:
    """Chat completions through the AI gateway on the pinned eval aliases, at temperature 0."""

    gateway: Gateway
    clock: Any = field(default=time.perf_counter)

    def complete(
        self,
        alias: str,
        messages: Sequence[ChatMessage],
        tools: Sequence[ToolSpec],
        max_tokens: int,
        timeout_seconds: float,
    ) -> EvalCompletion:
        """Ask the alias for one reply, without streaming, and record what it cost and how long it took."""
        options: dict[str, Any] = {"timeout": timeout_seconds}
        if tools:
            options["tools"] = [tool_parameter(tool) for tool in tools]
        typed: list[ChatCompletionMessageParam] = [openai_message(message) for message in messages]
        started = self.clock()
        reply = self.gateway.openai.chat.completions.create(
            model=alias, messages=typed, max_tokens=max_tokens, temperature=0, **options
        )
        latency_ms = round((self.clock() - started) * 1000)
        message = reply.choices[0].message if reply.choices else None
        calls = tuple(
            ToolCall(call.function.name, parse_arguments(call.function.arguments))
            for call in (message.tool_calls if message is not None and message.tool_calls else [])
            if call.type == "function"
        )
        usage = reply.usage
        return EvalCompletion(
            text=(message.content if message is not None else None) or "",
            tool_calls=calls,
            model=reply.model,
            input_tokens=usage.prompt_tokens if usage is not None else 0,
            output_tokens=usage.completion_tokens if usage is not None else 0,
            latency_ms=latency_ms,
        )
