"""Tests for core.structured: model output must match its schema, and gets exactly one repair."""

from collections.abc import Sequence
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, cast

import pytest
from pydantic import BaseModel, ConfigDict

from core.structured import (
    IMAGE_DATA_URL,
    ChatMessage,
    Completion,
    GatewayChat,
    StructuredOutputError,
    ask_for_json,
    json_object_in,
    openai_message,
)
from lb_common.gateway import Gateway


class Answer(BaseModel):
    """A small answer schema to validate replies against."""

    model_config = ConfigDict(extra="forbid")

    category: str
    count: int


@dataclass
class ScriptedChat:
    """Stands in for the gateway's chat: replies from a script, and remembers each request."""

    replies: list[str]
    requests: list[list[ChatMessage]] = field(default_factory=list)
    output_caps: list[int] = field(default_factory=list)

    def complete(
        self, alias: str, messages: Sequence[ChatMessage], max_tokens: int, timeout_seconds: float | None = None
    ) -> Completion:
        """Return the next scripted reply, remembering the request and its output cap."""
        del timeout_seconds
        self.requests.append(list(messages))
        self.output_caps.append(max_tokens)
        return Completion(text=self.replies.pop(0), model=f"test/{alias}")


QUESTION = [ChatMessage("system", "Answer in JSON."), ChatMessage("user", "Classify this.")]


def test_a_valid_reply_is_accepted_first_time() -> None:
    """A reply that fits is validated and returned with the model that wrote it, and the reply itself."""
    chat = ScriptedChat(['{"category": "damaged", "count": 2}'])

    answer = ask_for_json(chat, "lb-fast", QUESTION, Answer, max_tokens=100)

    assert answer.value == Answer(category="damaged", count=2)
    assert (answer.model, answer.attempts) == ("test/lb-fast", 1)
    assert answer.reply == '{"category": "damaged", "count": 2}'


@pytest.mark.parametrize(
    "reply",
    [
        '```json\n{"category": "late", "count": 1}\n```',
        'Here it is: {"category": "late", "count": 1} Hope that helps.',
    ],
)
def test_json_in_a_fence_or_prose_is_found(reply: str) -> None:
    """The one JSON object is found inside a code fence or surrounding words."""
    answer = ask_for_json(ScriptedChat([reply]), "lb-fast", QUESTION, Answer, max_tokens=100)

    assert answer.value.category == "late"


def test_a_malformed_reply_gets_one_repair_that_says_what_was_wrong() -> None:
    """The repair request quotes the reply and names each problem; a good second reply is accepted."""
    chat = ScriptedChat(
        ['{"category": "damaged", "count": "two", "mood": "sad"}', '{"category": "damaged", "count": 2}']
    )

    answer = ask_for_json(chat, "lb-fast", QUESTION, Answer, max_tokens=100)

    assert answer.attempts == 2
    assert chat.output_caps == [100, 100]
    repair = chat.requests[1]
    assert repair[:2] == QUESTION
    assert repair[2].role == "assistant"
    assert "count: Input should be a valid integer" in repair[3].content
    assert "mood: Extra inputs are not permitted" in repair[3].content


def test_a_second_malformed_reply_is_an_error() -> None:
    """After one repair, a reply that still doesn't fit raises, naming the schema but no content."""
    chat = ScriptedChat(["no JSON here", '{"category": "damaged"}'])

    with pytest.raises(StructuredOutputError, match="Answer didn't validate after one repair") as error:
        ask_for_json(chat, "lb-fast", QUESTION, Answer, max_tokens=100)

    assert "no JSON here" not in str(error.value)
    assert len(chat.requests) == 2


def test_a_caller_with_no_call_to_spare_gets_no_repair() -> None:
    """With repair switched off, a bad reply is an error at once, and no second request is made."""
    chat = ScriptedChat(["no JSON here", '{"category": "damaged", "count": 2}'])

    with pytest.raises(StructuredOutputError, match="Answer didn't validate:") as error:
        ask_for_json(chat, "lb-fast", QUESTION, Answer, max_tokens=100, repair=False)

    assert "no JSON here" not in str(error.value)
    assert len(chat.requests) == 1


def test_the_repair_request_quotes_only_as_much_of_the_bad_reply_as_it_is_told_to() -> None:
    """A caller whose prompt has little room left limits how much of the bad reply the repair repeats."""
    chat = ScriptedChat(["x" * 900, '{"category": "damaged", "count": 2}'])

    ask_for_json(chat, "lb-fast", QUESTION, Answer, max_tokens=100, echo_chars=40)

    assert chat.requests[1][2].content == "x" * 40


