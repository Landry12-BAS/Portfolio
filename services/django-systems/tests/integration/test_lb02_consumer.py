# ruff: noqa: RUF001 - the receipts are typeset text, so the tests hold their en dashes
"""Integration tests for LB-02's WebSocket: the first frame, the limits, whole bookings and the live calendar.

Everything is real except the models: the ASGI application and its routes, the token check, a
Postgres with the exclusion constraint, and the channel layer (the in-memory one, except where a
test says it uses Redis). The concierge's models are a script, so a test chooses what they say
and the tests check what the service does with it.

Each test commits for real (`transaction=True`), because a turn runs on a worker thread of its own
with its own database connection, which can't see what an open test transaction hasn't committed.
"""

import asyncio
from collections.abc import Callable
from datetime import date, timedelta
from typing import Any

import pytest
from channels.layers import get_channel_layer
from channels.testing import WebsocketCommunicator
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from django.db.models import QuerySet
from pytest_django.fixtures import Settings
from redis import Redis

from config.asgi import application
from config.channel_layer import BLOCK_SECONDS
from core.blocking import closing_connections, run_blocking
from lb02 import consumers
from lb02.booking import BookingService
from lb02.events import ERROR_SENTENCES, ErrorCode
from lb02.limits import MAX_FRAME_BYTES, MAX_MESSAGE_LENGTH, MESSAGES_PER_SESSION
from lb02.live import ChannelLayerNotifier, announce_reset
from lb02.models import Conversation, Message, Offering, Reservation, Slot
from tests.lb02_support import (
    DETAILS,
    FIRST_MESSAGE,
    SECOND_MESSAGE,
    THIRD_MESSAGE,
    Rig,
    build_rig,
    call,
    calling,
    make_conversation,
    mint_token,
    say,
)

pytestmark = [pytest.mark.integration, pytest.mark.django_db(databases=["lb02"], transaction=True)]

JANA = "session-of-jana-visitor-01"
DAN = "session-of-dan-visitor-002"
# How long a test waits for the server, so a hang fails the test instead of stalling it.
PATIENCE_SECONDS = 10


@pytest.fixture(autouse=True)
def rig(monkeypatch: pytest.MonkeyPatch) -> Rig:
    """Build the concierge on fakes, with its calendar changes sent through the channel layer, and serve it."""
    built = build_rig(notifier=ChannelLayerNotifier())
    monkeypatch.setattr(consumers, "shared_concierge", lambda: built.concierge)
    return built


class Tab:
    """One browser tab: a WebSocket to the concierge, the frames it sends, and the events it gets."""

    def __init__(self, key: Ed25519PrivateKey, session: str = JANA) -> None:
        """Prepare a connection for a visitor, with a token the site would mint for them."""
        self.communicator = WebsocketCommunicator(application, "/ws/lb02/")
        self.token = mint_token(key, session)
        self.calendar: list[dict[str, Any]] = []

    async def connect(self) -> None:
        """Open the WebSocket handshake."""
        connected, _ = await self.communicator.connect()
        assert connected

    async def hello(self, conversation: str | None = None, token: str | None = None) -> dict[str, Any]:
        """Open the connection and say hello; return the first event the server sends."""
        await self.connect()
        await self.send({"type": "hello", "token": token or self.token, "conversation": conversation})
        return await self.event()

    async def send(self, frame: dict[str, object]) -> None:
        """Send a frame."""
        await self.communicator.send_json_to(frame)

    async def event(self) -> dict[str, Any]:
        """Wait for the next event."""
        event: dict[str, Any] = await self.communicator.receive_json_from(timeout=PATIENCE_SECONDS)
        return event

    async def say(self, text: str) -> dict[str, Any]:
        """Send a message, check the server says it is working on it, and return its reply.

        Calendar events may arrive in between, since the whole calendar is watched while a message is
        answered; they are kept in `calendar`, and this waits through them.
        """
        await self.send({"type": "message", "text": text})
        expected = ["working", "reply"]
        while True:
            event = await self.event()
            if event["type"] in ("calendar", "calendar_reset"):
                self.calendar.append(event)
                continue
            assert event["type"] == expected.pop(0), event
            if not expected:
                return event

    async def close_code(self) -> int:
        """Wait for the server to close the connection, and return its code."""
        output = await self.communicator.receive_output(timeout=PATIENCE_SECONDS)
        assert output["type"] == "websocket.close", output
        code: int = output["code"]
        return code

    async def quiet(self) -> bool:
        """Tell whether nothing more is waiting to be sent to this tab."""
        return bool(await self.communicator.receive_nothing(timeout=0.3))

    async def leave(self) -> None:
        """Close the connection from the client's side."""
        await self.communicator.disconnect()


