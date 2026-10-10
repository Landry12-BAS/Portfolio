"""Structured answers from chat models: ask for JSON, check it against a schema, repair it once.

Every structured answer in the Flask systems comes through here, so model output is
always treated as untrusted input (AGENTS.md): the reply must hold one JSON object that
its Pydantic schema accepts. Anything else earns one repair request quoting what was
wrong, and a second failure is an error for the caller to route.

No response_format is sent. The gateway's fallback chains cross providers whose JSON
modes differ, and Groq's strict mode doesn't combine with tools or streaming; the
schema check here holds on every provider (docs/STACK.md, Structured output). This is
the Flask-side twin of services/django-systems/core/structured.py: the two services
share no code, and the contract is the same.
"""

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from openai.types.chat import (
    ChatCompletionAssistantMessageParam,
    ChatCompletionContentPartImageParam,
    ChatCompletionContentPartTextParam,
    ChatCompletionMessageParam,
    ChatCompletionSystemMessageParam,
    ChatCompletionUserMessageParam,
)
from pydantic import BaseModel, ValidationError

from lb_common.gateway import Gateway, GuardVerdict

# A reply wrapped in a Markdown code fence, as models often send JSON.
FENCED = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)
# How much of a malformed reply is quoted back in the repair request.
MAX_ECHO_CHARS = 4_000
# How many validation problems the repair request lists.
MAX_PROBLEMS = 6
# What the model is told when its reply doesn't fit the schema.
REPAIR_REQUEST = (
    "Your reply wasn't a JSON object matching the required format. Problems:\n{problems}\n"
    "Reply again with only the corrected JSON object."
)


# The only form a picture may take in a request: inline, as a data URL. The gateway refuses a link, and so does
# this: a link would make a provider fetch whatever address a document managed to name.
IMAGE_DATA_URL = re.compile(r"^data:image/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$")


@dataclass(frozen=True)
class ChatMessage:
    """One message of a chat request, with the pictures a user message sends along (as base64 data URLs)."""

    role: Literal["system", "user", "assistant"]
    content: str
    images: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        """Refuse a picture on a message that isn't the user's, and any picture that isn't an inline data URL."""
        if self.images and self.role != "user":
            raise ValueError("Only a user message carries pictures.")
        if not all(IMAGE_DATA_URL.fullmatch(image) for image in self.images):
            raise ValueError("A picture is sent inline, as a base64 data URL of a JPEG, PNG or WebP.")


@dataclass(frozen=True)
class Completion:
    """A model's reply, and the model that wrote it, as the gateway reports it."""

    text: str
    model: str


class ChatModels(Protocol):
    """Chat completions by virtual model alias, such as `lb-fast`."""

    def complete(
        self, alias: str, messages: Sequence[ChatMessage], max_tokens: int, timeout_seconds: float | None = None
    ) -> Completion:
        """Return the model's reply to the messages, waiting at most `timeout_seconds` when it is given."""
        ...


class GatewayChat:
    """Chat completions through the AI gateway, at temperature 0 for repeatable answers."""

    def __init__(self, gateway: Gateway) -> None:
        """Send completions through `gateway`."""
        self.gateway = gateway

    def complete(
        self, alias: str, messages: Sequence[ChatMessage], max_tokens: int, timeout_seconds: float | None = None
    ) -> Completion:
        """Ask the alias for one reply, without streaming, waiting at most `timeout_seconds` when it is given."""
        options: dict[str, Any] = {}
        if timeout_seconds is not None:
            options["timeout"] = timeout_seconds
        reply = self.gateway.openai.chat.completions.create(
            model=alias,
            messages=[openai_message(message) for message in messages],
            max_tokens=max_tokens,
            temperature=0,
            **options,
        )
        text = reply.choices[0].message.content if reply.choices else None
        return Completion(text=text or "", model=reply.model)


class InjectionGuard(Protocol):
    """The gateway's prompt-injection check (`lb-guard`), for a system that reads text it did not write."""

    def check(self, text: str) -> GuardVerdict:
        """Say whether a text looks like an attempt to hijack a model; an `openai` error means no check was made."""
        ...


class GatewayGuard:
    """The injection check through the AI gateway."""

    def __init__(self, gateway: Gateway) -> None:
        """Send checks through `gateway`."""
        self.gateway = gateway

    def check(self, text: str) -> GuardVerdict:
        """Ask the gateway's guard about a text."""
        return self.gateway.guard(text)


def openai_message(message: ChatMessage) -> ChatCompletionMessageParam:
    """Turn a message into the OpenAI SDK's typed form for its role."""
    if message.role == "system":
        return ChatCompletionSystemMessageParam(role="system", content=message.content)
    if message.role == "assistant":
        return ChatCompletionAssistantMessageParam(role="assistant", content=message.content)
    if not message.images:
        return ChatCompletionUserMessageParam(role="user", content=message.content)
    parts: list[ChatCompletionContentPartTextParam | ChatCompletionContentPartImageParam] = [
        ChatCompletionContentPartTextParam(type="text", text=message.content)
    ]
    parts.extend(
        ChatCompletionContentPartImageParam(type="image_url", image_url={"url": image}) for image in message.images
    )
    return ChatCompletionUserMessageParam(role="user", content=parts)


class StructuredOutputError(Exception):
    """The model's reply didn't match the schema, even after one repair."""


@dataclass(frozen=True)
class StructuredAnswer[Answer: BaseModel]:
    """A validated answer, the model that gave it, and how many replies it took (1 or 2)."""

    value: Answer
    model: str
    attempts: int
    # The reply the answer was parsed from, so a caller can quote it back in a follow-up request.
    reply: str


def ask_for_json[Answer: BaseModel](
    models: ChatModels,
    alias: str,
    messages: Sequence[ChatMessage],
    schema: type[Answer],
    max_tokens: int,
    repair: bool = True,
    echo_chars: int = MAX_ECHO_CHARS,
) -> StructuredAnswer[Answer]:
    """Ask for a JSON answer that `schema` accepts, with one repair request if the first reply doesn't fit.

    A caller that has no model call to spare passes `repair=False`, and a caller whose prompt has
    little room left passes a smaller `echo_chars`, which is how much of the bad reply the repair
    request quotes back. A caller that must bound the wait wraps `models` in one that sets the
    timeout of each call.
    """
    first = models.complete(alias, messages, max_tokens)
    try:
        return StructuredAnswer(parse_answer(first.text, schema), first.model, attempts=1, reply=first.text)
    except (ValueError, ValidationError) as error:
        problems = describe_problems(error)
    if not repair:
        raise StructuredOutputError(f"{schema.__name__} didn't validate: {problems}") from None
    repair_messages = [
        *messages,
        ChatMessage("assistant", first.text[:echo_chars]),
        ChatMessage("user", REPAIR_REQUEST.format(problems=problems)),
    ]
    second = models.complete(alias, repair_messages, max_tokens)
    try:
        return StructuredAnswer(parse_answer(second.text, schema), second.model, attempts=2, reply=second.text)
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
