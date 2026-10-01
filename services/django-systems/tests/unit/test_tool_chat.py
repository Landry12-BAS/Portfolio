"""Tests for core.tool_chat: a model's tool calls come back as plain values, and none of them is trusted."""

from types import SimpleNamespace
from typing import Any, cast

from openai.types.chat import ChatCompletionMessageFunctionToolCall
from openai.types.chat.chat_completion_message_function_tool_call import Function

from core.tool_chat import (
    GatewayToolChat,
    ToolCall,
    ToolChatMessage,
    ToolDefinition,
    ToolReply,
    call_id,
    openai_message,
    openai_tool,
)
from lb_common.gateway import Gateway

HOLD = ToolDefinition(
    name="hold_slot",
    description="Hold one of the offered slots.",
    parameters={"type": "object", "properties": {"option": {"type": "integer"}}, "required": ["option"]},
)
MESSAGES = [ToolChatMessage("system", "Rules."), ToolChatMessage("user", "The 2 pm one.")]


def function_call(call_id: str, name: str, arguments: str) -> ChatCompletionMessageFunctionToolCall:
    """Make a call to a function tool the way the SDK parses one from a provider's answer."""
    return ChatCompletionMessageFunctionToolCall(
        id=call_id, type="function", function=Function(name=name, arguments=arguments)
    )


def gateway_answering(
    message: SimpleNamespace | None, requests: list[dict[str, Any]], model: str = "groq/gpt-oss-120b"
) -> Gateway:
    """Build a stand-in gateway whose chat completions record each request and answer with `message`."""

    def create(**request: Any) -> SimpleNamespace:
        """Record the request and answer like the OpenAI SDK."""
        requests.append(request)
        choices = [SimpleNamespace(message=message)] if message is not None else []
        return SimpleNamespace(choices=choices, model=model)

    chat = SimpleNamespace(completions=SimpleNamespace(create=create))
    return cast(Gateway, SimpleNamespace(openai=SimpleNamespace(chat=chat)))


def test_a_reply_without_calls_is_just_its_text() -> None:
    """With no tools on offer none are sent, and no tool_choice either, since the gateway needs at least one tool."""
    requests: list[dict[str, Any]] = []
    gateway = gateway_answering(SimpleNamespace(content="Hello!", tool_calls=None), requests)

    reply = GatewayToolChat(gateway).complete("lb-tools", MESSAGES, [], max_tokens=300)

    assert reply == ToolReply(text="Hello!", calls=(), model="groq/gpt-oss-120b")
    assert "tools" not in requests[0]
    assert "tool_choice" not in requests[0]
    assert (requests[0]["model"], requests[0]["temperature"], requests[0]["max_tokens"]) == ("lb-tools", 0, 300)


def test_tools_are_offered_in_the_sdks_typed_form() -> None:
    """The tool goes to the gateway as a function tool with its JSON Schema, and the model may choose freely."""
    requests: list[dict[str, Any]] = []
    gateway = gateway_answering(SimpleNamespace(content=None, tool_calls=None), requests)

    GatewayToolChat(gateway).complete("lb-tools", MESSAGES, [HOLD], max_tokens=300)

    assert requests[0]["tools"] == [openai_tool(HOLD)]
    assert requests[0]["tools"][0]["function"]["name"] == "hold_slot"
    assert requests[0]["tool_choice"] == "auto"


def test_calls_come_back_with_their_arguments_exactly_as_the_model_wrote_them() -> None:
    """Even arguments that aren't JSON are returned as text: validating them is the system's job."""
    requests: list[dict[str, Any]] = []
    message = SimpleNamespace(
        content="",
        tool_calls=[
            function_call("call_a", "hold_slot", '{"option": 1}'),
            function_call("call_b", "confirm_booking", "not json {"),
        ],
    )

    reply = GatewayToolChat(gateway_answering(message, requests)).complete("lb-tools", MESSAGES, [HOLD], 300)

    assert reply.calls == (
        ToolCall("call_a", "hold_slot", '{"option": 1}'),
        ToolCall("call_b", "confirm_booking", "not json {"),
    )


def test_a_call_that_isnt_to_a_function_tool_is_ignored() -> None:
    """Only function calls are tool calls here; anything else the provider sends is dropped."""
    requests: list[dict[str, Any]] = []
    custom = SimpleNamespace(id="call_x", type="custom", custom=SimpleNamespace(name="x", input="y"))
    message = SimpleNamespace(content="Done.", tool_calls=[custom, function_call("call_a", "release_hold", "{}")])

    reply = GatewayToolChat(gateway_answering(message, requests)).complete("lb-tools", MESSAGES, [HOLD], 300)

    assert [call.name for call in reply.calls] == ["release_hold"]


def test_a_reply_with_no_choices_is_an_empty_reply() -> None:
    """A provider that answers without a message gives no text and no calls, which the caller treats as a failure."""
    requests: list[dict[str, Any]] = []

    reply = GatewayToolChat(gateway_answering(None, requests)).complete("lb-tools", MESSAGES, [HOLD], 300)

    assert (reply.text, reply.calls) == ("", ())


def test_a_missing_or_oversized_call_id_is_replaced() -> None:
    """The gateway takes IDs of 1 to 128 characters, so a provider's empty or huge ID becomes call_<n>."""
    assert call_id("abc", 0) == "abc"
    assert call_id("", 2) == "call_2"
    assert call_id(None, 1) == "call_1"
    assert call_id("x" * 129, 3) == "call_3"


def test_messages_become_the_sdks_typed_messages_with_calls_and_their_answers() -> None:
    """An assistant message carries the calls it made, and a tool message answers one by its ID."""
    call = ToolCall("call_a", "hold_slot", '{"option": 1}')

    assert openai_message(ToolChatMessage("system", "Rules.")) == {"role": "system", "content": "Rules."}
    assert openai_message(ToolChatMessage("user", "Hi")) == {"role": "user", "content": "Hi"}
    assert openai_message(ToolChatMessage("assistant", "Hello")) == {"role": "assistant", "content": "Hello"}
    assert openai_message(ToolChatMessage("assistant", None, tool_calls=(call,))) == {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {"id": "call_a", "type": "function", "function": {"name": "hold_slot", "arguments": '{"option": 1}'}}
        ],
    }
    assert openai_message(ToolChatMessage("tool", '{"ok": true}', tool_call_id="call_a")) == {
        "role": "tool",
        "tool_call_id": "call_a",
        "content": '{"ok": true}',
    }
