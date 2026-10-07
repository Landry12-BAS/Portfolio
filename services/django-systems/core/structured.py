"""Structured answers from chat models: ask for JSON, check it against a schema, repair it once.

Every structured answer in the Django systems comes through here, so model output is
always treated as untrusted input (AGENTS.md): the reply must hold one JSON object that
its Pydantic schema accepts. Anything else earns one repair request quoting what was
wrong, and a second failure is an error for the caller to route.

No response_format is sent. The gateway's fallback chains cross providers whose JSON
modes differ, and Groq's strict mode doesn't combine with tools or streaming; the
schema check here holds on every provider (docs/STACK.md, Structured output).
"""

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, Protocol

from openai import omit
from openai.types.chat import (
    ChatCompletionAssistantMessageParam,
    ChatCompletionMessageParam,
    ChatCompletionSystemMessageParam,
    ChatCompletionUserMessageParam,
)
from pydantic import BaseModel, ValidationError

from lb_common.gateway import Gateway

# A reply wrapped in a Markdown code fence, as models often send JSON.
FENCED = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)
# How much of a malformed reply is quoted back in the repair request.
MAX_ECHO_CHARS = 4_000
# How many validation problems the repair request lists.
MAX_PROBLEMS = 6
# How long a reasoning model thinks before it answers, in the values the gateway accepts. The gateway drops it
# for a model that doesn't reason.
type ReasoningEffort = Literal["low", "medium", "high"]
# What the model is told when its reply doesn't fit the schema.
REPAIR_REQUEST = (
    "Your reply wasn't a JSON object matching the required format. Problems:\n{problems}\n"
    "Reply again with only the corrected JSON object."
)


@dataclass(frozen=True)
class ChatMessage:
    """One message of a chat request."""

    role: Literal["system", "user", "assistant"]
    content: str


@dataclass(frozen=True)
class Completion:
    """A model's reply, and the model that wrote it, as the gateway reports it."""

    text: str
    model: str


class ChatModels(Protocol):
    """Chat completions by virtual model alias, such as `lb-fast`."""

    def complete(
        self,
        alias: str,
        messages: Sequence[ChatMessage],
        max_tokens: int,
        reasoning: ReasoningEffort | None = None,
    ) -> Completion:
        """Return the model's reply to the messages; `reasoning` sets how long a reasoning model thinks first.

        None leaves the provider's default.
        """
        ...


class GatewayChat:
    """Chat completions through the AI gateway, at temperature 0 for repeatable answers."""

    def __init__(self, gateway: Gateway) -> None:
        """Send completions through `gateway`."""
        self.gateway = gateway

    def complete(
        self,
        alias: str,
        messages: Sequence[ChatMessage],
        max_tokens: int,
        reasoning: ReasoningEffort | None = None,
    ) -> Completion:
        """Ask the alias for one reply, without streaming, sending the reasoning effort only when one is asked for."""
        reply = self.gateway.openai.chat.completions.create(
            model=alias,
            messages=[openai_message(message) for message in messages],
            max_tokens=max_tokens,
            temperature=0,
            reasoning_effort=reasoning if reasoning is not None else omit,
        )
        text = reply.choices[0].message.content if reply.choices else None
        return Completion(text=text or "", model=reply.model)


def openai_message(message: ChatMessage) -> ChatCompletionMessageParam:
    """Turn a message into the OpenAI SDK's typed form for its role."""
    if message.role == "system":
        return ChatCompletionSystemMessageParam(role="system", content=message.content)
    if message.role == "assistant":
        return ChatCompletionAssistantMessageParam(role="assistant", content=message.content)
    return ChatCompletionUserMessageParam(role="user", content=message.content)


class StructuredOutputError(Exception):
    """The model's reply didn't match the schema, even after one repair."""


@dataclass(frozen=True)
class StructuredAnswer[Answer: BaseModel]:
    """A validated answer, the model that gave it, and how many replies it took (1 or 2)."""

    value: Answer
    model: str
    attempts: int


def ask_for_json[Answer: BaseModel](
    models: ChatModels,
    alias: str,
    messages: Sequence[ChatMessage],
    schema: type[Answer],
    max_tokens: int,
    reasoning: ReasoningEffort | None = None,
) -> StructuredAnswer[Answer]:
    """Ask for a JSON answer that `schema` accepts, with one repair request if the first reply doesn't fit.

    A reasoning model's thinking counts against `max_tokens`, so a caller whose answers were cut off by it
    asks for less thinking with `reasoning`; the repair is asked the same way.
    """
    first = models.complete(alias, messages, max_tokens, reasoning)
    try:
        return StructuredAnswer(parse_answer(first.text, schema), first.model, attempts=1)
    except (ValueError, ValidationError) as error:
        problems = describe_problems(error)
    repair = [
        *messages,
        ChatMessage("assistant", first.text[:MAX_ECHO_CHARS]),
        ChatMessage("user", REPAIR_REQUEST.format(problems=problems)),
    ]
    second = models.complete(alias, repair, max_tokens, reasoning)
    try:
        return StructuredAnswer(parse_answer(second.text, schema), second.model, attempts=2)
    except (ValueError, ValidationError) as error:
        raise StructuredOutputError(
            f"{schema.__name__} didn't validate after one repair: {describe_problems(error)}"
        ) from None


def parse_answer[Answer: BaseModel](text: str, schema: type[Answer]) -> Answer:
    """Find the one JSON object in a reply, bare or in a code fence, and validate it."""
    return schema.model_validate_json(json_object_in(text))


def json_object_in(text: str) -> str:
    """Return the JSON object a reply holds, from its first `{` to its last `}`, refusing anything else."""
    stripped = text.strip()
    fenced = FENCED.search(stripped)
    if fenced:
        stripped = fenced.group(1)
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start == -1 or end < start:
        raise ValueError("The reply holds no JSON object.")
    candidate = stripped[start : end + 1]
    json.loads(candidate)
    return candidate


def describe_problems(error: Exception) -> str:
    """Put a parsing or validation failure in a few short lines for the repair request."""
    if isinstance(error, ValidationError):
        lines = [
            f"- {'.'.join(str(part) for part in issue['loc']) or 'the object'}: {issue['msg']}"
            for issue in error.errors()[:MAX_PROBLEMS]
        ]
        return "\n".join(lines)
    return f"- {error}"