async def count(rows: Callable[[], QuerySet[Any]]) -> int:
    """Count rows from a coroutine, which may not touch the database directly."""
    return await run_blocking(lambda: rows().count())


async def fetch[Row](read: Callable[[], Row]) -> Row:
    """Run a database read from a coroutine."""
    return await run_blocking(read)


# The first frame


async def test_hello_opens_a_conversation_and_the_server_says_ready(web_signing_key: Ed25519PrivateKey) -> None:
    """The server's first word is `ready`: an empty conversation at the details step, with all 30 messages left."""
    tab = Tab(web_signing_key)

    ready = await tab.hello()

    assert ready["type"] == "ready"
    assert (ready["resumed"], ready["step"], ready["messages_left"], ready["closed"]) == (False, "details", 30, False)
    assert (ready["transcript"], ready["options"], ready["hold"], ready["booking"]) == ([], [], None, None)
    conversation = await fetch(lambda: Conversation.objects.get(public_id=ready["conversation"]))
    assert conversation.session_key == JANA
    await tab.leave()


@pytest.mark.parametrize(
    "frame",
    [
        {"type": "message", "text": "Hi, can I book a tasting?"},
        {"type": "ready"},
        {"type": "hello"},
        {"token": "x"},
        [],
    ],
)
async def test_anything_but_a_hello_first_closes_the_connection(
    rig: Rig, web_signing_key: Ed25519PrivateKey, frame: object
) -> None:
    """Before the hello, a message, a made-up frame or a missing token is refused, and nothing is read or written."""
    tab = Tab(web_signing_key)
    await tab.connect()

    await tab.communicator.send_json_to(frame)

    assert await tab.close_code() == 4400
    assert await count(lambda: Conversation.objects.all()) == 0
    assert rig.models.requests == []
    assert rig.guard.guarded == []


async def test_a_frame_that_isnt_json_closes_the_connection(web_signing_key: Ed25519PrivateKey) -> None:
    """Text that isn't a JSON object is not a frame."""
    tab = Tab(web_signing_key)
    await tab.connect()

    await tab.communicator.send_to(text_data="hello there")

    assert await tab.close_code() == 4400


async def test_the_token_is_never_read_from_the_address(web_signing_key: Ed25519PrivateKey) -> None:
    """A token in the query string is ignored: it is the hello that counts, and without one nothing opens."""
    tab = Tab(web_signing_key)
    tab.communicator = WebsocketCommunicator(application, f"/ws/lb02/?token={tab.token}")
    await tab.connect()

    await tab.communicator.send_json_to({"type": "message", "text": "Hi"})

    assert await tab.close_code() == 4400
    assert await count(lambda: Conversation.objects.all()) == 0


async def test_an_unknown_path_is_not_a_concierge() -> None:
    """Only /ws/lb02/ is served."""
    communicator = WebsocketCommunicator(application, "/ws/lb03/")

    with pytest.raises(ValueError, match="No route found"):
        await communicator.connect()


# The token


def bad_tokens(key: Ed25519PrivateKey) -> dict[str, str]:
    """Tokens that must not open anything, each wrong in its own way."""
    return {
        "garbage": "not-a-token",
        "signed by someone else": mint_token(Ed25519PrivateKey.generate(), JANA),
        "expired": mint_token(key, JANA, lifetime=-300),
        "for another system": mint_token(key, JANA, system="lb-01"),
        "too long lived": mint_token(key, JANA, lifetime=3_600),
        "subject isn't a session hash": mint_token(key, "short"),
    }


@pytest.mark.parametrize("why", list(bad_tokens(Ed25519PrivateKey.generate())))
async def test_a_bad_token_closes_the_connection_with_4401_and_nothing_is_created(
    rig: Rig, web_signing_key: Ed25519PrivateKey, why: str
) -> None:
    """The server says nothing about why, creates nothing, and no model is asked anything."""
    tab = Tab(web_signing_key)
    await tab.connect()
    # Each case is minted from this test's own key, so "signed by someone else" really is.
    await tab.send({"type": "hello", "token": bad_tokens(web_signing_key)[why]})

    assert await tab.close_code() == 4401
    assert await count(lambda: Conversation.objects.all()) == 0
    assert rig.models.requests == []
    assert rig.guard.guarded == []


