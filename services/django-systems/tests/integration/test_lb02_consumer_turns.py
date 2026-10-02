"""Integration tests for how LB-02's WebSocket carries a turn: failures, dropped connections and the limits on a client.

Everything is real except the models, as in test_lb02_consumer.py. These tests hold a turn in the
middle of its model call (`Gate`) to be in the state a dropped connection leaves behind: the
visitor's line is saved, and the answer is not.
"""

import logging
from collections.abc import Iterator
from typing import Any

import pytest
from channels.layers import get_channel_layer
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from lb02 import consumers
from lb02.conversations import record
from lb02.events import ERROR_SENTENCES, ErrorCode, Reply
from lb02.limits import MAX_CONNECTIONS_PER_VISITOR, MAX_PENDING_MESSAGES
from lb02.live import ANSWERED, conversation_group
from lb02.models import Conversation, Handoff, Message
from tests.lb02_support import FIRST_MESSAGE, SECOND_MESSAGE, Rig, say
from tests.lb02_websocket import DAN, JANA, Gate, Tab, fetch, forget_connections, serve_concierge

pytestmark = [pytest.mark.integration, pytest.mark.django_db(databases=["lb02"], transaction=True)]

# What an unexpected error says, which may hold anything: the visitor's words, a model's, a key.
SECRET = "hunter2-the-visitors-secret"
# Sentences the code can tell are English without asking a model, which a word or two would not be.
ONE = "Hello, I would like to book a cupping session."
TWO = "And I would like it for two people, please."
THREE = "Could it be tomorrow afternoon, if that is possible?"
FOUR = "Thank you very much for all of your help."


@pytest.fixture(autouse=True)
def no_connections_counted() -> Iterator[None]:
    """Start each test with no visitor's connections counted, and leave none behind."""
    forget_connections()
    yield
    forget_connections()


@pytest.fixture(autouse=True)
def rig(monkeypatch: pytest.MonkeyPatch) -> Rig:
    """Serve a concierge on fakes, with its calendar changes sent through the channel layer."""
    return serve_concierge(monkeypatch)


def fail_turns(rig: Rig, monkeypatch: pytest.MonkeyPatch, times: int) -> None:
    """Make the next `times` turns fail halfway, once the visitor's line is saved, with an error that says a secret.

    Later turns go on as usual.
    """
    original = rig.concierge.converse
    failures = {"left": times}

    def flaky(conversation: Conversation, text: str, context: Any) -> Any:
        """Raise while there are failures left, and answer normally after."""
        if failures["left"] > 0:
            failures["left"] -= 1
            raise RuntimeError(f"{SECRET} {text}")
        return original(conversation, text, context)

    monkeypatch.setattr(rig.concierge, "converse", flaky)


async def roles_in(conversation_id: str) -> list[str]:
    """Read the roles of a conversation's transcript, oldest first."""
    return await fetch(
        lambda: list(
            Message.objects.filter(conversation__public_id=conversation_id)
            .order_by("position")
            .values_list("role", flat=True)
        )
    )


# A turn that fails


