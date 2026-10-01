"""Chat with tools, through the AI gateway: the part of tool calling that doesn't depend on any one system.

A model asked to use tools answers with text, with calls to the tools it was offered, or with
both. This module sends the request through `lb_common`'s gateway client and hands back what
the model said as plain values. It trusts none of it: a call's arguments are a string the
model wrote, so they come back as that string, for the system's own Pydantic schema to
validate (docs/STACK.md, Structured output: "Tool loops validate arguments with Zod or
Pydantic instead"), and a call to a tool the system never offered is the system's to refuse.

Like core/structured.py, it sends no response_format, since Groq's strict JSON mode doesn't
combine with tools, and it asks for temperature 0 so the same conversation gets the same
answer.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Literal, Protocol

from openai.types.chat import (
    ChatCompletionAssistantMessageParam,
    ChatCompletionFunctionToolParam,
    ChatCompletionMessageFunctionToolCall,
    ChatCompletionMessageFunctionToolCallParam,
    ChatCompletionMessageParam,
    ChatCompletionSystemMessageParam,
    ChatCompletionToolMessageParam,
    ChatCompletionUserMessageParam,
)
from openai.types.shared_params import FunctionDefinition

from lb_common.gateway import Gateway

# The gateway accepts tool call IDs of 1 to 128 characters; a provider that sends none gets one made here.
MAX_CALL_ID_LENGTH = 128


@dataclass(frozen=True)
class ToolDefinition:
    """A tool the model may call: its name, what it does, and its arguments as a JSON Schema."""

    name: str
    description: str
    parameters: dict[str, object]


@dataclass(frozen=True)
class ToolCall:
    """A call the model made: the ID to answer it under, the tool's name, and the arguments as the model wrote them."""

    id: str
    name: str
    arguments: str


@dataclass(frozen=True)
class ToolChatMessage:
    """One message of a tool conversation.

    An assistant message may carry the calls it made, and a `tool` message answers one
    call, by its ID, with the tool's result as text.
    """

    role: Literal["system", "user", "assistant", "tool"]
    content: str | None = None
    tool_calls: tuple[ToolCall, ...] = field(default_factory=tuple)
    tool_call_id: str | None = None


@dataclass(frozen=True)
class ToolReply:
    """What the model answered: some text, perhaps empty, any calls it made, and the model that wrote it."""

    text: str
    calls: tuple[ToolCall, ...]
    model: str


class ToolChat(Protocol):
    """Chat completions by virtual model alias, with tools the model may call."""

    def complete(
        self, alias: str, messages: Sequence[ToolChatMessage], tools: Sequence[ToolDefinition], max_tokens: int
    ) -> ToolReply:
        """Return the model's reply to the messages, which may call any of the tools."""
        ...


def openai_tool(tool: ToolDefinition) -> ChatCompletionFunctionToolParam:
    """Turn a tool definition into the OpenAI SDK's typed form."""
    return ChatCompletionFunctionToolParam(
        type="function",
        function=FunctionDefinition(name=tool.name, description=tool.description, parameters=tool.parameters),
    )


def openai_call(call: ToolCall) -> ChatCompletionMessageFunctionToolCallParam:
    """Turn a call the model made into the SDK's typed form, to send back in the conversation."""
    return ChatCompletionMessageFunctionToolCallParam(
        id=call.id, type="function", function={"name": call.name, "arguments": call.arguments}
    )


def openai_message(message: ToolChatMessage) -> ChatCompletionMessageParam:
    """Turn a message into the OpenAI SDK's typed form for its role."""
    if message.role == "system":
        return ChatCompletionSystemMessageParam(role="system", content=message.content or "")
    if message.role == "user":
        return ChatCompletionUserMessageParam(role="user", content=message.content or "")
    if message.role == "tool":
        return ChatCompletionToolMessageParam(
            role="tool", tool_call_id=message.tool_call_id or "", content=message.content or ""
        )
    assistant = ChatCompletionAssistantMessageParam(role="assistant", content=message.content)
    if message.tool_calls:
        assistant["tool_calls"] = [openai_call(call) for call in message.tool_calls]
    return assistant


class GatewayToolChat:
    """Chat with tools through the AI gateway, at temperature 0 for repeatable answers."""

    def __init__(self, gateway: Gateway) -> None:
        """Send completions through `gateway`."""
        self.gateway = gateway

    def complete(
        self, alias: str, messages: Sequence[ToolChatMessage], tools: Sequence[ToolDefinition], max_tokens: int
    ) -> ToolReply:
        """Ask the alias for one reply without streaming, offering the tools when there are any."""
        typed_messages = [openai_message(message) for message in messages]
        if tools:
            reply = self.gateway.openai.chat.completions.create(
                model=alias,
                messages=typed_messages,
                tools=[openai_tool(tool) for tool in tools],
                tool_choice="auto",
                max_tokens=max_tokens,
                temperature=0,
            )
        else:
            reply = self.gateway.openai.chat.completions.create(
                model=alias, messages=typed_messages, max_tokens=max_tokens, temperature=0
            )
        message = reply.choices[0].message if reply.choices else None
        if message is None:
            return ToolReply(text="", calls=(), model=reply.model)
        calls = tuple(
            ToolCall(id=call_id(call.id, index), name=call.function.name, arguments=call.function.arguments)
            for index, call in enumerate(message.tool_calls or [])
            if isinstance(call, ChatCompletionMessageFunctionToolCall)
        )
        return ToolReply(text=message.content or "", calls=calls, model=reply.model)


def call_id(provided: str | None, index: int) -> str:
    """Return the ID to answer a call under: the provider's, or `call_<n>` when it sent none or one too long."""
    if provided and len(provided) <= MAX_CALL_ID_LENGTH:
        return provided
    return f"call_{index}"