async def test_without_the_sites_key_nobody_gets_in(web_signing_key: Ed25519PrivateKey, settings: Settings) -> None:
    """A service that doesn't know the site's public key fails closed, even for a perfectly good token."""
    settings.WEB_TOKEN_KEY = ""
    tab = Tab(web_signing_key)
    await tab.connect()

    await tab.send({"type": "hello", "token": tab.token})

    assert await tab.close_code() == 4401


async def test_a_connection_that_never_says_hello_is_closed(
    web_signing_key: Ed25519PrivateKey, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Ten seconds in production; a fraction of one here. Silence is not a way to hold a connection open."""
    monkeypatch.setattr(consumers, "HELLO_TIMEOUT_SECONDS", 0.2)
    tab = Tab(web_signing_key)
    await tab.connect()

    assert await tab.close_code() == 4408


async def test_an_open_connection_that_goes_quiet_is_closed(
    web_signing_key: Ed25519PrivateKey, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A quarter of an hour in production: a visitor who walked away doesn't hold a connection for ever."""
    monkeypatch.setattr(consumers, "IDLE_TIMEOUT_SECONDS", 0.3)
    tab = Tab(web_signing_key)
    await tab.hello()

    assert await tab.close_code() == 4408


async def test_a_frame_over_the_size_limit_closes_the_connection(web_signing_key: Ed25519PrivateKey) -> None:
    """The frame is refused for its size before it is parsed."""
    tab = Tab(web_signing_key)
    await tab.hello()

    await tab.communicator.send_to(text_data="x" * (MAX_FRAME_BYTES + 1))

    assert await tab.close_code() == 1009


async def test_a_binary_frame_closes_the_connection(web_signing_key: Ed25519PrivateKey) -> None:
    """The protocol is text; bytes are not part of it."""
    tab = Tab(web_signing_key)
    await tab.hello()

    await tab.communicator.send_to(bytes_data=b"\x00\x01")

    assert await tab.close_code() == 1003


# After hello


@pytest.mark.parametrize(
    "frame",
    [
        {"type": "message"},
        {"type": "message", "text": "   "},
        {"type": "message", "text": "Hi", "voice": True},
        {"type": "message", "text": 42},
        {"type": "shout", "text": "Hi"},
        {"text": "Hi"},
    ],
)
async def test_an_invalid_frame_after_hello_is_an_error_and_the_connection_goes_on(
    web_signing_key: Ed25519PrivateKey, frame: dict[str, object]
) -> None:
    """The client is told, with a code, that the frame wasn't understood; nothing is counted, and it can carry on."""
    tab = Tab(web_signing_key)
    await tab.hello()

    await tab.send(frame)
    error = await tab.event()

    assert error["type"] == "error"
    assert error["code"] == "invalid_frame"
    assert await tab.quiet()
    await tab.leave()


async def test_a_message_over_500_characters_is_refused_and_costs_nothing(
    rig: Rig, web_signing_key: Ed25519PrivateKey
) -> None:
    """The limit is on the visitor's text, and a refused message isn't one of their 30."""
    tab = Tab(web_signing_key)
    ready = await tab.hello()

    await tab.send({"type": "message", "text": "x" * (MAX_MESSAGE_LENGTH + 1)})
    error = await tab.event()

    assert error["code"] == "message_too_long"
    conversation = await fetch(lambda: Conversation.objects.get(public_id=ready["conversation"]))
    assert conversation.message_count == 0
    assert rig.guard.guarded == []
    await tab.leave()


async def test_control_characters_in_a_message_are_dropped_before_anything_reads_it(
    rig: Rig, web_signing_key: Ed25519PrivateKey
) -> None:
    """A NUL can't be stored in Postgres text: it never gets that far."""
    rig.models.replies.append(say("Hello! What would you like to book?"))
    tab = Tab(web_signing_key)
    await tab.hello()

    reply = await tab.say("Hi\x00 there, I would like to book a tasting.")

    assert reply["type"] == "reply"
    assert rig.guard.guarded == ["Hi there, I would like to book a tasting."]
    await tab.leave()


async def test_a_second_hello_is_refused_and_the_conversation_is_unchanged(web_signing_key: Ed25519PrivateKey) -> None:
    """Hello is for the first frame only; a later one can't swap the visitor or the conversation."""
    tab = Tab(web_signing_key)
    ready = await tab.hello()

    await tab.send({"type": "hello", "token": mint_token(web_signing_key, DAN)})
    error = await tab.event()

    assert error["code"] == "already_said_hello"
    assert await count(lambda: Conversation.objects.filter(public_id=ready["conversation"], session_key=JANA)) == 1
    await tab.leave()


# A conversation


async def test_a_whole_booking_over_the_socket(rig: Rig, web_signing_key: Ed25519PrivateKey) -> None:
    """Three messages and seven gateway calls: the datasheet's booking, seen as the page sees it."""
    rig.script_booking()
    tab = Tab(web_signing_key)
    await tab.hello()

    first = await tab.say(FIRST_MESSAGE)
    second = await tab.say(SECOND_MESSAGE)
    third = await tab.say(THIRD_MESSAGE)

    assert first["type"] == "reply"
    assert (first["step"], first["language"], first["messages_left"]) == ("availability", "en", 29)
    assert [option["offering"] for option in first["options"]] == ["cupping"]
    assert [tool["name"] for tool in first["tools"]] == ["update_details"]
    assert (second["step"], second["receipt"]) == ("hold", "hold_placed")
    assert second["hold"]["offering"] == "cupping"
    assert (third["step"], third["receipt"]) == ("done", "booking_confirmed")
    assert third["booking"]["to"] == "jana@example.test"
    assert (third["messages_left"], third["model_calls"]) == (27, 7)
    assert third["text"].startswith("You're booked: Cupping session on Fri 2 Oct, 14:30–15:30 for 2 guests.")
    await tab.leave()


async def test_a_visitors_words_reach_the_model_masked(rig: Rig, web_signing_key: Ed25519PrivateKey) -> None:
    """A real address typed into the chat is replaced before the model reads it, and never stored."""
    rig.models.replies.append(say("Please give me an example address, such as name@example.test."))
    tab = Tab(web_signing_key)
    ready = await tab.hello()

    await tab.say("I want a tasting, my email is jana.novak@gmail.com")

    assert "gmail" not in rig.models.requests[0].last()
    assert "[email]" in rig.models.requests[0].last()
    stored = await fetch(
        lambda: [m.text for m in Message.objects.filter(conversation__public_id=ready["conversation"])]
    )
    assert not any("gmail" in line for line in stored)
    await tab.leave()


async def test_thirty_messages_are_answered_and_the_thirty_first_ends_the_conversation(
    rig: Rig, web_signing_key: Ed25519PrivateKey
) -> None:
    """The datasheet's limit, over the wire: the 31st message is handed to a person and the socket stays readable."""
    rig.models.replies += [say("Ok.")] * MESSAGES_PER_SESSION
    tab = Tab(web_signing_key)
    await tab.hello()

    replies = [await tab.say(f"Hello number {number}.") for number in range(MESSAGES_PER_SESSION)]
    over = await tab.say("One more thing.")
    after = await tab.say("Anyone there?")

    assert [reply["messages_left"] for reply in replies] == list(range(MESSAGES_PER_SESSION - 1, -1, -1))
    assert (over["receipt"], over["closed"]) == ("message_limit", True)
    assert (after["receipt"], after["closed"]) == ("closed", True)
    assert after["model_calls"] == over["model_calls"]


async def test_a_conversation_can_be_resumed_with_its_transcript(rig: Rig, web_signing_key: Ed25519PrivateKey) -> None:
    """A page reload says hello with the conversation's ID and finds everything said so far, and the booking's state."""
    rig.script_booking()
    first_tab = Tab(web_signing_key)
    ready = await first_tab.hello()
    await first_tab.say(FIRST_MESSAGE)
    await first_tab.say(SECOND_MESSAGE)
    await first_tab.leave()

    second_tab = Tab(web_signing_key)
    resumed = await second_tab.hello(conversation=ready["conversation"])

    assert (resumed["type"], resumed["resumed"], resumed["conversation"]) == ("ready", True, ready["conversation"])
    assert resumed["step"] == "hold"
    assert resumed["hold"]["offering"] == "cupping"
    assert resumed["messages_left"] == 28
    roles = [line["role"] for line in resumed["transcript"]]
    assert roles[0] == "visitor"
    assert roles.count("visitor") == 2
    assert roles.count("concierge") == 2
    assert resumed["transcript"][0]["text"] == FIRST_MESSAGE.replace("jana@example.test", "[email]")
    await second_tab.leave()


@pytest.mark.parametrize("which", ["someone else's", "unknown", "expired"])
async def test_only_a_visitors_own_live_conversation_can_be_resumed(
    rig: Rig, web_signing_key: Ed25519PrivateKey, which: str
) -> None:
    """Another visitor's conversation, one that doesn't exist and one that has expired are all just not found."""
    owner = Tab(web_signing_key, DAN)
    owned = (await owner.hello())["conversation"]
    await owner.leave()
    if which == "expired":
        await fetch(
            lambda: Conversation.objects.filter(public_id=owned).update(expires_at=rig.clock() - timedelta(minutes=1))
        )
    tab = Tab(web_signing_key, DAN if which == "expired" else JANA)

    await tab.connect()
    await tab.send(
        {"type": "hello", "token": tab.token, "conversation": "AAAAAAAAAAAAAAAA" if which == "unknown" else owned}
    )
    error = await tab.event()

    assert error == {
        "type": "error",
        "code": "conversation_gone",
        "message": ERROR_SENTENCES[ErrorCode.CONVERSATION_GONE],
    }
    assert await tab.close_code() == 4404


async def test_a_visitor_may_start_ten_conversations_a_day(web_signing_key: Ed25519PrivateKey) -> None:
    """The eleventh hello is told so, and closed with 4429."""
    for _ in range(10):
        tab = Tab(web_signing_key)
        assert (await tab.hello())["type"] == "ready"
        await tab.leave()
    eleventh = Tab(web_signing_key)

    error = await eleventh.hello()

    assert error["code"] == "too_many_conversations"
    assert await eleventh.close_code() == 4429
    assert await count(lambda: Conversation.objects.filter(session_key=JANA)) == 10


async def test_a_conversation_that_has_been_deleted_ends_the_session_politely(
    web_signing_key: Ed25519PrivateKey,
) -> None:
    """The 24-hour sweep can remove a conversation under an open page: the next message is told so and closed."""
    tab = Tab(web_signing_key)
    ready = await tab.hello()
    await fetch(lambda: Conversation.objects.filter(public_id=ready["conversation"]).delete())

    await tab.send({"type": "message", "text": "Are you still there?"})
    assert await tab.event() == {"type": "working"}
    error = await tab.event()

    assert error["code"] == "conversation_gone"
    assert await tab.close_code() == 4404


async def test_two_tabs_of_one_conversation_take_turns(rig: Rig, web_signing_key: Ed25519PrivateKey) -> None:
    """Messages sent at the same moment from two tabs are answered one after the other, each in its place."""
    rig.models.replies += [say("First answer."), say("Second answer.")]
    first_tab, second_tab = Tab(web_signing_key), Tab(web_signing_key)
    ready = await first_tab.hello()
    await second_tab.hello(conversation=ready["conversation"])

    await asyncio.gather(
        first_tab.send({"type": "message", "text": "Hello from the first tab."}),
        second_tab.send({"type": "message", "text": "Hello from the second tab."}),
    )
    answers = {
        (await first_tab.event(), await first_tab.event())[1]["text"],
        (await second_tab.event(), await second_tab.event())[1]["text"],
    }

    assert answers == {"First answer.", "Second answer."}
    positions = await fetch(
        lambda: [m.position for m in Message.objects.filter(conversation__public_id=ready["conversation"])]
    )
    assert positions == [1, 2, 3, 4]
    await first_tab.leave()
    await second_tab.leave()


# The live calendar


async def test_a_second_tab_watches_the_slot_move_from_held_to_booked(
    rig: Rig, web_signing_key: Ed25519PrivateKey
) -> None:
    """The datasheet's demo: one visitor holds and books a slot, another's calendar follows, with no hint whose."""
    rig.script_booking()
    booker, watcher = Tab(web_signing_key, JANA), Tab(web_signing_key, DAN)
    await booker.hello()
    await watcher.hello()

    await booker.say(FIRST_MESSAGE)
    assert await watcher.quiet()
    hold_reply = await booker.say(SECOND_MESSAGE)
    watcher_sees_hold = await watcher.event()
    booker_sees_hold = await booker.event()
    await booker.say(THIRD_MESSAGE)
    watcher_sees_booking = await watcher.event()
    booker_sees_booking = await booker.event()

    slot = hold_reply["hold"]["slot"]
    assert watcher_sees_hold["type"] == "calendar"
    change = watcher_sees_hold["changes"][0]
    assert (change["slot"], change["status"], change["mine"]) == (slot, "held", False)
    assert "owner" not in change
    assert (booker_sees_hold["changes"][0]["status"], booker_sees_hold["changes"][0]["mine"]) == ("held", True)
    assert (watcher_sees_booking["changes"][0]["status"], watcher_sees_booking["changes"][0]["mine"]) == (
        "booked",
        False,
    )
    assert (booker_sees_booking["changes"][0]["status"], booker_sees_booking["changes"][0]["mine"]) == ("booked", True)
    await booker.leave()
    await watcher.leave()


async def test_a_second_tab_is_offered_only_what_is_still_free(rig: Rig, web_signing_key: Ed25519PrivateKey) -> None:
    """Both tabs asked for the 2:30 slot; once the first holds it, the second is offered others and holds one.

    The second tab's 2:30 slot was its number 1, and a number is never given to a second slot, so the
    first of the others it is offered afterwards is number 2.
    """
    rig.models.replies += [
        calling(call("update_details", **DETAILS)),
        say("The 2:30 slot is free."),
        calling(call("update_details", **(DETAILS | {"name": "Dan Wu"}))),
        say("The 2:30 slot is free."),
        calling(call("hold_slot", option=1)),
        calling(call("hold_slot", option=2)),
    ]
    first_tab, second_tab = Tab(web_signing_key, JANA), Tab(web_signing_key, DAN)
    await first_tab.hello()
    await second_tab.hello()
    await first_tab.say("Hi! A cupping for two tomorrow afternoon please. Jana Novak, jana@example.test.")
    await second_tab.say("Hi! A cupping for two tomorrow afternoon please. Dan Wu, dan@example.test.")

    first = await first_tab.say("The 2:30 one.")
    second = await second_tab.say("The first one you have, please.")

    assert (first["receipt"], second["receipt"]) == ("hold_placed", "hold_placed")
    assert first["hold"]["slot"] != second["hold"]["slot"]
    held = await fetch(lambda: sorted(Reservation.objects.filter(status="held").values_list("slot_id", flat=True)))
    assert held == sorted([first["hold"]["slot"], second["hold"]["slot"]])
    await first_tab.leave()
    await second_tab.leave()


async def test_a_slot_taken_while_the_model_is_thinking_is_refused_by_the_database(
    rig: Rig, web_signing_key: Ed25519PrivateKey
) -> None:
    """The race the refresh can't close: someone else holds the offered slot after the offer and before the hold."""
    rig.models.replies += [
        calling(call("update_details", **DETAILS)),
        say("The 2:30 slot is free."),
        calling(call("hold_slot", option=1)),
    ]
    tab = Tab(web_signing_key)
    ready = await tab.hello()
    await tab.say(FIRST_MESSAGE)
    watcher = Tab(web_signing_key, DAN)
    await watcher.hello()

    def another_visitor_clicks_first() -> None:
        """Hold the offered slot for someone else, as their own tab would, while this tab's model is still thinking."""
        rival = make_conversation(Offering.objects.get(key="cupping"), session="session-of-the-rival-visitor")
        offered = Conversation.objects.get(public_id=ready["conversation"]).offered_slots[0]
        rig.concierge.bookings.place_hold(rival, Slot.objects.select_related("offering").get(pk=offered))

    rig.models.meanwhile[len(rig.models.requests)] = another_visitor_clicks_first
    refused = await tab.say(SECOND_MESSAGE)

    assert refused["receipt"] == "slot_taken"
    assert refused["hold"] is None
    assert [tool["error"] for tool in refused["tools"]] == ["slot_unavailable"]
    assert await count(lambda: Reservation.objects.filter(status="held")) == 1
    assert (await watcher.event())["changes"][0]["status"] == "held"
    await tab.leave()
    await watcher.leave()


async def test_a_hold_that_runs_out_is_announced_when_the_sweep_runs(
    rig: Rig, web_signing_key: Ed25519PrivateKey
) -> None:
    """Six minutes later the slot is free to every tab: the sweep tidies the row and the live calendar hears of it."""
    rig.script_booking()
    booker, watcher = Tab(web_signing_key, JANA), Tab(web_signing_key, DAN)
    await booker.hello()
    await watcher.hello()
    await booker.say(FIRST_MESSAGE)
    await booker.say(SECOND_MESSAGE)
    await watcher.event()
    await booker.event()

    rig.clock.advance(6)
    swept = await fetch(lambda: [rig.concierge.bookings.expire_stale_holds()])

    assert swept == [1]
    freed = await watcher.event()
    assert [(change["status"], change["mine"]) for change in freed["changes"]] == [("free", False)]
    assert (await booker.event())["changes"][0]["status"] == "free"
    await booker.leave()
    await watcher.leave()


async def test_a_nightly_reset_tells_every_tab_to_load_the_calendar_again(web_signing_key: Ed25519PrivateKey) -> None:
    """The reset replaces every slot, so a client doesn't patch its picture: it fetches the snapshot afresh."""
    tab = Tab(web_signing_key)
    await tab.hello()

    await fetch(announce_reset)

    assert await tab.event() == {"type": "calendar_reset"}
    await tab.leave()


async def test_a_connection_that_has_not_said_hello_hears_nothing_of_the_calendar(
    web_signing_key: Ed25519PrivateKey,
) -> None:
    """The calendar group is joined only after the token checks out, so a bare connection never sees an event."""
    bare = Tab(web_signing_key)
    await bare.connect()

    await fetch(announce_reset)

    assert await bare.quiet()
    await bare.leave()


# The real channel layer


async def in_another_thread[Result](work: Callable[[], Result]) -> Result:
    """Run work on a thread that has nothing to do with the server's event loop, as a Celery worker's code does."""
    return await asyncio.get_running_loop().run_in_executor(None, closing_connections(work))


async def test_the_calendar_reaches_a_tab_through_real_redis_from_a_worker_thread(
    rig: Rig, web_signing_key: Ed25519PrivateKey, redis_url: str, redis_channel_layer: str
) -> None:
    """The sweep, the reset and other servers' bookings come from outside: their events must cross Redis."""
    assert type(get_channel_layer()).__name__ == "RedisChannelLayer"
    tab = Tab(web_signing_key)
    await tab.hello()
    cupping = await fetch(lambda: Offering.objects.get(key="cupping"))
    rival = await fetch(lambda: make_conversation(cupping, session="session-of-the-rival-visitor"))
    slot = await fetch(
        lambda: rig.concierge.bookings.free_slots(cupping, date(2026, 10, 2), date(2026, 10, 2), 2, "any", 1)[0]
    )
    # Fresh from the worker's side of things: a service that tells the channel layer, on a thread of its own.
    worker = BookingService(clock=rig.clock, notifier=ChannelLayerNotifier())

    await in_another_thread(announce_reset)
    reset = await tab.event()
    await in_another_thread(lambda: worker.place_hold(rival, slot))
    held = await tab.event()
    rig.clock.advance(6)
    await in_another_thread(worker.expire_stale_holds)
    freed = await tab.event()

    assert reset == {"type": "calendar_reset"}
    # The room is taken for the whole session, so every slot that overlaps it in that room is announced with it.
    assert slot.pk in {change["slot"] for change in held["changes"]}
    assert {(change["status"], change["mine"]) for change in held["changes"]} == {("held", False)}
    assert {change["slot"] for change in freed["changes"]} == {change["slot"] for change in held["changes"]}
    assert {change["status"] for change in freed["changes"]} == {"free"}
    keys = Redis.from_url(redis_url).keys(f"{redis_channel_layer}*")
    assert keys, "the channel layer wrote nothing under the test's own prefix"
    await tab.leave()


@pytest.mark.usefixtures("redis_channel_layer")
async def test_an_idle_tab_stays_connected_past_the_layers_blocking_read(web_signing_key: Ed25519PrivateKey) -> None:
    """A tab that does nothing waits on Redis in blocks, and its socket may not give up when a block ends.

    redis-py's default socket timeout is the same five seconds as channels-redis's block, so on the
    default settings the layer raised a TimeoutError out of an idle consumer about every five seconds
    and the WebSocket closed with 1006. The in-memory layer can't show that, so this runs on the
    settings production uses, waits one block and a little more, and checks the tab still hears
    the calendar.
    """
    tab = Tab(web_signing_key)
    await tab.hello()

    await asyncio.sleep(BLOCK_SECONDS + 1)
    await in_another_thread(announce_reset)

    assert await tab.event() == {"type": "calendar_reset"}
    await tab.leave()