async def test_a_turn_that_fails_tells_the_visitor_and_the_connection_goes_on(
    rig: Rig, web_signing_key: Ed25519PrivateKey, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """The visitor gets a typed error and the conversation goes on; the log holds the error's type, not its words."""
    caplog.set_level(logging.ERROR, logger="lb02.consumers")
    fail_turns(rig, monkeypatch, 1)
    rig.models.replies += [say("Welcome! What would you like to book?")]
    tab = Tab(web_signing_key)
    ready = await tab.hello()

    await tab.send({"type": "message", "text": FIRST_MESSAGE})
    working, failed = await tab.event(), await tab.event()

    assert working == {"type": "working"}
    assert failed == {"type": "error", "code": "turn_failed", "message": ERROR_SENTENCES[ErrorCode.TURN_FAILED]}
    assert SECRET not in str(failed)
    assert SECRET not in caplog.text
    assert "RuntimeError" in caplog.text
    assert ready["conversation"] in caplog.text
    assert await roles_in(ready["conversation"]) == ["visitor", "action"]
    answered = await tab.say(SECOND_MESSAGE)
    assert answered["text"] == "Welcome! What would you like to book?"
    assert (await fetch(lambda: Conversation.objects.get(public_id=ready["conversation"]).failed_turns)) == 0
    await tab.leave()


async def test_a_conversation_whose_turns_keep_failing_is_handed_to_a_person(
    rig: Rig, web_signing_key: Ed25519PrivateKey, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two failures in a row are the second chance used up, as for a model that says nothing."""
    fail_turns(rig, monkeypatch, 2)
    tab = Tab(web_signing_key)
    ready = await tab.hello()

    await tab.send({"type": "message", "text": FIRST_MESSAGE})
    assert [(await tab.event())["type"], (await tab.event())["code"]] == ["working", "turn_failed"]
    await tab.send({"type": "message", "text": SECOND_MESSAGE})
    assert (await tab.event())["type"] == "working"
    handed_over = await tab.event()

    assert handed_over["type"] == "reply"
    assert (handed_over["receipt"], handed_over["closed"], handed_over["step"]) == ("unavailable", True, "handoff")
    assert SECRET not in str(handed_over)
    assert await fetch(lambda: Handoff.objects.filter(conversation__public_id=ready["conversation"]).count()) == 1
    await tab.leave()


async def test_a_failure_that_cannot_even_be_written_down_still_tells_the_visitor(
    rig: Rig, web_signing_key: Ed25519PrivateKey, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the database is what failed, the note can't be kept, and the visitor still hears of it."""
    fail_turns(rig, monkeypatch, 1)

    def cannot_write(_conversation: Conversation) -> None:
        """Fail the way a broken database would."""
        raise RuntimeError(SECRET)

    monkeypatch.setattr(rig.concierge, "turn_crashed", cannot_write)
    tab = Tab(web_signing_key)
    await tab.hello()

    await tab.send({"type": "message", "text": FIRST_MESSAGE})

    assert [(await tab.event())["type"], (await tab.event())["code"]] == ["working", "turn_failed"]
    await tab.leave()


# A connection that drops while the concierge is answering


async def test_an_answer_finished_after_the_connection_dropped_reaches_the_connection_that_resumed(
    rig: Rig, web_signing_key: Ed25519PrivateKey
) -> None:
    """The page reconnects and resumes mid-turn: it is told the answer is on its way, and then it is sent."""
    gate = Gate()
    rig.models.meanwhile[0] = gate.hold
    rig.models.replies += [say("Welcome! What would you like to book?")]
    first, second = Tab(web_signing_key), Tab(web_signing_key)
    ready = await first.hello()
    await first.send({"type": "message", "text": FIRST_MESSAGE})
    assert (await first.event())["type"] == "working"
    await gate.arrival()

    await first.drop()
    resumed = await second.hello(conversation=ready["conversation"])
    gate.release()
    answer = await second.event()

    assert resumed["resumed"] is True
    assert resumed["pending"] is True
    assert [line["role"] for line in resumed["transcript"]] == ["visitor"]
    assert answer["type"] == "reply"
    assert answer["text"] == "Welcome! What would you like to book?"
    assert answer["messages_left"] == 29
    assert await second.quiet()
    await first.communicator.wait(timeout=10)
    await second.leave()


async def test_an_answer_saved_before_the_connection_resumed_is_in_the_transcript_and_not_sent_again(
    rig: Rig, web_signing_key: Ed25519PrivateKey
) -> None:
    """The turn ended while nobody was connected: the resumed page finds the answer in what it is shown."""
    gate = Gate()
    rig.models.meanwhile[0] = gate.hold
    rig.models.replies += [say("Welcome! What would you like to book?")]
    first, second = Tab(web_signing_key), Tab(web_signing_key)
    ready = await first.hello()
    await first.send({"type": "message", "text": FIRST_MESSAGE})
    assert (await first.event())["type"] == "working"
    await gate.arrival()
    await first.drop()
    gate.release()
    await first.communicator.wait(timeout=10)

    resumed = await second.hello(conversation=ready["conversation"])

    assert resumed["pending"] is False
    assert [line["role"] for line in resumed["transcript"]] == ["visitor", "concierge"]
    assert resumed["transcript"][-1]["text"] == "Welcome! What would you like to book?"
    assert await second.quiet()
    await second.leave()


async def test_a_turn_that_fails_after_the_connection_dropped_is_passed_on_as_the_error(
    rig: Rig, web_signing_key: Ed25519PrivateKey
) -> None:
    """A page told its answer was on its way must also be told when the turn fell over, or it would wait for ever."""
    gate = Gate()

    def hold_then_fail() -> None:
        """Hold the turn at the gate, and then fail it with an error that says something secret."""
        gate.hold()
        raise RuntimeError(SECRET)

    rig.models.meanwhile[0] = hold_then_fail
    first, second = Tab(web_signing_key), Tab(web_signing_key)
    ready = await first.hello()
    await first.send({"type": "message", "text": FIRST_MESSAGE})
    assert (await first.event())["type"] == "working"
    await gate.arrival()
    await first.drop()
    resumed = await second.hello(conversation=ready["conversation"])

    gate.release()
    failed = await second.event()

    assert resumed["pending"] is True
    assert (failed["type"], failed["code"]) == ("error", "turn_failed")
    assert SECRET not in str(failed)
    await first.communicator.wait(timeout=10)
    await second.leave()


def answer_from_elsewhere(position: int | None) -> dict[str, Any]:
    """Make the message the channel layer carries when another connection finished a turn."""
    reply = Reply(
        step="availability",
        language="en",
        messages_left=29,
        closed=False,
        options=[],
        hold=None,
        booking=None,
        text="Welcome! What would you like to book?",
        receipt=None,
        tools=[],
        model_calls=1,
    )
    return {
        "type": ANSWERED,
        "origin": "specific.another-connection",
        "position": position,
        "event": reply.model_dump(mode="json"),
    }


async def test_a_resumed_connection_is_sent_an_answer_it_does_not_hold_and_only_once(
    rig: Rig, web_signing_key: Ed25519PrivateKey
) -> None:
    """A message never answered stays waiting: an answer past what the page holds is sent, and an old one is not."""
    first, second = Tab(web_signing_key), Tab(web_signing_key)
    ready = await first.hello()
    await first.leave()
    await fetch(
        lambda: record(
            Conversation.objects.get(public_id=ready["conversation"]), "visitor", "Is anyone there?", rig.clock()
        )
    )
    resumed = await second.hello(conversation=ready["conversation"])
    layer = get_channel_layer()
    group = conversation_group(ready["conversation"])

    await layer.group_send(group, answer_from_elsewhere(position=1))
    held_already = await second.quiet()
    await layer.group_send(group, answer_from_elsewhere(position=2))
    sent = await second.event()
    await layer.group_send(group, answer_from_elsewhere(position=3))
    sent_twice = not await second.quiet()

    assert resumed["pending"] is False
    assert held_already
    assert (sent["type"], sent["text"]) == ("reply", "Welcome! What would you like to book?")
    assert not sent_twice
    await second.leave()


async def test_a_message_to_the_conversation_that_is_not_an_answer_is_ignored(
    rig: Rig, web_signing_key: Ed25519PrivateKey
) -> None:
    """Whatever arrives in the group, a connection that is waiting does not fall over for it."""
    first, second = Tab(web_signing_key), Tab(web_signing_key)
    ready = await first.hello()
    await first.leave()
    await fetch(
        lambda: record(
            Conversation.objects.get(public_id=ready["conversation"]), "visitor", "Is anyone there?", rig.clock()
        )
    )
    await second.hello(conversation=ready["conversation"])
    garbage = {"type": ANSWERED, "origin": "specific.another-connection", "position": 5, "event": {"type": "typing"}}

    await get_channel_layer().group_send(conversation_group(ready["conversation"]), garbage)

    assert await second.quiet()
    await second.leave()


async def test_a_tab_that_waits_for_nothing_is_not_sent_the_answers_to_other_tabs(
    rig: Rig, web_signing_key: Ed25519PrivateKey
) -> None:
    """A second tab that was told nothing about the message would be shown an answer to a question it never saw."""
    rig.models.replies += [say("Welcome! What would you like to book?")]
    first, second = Tab(web_signing_key), Tab(web_signing_key)
    ready = await first.hello()
    await second.hello(conversation=ready["conversation"])

    await first.say(FIRST_MESSAGE)

    assert await second.quiet()
    assert await first.quiet()
    await first.leave()
    await second.leave()


# A client that never waits


async def test_messages_past_the_two_in_hand_are_refused_and_the_connection_goes_on(
    rig: Rig, web_signing_key: Ed25519PrivateKey
) -> None:
    """The first is answered, one waits behind it, and the rest are turned away with a typed error."""
    assert MAX_PENDING_MESSAGES == 2
    gate = Gate()
    rig.models.meanwhile[0] = gate.hold
    rig.models.replies += [say("First answer."), say("Second answer.")]
    tab = Tab(web_signing_key)
    ready = await tab.hello()

    for text in (ONE, TWO, THREE, FOUR):
        await tab.send({"type": "message", "text": text})
    assert (await tab.event())["type"] == "working"
    refusals = [await tab.event(), await tab.event()]
    gate.release()
    first_answer = await tab.event()
    second_working = await tab.event()
    second_answer = await tab.event()

    assert [(event["type"], event["code"]) for event in refusals] == [("error", "too_many_pending")] * 2
    assert refusals[0]["message"] == ERROR_SENTENCES[ErrorCode.TOO_MANY_PENDING]
    assert (first_answer["text"], second_working["type"], second_answer["text"]) == (
        "First answer.",
        "working",
        "Second answer.",
    )
    assert await fetch(lambda: Conversation.objects.get(public_id=ready["conversation"]).message_count) == 2
    assert await tab.quiet()
    await tab.leave()


async def test_a_message_waiting_for_its_turn_is_dropped_when_the_connection_closes(
    rig: Rig, web_signing_key: Ed25519PrivateKey
) -> None:
    """Nobody was told it was being answered, so a closed connection does not start it."""
    gate = Gate()
    rig.models.meanwhile[0] = gate.hold
    rig.models.replies += [say("First answer.")]
    tab = Tab(web_signing_key)
    ready = await tab.hello()
    await tab.send({"type": "message", "text": ONE})
    assert (await tab.event())["type"] == "working"
    await gate.arrival()
    await tab.send({"type": "message", "text": TWO})
    await tab.drop()

    gate.release()
    await tab.communicator.wait(timeout=10)

    assert await roles_in(ready["conversation"]) == ["visitor", "concierge"]
    assert await fetch(lambda: Conversation.objects.get(public_id=ready["conversation"]).message_count) == 1


# A visitor with many connections


async def test_a_visitor_may_hold_only_so_many_connections_at_once(web_signing_key: Ed25519PrivateKey) -> None:
    """The next one is told why and closed with "try again later"; other visitors and later tries are not affected."""
    tabs = [Tab(web_signing_key, JANA) for _ in range(MAX_CONNECTIONS_PER_VISITOR)]
    for tab in tabs:
        assert (await tab.hello())["type"] == "ready"
    refused, other, later = Tab(web_signing_key, JANA), Tab(web_signing_key, DAN), Tab(web_signing_key, JANA)

    await refused.connect()
    await refused.send({"type": "hello", "token": refused.token, "conversation": None})
    error = await refused.event()
    code = await refused.close_code()
    other_ready = await other.hello()
    await tabs[0].leave()
    later_ready = await later.hello()

    assert (error["type"], error["code"]) == ("error", "too_many_connections")
    assert error["message"] == ERROR_SENTENCES[ErrorCode.TOO_MANY_CONNECTIONS]
    assert code == 1013
    assert other_ready["type"] == "ready"
    assert later_ready["type"] == "ready"
    await refused.leave()
    for tab in (*tabs[1:], other, later):
        await tab.leave()
    assert consumers.CONNECTIONS.total() == 0


async def test_a_connection_that_never_got_in_is_not_counted(web_signing_key: Ed25519PrivateKey) -> None:
    """Silence, a bad token and a refused hello leave no count behind."""
    bad = Tab(web_signing_key)
    await bad.connect()
    await bad.send({"type": "hello", "token": "not-a-token", "conversation": None})
    assert await bad.close_code() == 4401
    await bad.leave()

    assert consumers.CONNECTIONS.total() == 0