@pytest.mark.parametrize("reply", ["", "just words", "{ broken", '{"a": 1'])
def test_a_reply_without_a_whole_json_object_is_refused(reply: str) -> None:
    """Empty replies, prose and broken JSON are all refused before validation."""
    with pytest.raises(ValueError):  # noqa: PT011 - both messages are the JSON parser's own
        json_object_in(reply)


def test_messages_become_the_sdks_typed_messages() -> None:
    """Each role maps to the OpenAI SDK's message of that role."""
    assert openai_message(ChatMessage("system", "rules")) == {"role": "system", "content": "rules"}
    assert openai_message(ChatMessage("user", "question")) == {"role": "user", "content": "question"}
    assert openai_message(ChatMessage("assistant", "{}")) == {"role": "assistant", "content": "{}"}


PICTURE = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBD"


def test_a_user_message_can_carry_pictures_as_inline_data_urls() -> None:
    """A message with pictures becomes a text part followed by one image part for each, the form vision models take."""
    message = ChatMessage("user", "Read this invoice.", images=(PICTURE,))

    assert openai_message(message) == {
        "role": "user",
        "content": [
            {"type": "text", "text": "Read this invoice."},
            {"type": "image_url", "image_url": {"url": PICTURE}},
        ],
    }


def test_a_message_without_pictures_is_still_plain_text() -> None:
    """The picture support changes nothing for the messages that already existed."""
    assert ChatMessage("user", "hello").images == ()
    assert openai_message(ChatMessage("user", "hello")) == {"role": "user", "content": "hello"}


@pytest.mark.parametrize("role", ["system", "assistant"])
def test_only_a_user_message_may_carry_a_picture(role: str) -> None:
    """A picture on a system or assistant message is refused when the message is made."""
    with pytest.raises(ValueError, match="user message"):
        ChatMessage(cast(Any, role), "text", images=(PICTURE,))


@pytest.mark.parametrize(
    "picture",
    [
        "https://example.com/invoice.jpg",
        "http://169.254.169.254/latest/meta-data",
        "file:///etc/passwd",
        "data:text/html;base64,PGh0bWw+",
        "data:image/svg+xml;base64,PHN2Zz4=",
        "data:image/jpeg;base64,not base64!",
        "data:image/jpeg,raw",
        "",
    ],
)
def test_a_picture_that_is_a_link_or_not_inline_is_refused(picture: str) -> None:
    """A link would make a provider fetch an address a document named, and other data types are not pictures."""
    with pytest.raises(ValueError, match="inline"):
        ChatMessage("user", "text", images=(picture,))


def test_the_picture_pattern_accepts_the_three_image_types_and_padding() -> None:
    """JPEG, PNG and WebP data URLs, with or without base64 padding, are accepted."""
    for kind in ("jpeg", "png", "webp"):
        assert IMAGE_DATA_URL.fullmatch(f"data:image/{kind};base64,QUJD")
        assert IMAGE_DATA_URL.fullmatch(f"data:image/{kind};base64,QUI=")
        assert IMAGE_DATA_URL.fullmatch(f"data:image/{kind};base64,QQ==")


def fake_gateway(calls: list[dict[str, Any]]) -> Gateway:
    """Build a stand-in gateway whose chat completions are recorded in `calls` and answer like the SDK."""

    def create(**request: Any) -> SimpleNamespace:
        """Record the request and answer like the OpenAI SDK."""
        calls.append(request)
        message = SimpleNamespace(content='{"ok": true}')
        return SimpleNamespace(choices=[SimpleNamespace(message=message)], model="groq/gpt-oss-20b")

    chat = SimpleNamespace(completions=SimpleNamespace(create=create))
    return cast(Gateway, SimpleNamespace(openai=SimpleNamespace(chat=chat)))


def test_gateway_chat_asks_the_alias_at_temperature_zero() -> None:
    """The gateway gets the alias, the messages and the output cap, and the reply comes back with its model."""
    calls: list[dict[str, Any]] = []

    completion = GatewayChat(fake_gateway(calls)).complete("lb-fast", QUESTION, max_tokens=300)

    assert completion == Completion(text='{"ok": true}', model="groq/gpt-oss-20b")
    assert calls[0]["model"] == "lb-fast"
    assert calls[0]["temperature"] == 0
    assert calls[0]["max_tokens"] == 300
    assert calls[0]["messages"][1] == {"role": "user", "content": "Classify this."}
    assert "timeout" not in calls[0]


def test_gateway_chat_passes_a_timeout_on_when_given_one() -> None:
    """A caller that must bound the wait gets the SDK's own per-request timeout."""
    calls: list[dict[str, Any]] = []

    GatewayChat(fake_gateway(calls)).complete("lb-reason", QUESTION, max_tokens=300, timeout_seconds=12.5)

    assert calls[0]["timeout"] == 12.5
