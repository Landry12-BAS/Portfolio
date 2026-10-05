"""Integration tests for LB-09's WebSocket: the hello, the limits, and the stages that reach a page as the worker works.

Everything is real except the worker: the ASGI application and its routes, the token check, Postgres, and the
in-memory channel layer. A stage is announced the way the worker announces it (lb09/progress.py, on a worker
thread), and the test reads what the page would read.
"""

from typing import Any

import pytest
from channels.testing import WebsocketCommunicator
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from lb09 import consumers
from lb09.events import ErrorCode
from lb09.limits import MAX_FRAME_BYTES
from lb09.models import Meeting
from lb09.pipeline import mark_failed
from lb09.progress import record_stage

from config.asgi import application
from core.blocking import run_blocking
from tests.lb02_support import mint_token

pytestmark = [pytest.mark.integration, pytest.mark.django_db(databases=["lb09"], transaction=True)]

JANA = "session-of-jana-visitor-01"
DAN = "session-of-dan-visitor-002"
PATIENCE_SECONDS = 10


@pytest.fixture(autouse=True)
def quick_timers(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make the linger after the end short, and forget every visitor's connections between tests."""
    monkeypatch.setattr(consumers, "LINGER_AFTER_END_SECONDS", 0.2)
    consumers.CONNECTIONS.counts.clear()


class Tab:
    """One browser tab: a WebSocket to the meeting's progress, the hello it sends, and the events it gets."""

    def __init__(self, key: Ed25519PrivateKey, session: str = JANA) -> None:
        """Prepare a connection for a visitor, with a token the site would mint for them."""
        self.communicator = WebsocketCommunicator(application, "/ws/lb09/")
        self.token = mint_token(key, session, "lb-09")

    async def hello(self, meeting: str, token: str | None = None) -> dict[str, Any]:
        """Open the connection and say hello; return the first event the server sends."""
        connected, _ = await self.communicator.connect()
        assert connected
        await self.send({"type": "hello", "token": token or self.token, "meeting": meeting})
        return await self.event()

    async def send(self, frame: dict[str, object]) -> None:
        """Send a frame."""
        await self.communicator.send_json_to(frame)

    async def event(self) -> dict[str, Any]:
        """Wait for the next event."""
        event: dict[str, Any] = await self.communicator.receive_json_from(timeout=PATIENCE_SECONDS)
        return event

    async def close_code(self) -> int:
        """Wait for the server to close the connection, and return its code."""
        output = await self.communicator.receive_output(timeout=PATIENCE_SECONDS)
        assert output["type"] == "websocket.close", output
        code: int = output["code"]
        return code

    async def leave(self) -> None:
        """Close the connection from the client's side."""
        await self.communicator.disconnect()


def make_meeting(session: str = JANA) -> Meeting:
    """Make a received meeting, as the API leaves it."""
    return Meeting.objects.create(
        session_key=session, mode="fast", run_id="run-" + "d" * 12, audio_name="x" * 24 + ".audio"
    )


async def test_the_hello_is_answered_with_the_meetings_state_and_every_stage_follows(
    web_signing_key: Ed25519PrivateKey,
) -> None:
    """The page sees `received`, each stage the worker announces, then `done`, and the connection closes after it."""
    meeting = await run_blocking(make_meeting)
    tab = Tab(web_signing_key)
    first = await tab.hello(meeting.public_id)
    assert (first["type"], first["meeting"], first["status"], first["stage"], first["failure"]) == (
        "state",
        meeting.public_id,
        "received",
        "received",
        None,
    )
    assert first["run_id"] == meeting.run_id
    await run_blocking(record_stage, meeting, "transcribing", duration_seconds=12.5)
    stage = await tab.event()
    assert (stage["type"], stage["stage"]) == ("state", "transcribing")
    await run_blocking(record_stage, meeting, "done", status="done", model_calls=2, dropped_items=1)
    done = await tab.event()
    assert (done["status"], done["stage"], done["model_calls"], done["dropped_items"]) == ("done", "done", 2, 1)
    assert await tab.close_code() == 1000


async def test_a_failed_meeting_is_announced_with_its_reason(web_signing_key: Ed25519PrivateKey) -> None:
    """A failure reaches the page as a state with the reason's code, never an error's words."""
    meeting = await run_blocking(make_meeting)
    tab = Tab(web_signing_key)
    await tab.hello(meeting.public_id)
    await run_blocking(mark_failed, meeting, "too_long")
    failed = await tab.event()
    assert (failed["status"], failed["stage"], failed["failure"]) == ("failed", "failed", "too_long")
    assert await tab.close_code() == 1000


async def test_a_meeting_that_is_already_over_is_shown_and_the_connection_closed(
    web_signing_key: Ed25519PrivateKey,
) -> None:
    """A page that connects late gets the final state at once."""
    meeting = await run_blocking(make_meeting)
    await run_blocking(record_stage, meeting, "done", status="done")
    tab = Tab(web_signing_key)
    assert (await tab.hello(meeting.public_id))["status"] == "done"
    assert await tab.close_code() == 1000


async def test_a_bad_token_closes_the_connection_without_a_word(web_signing_key: Ed25519PrivateKey) -> None:
    """A token for another system, or a made-up one, is 4401 and nothing is read or sent."""
    meeting = await run_blocking(make_meeting)
    other = Tab(web_signing_key)
    await other.communicator.connect()
    await other.send(
        {"type": "hello", "token": mint_token(web_signing_key, JANA, "lb-02"), "meeting": meeting.public_id}
    )
    assert await other.close_code() == 4401
    forged = Tab(web_signing_key)
    await forged.communicator.connect()
    await forged.send({"type": "hello", "token": "not-a-token", "meeting": meeting.public_id})
    assert await forged.close_code() == 4401


async def test_another_visitors_meeting_is_not_found(web_signing_key: Ed25519PrivateKey) -> None:
    """Dan asks for Jana's meeting: `meeting_gone`, then 4404, which is what a meeting that never existed gets too."""
    meeting = await run_blocking(make_meeting)
    tab = Tab(web_signing_key, DAN)
    first = await tab.hello(meeting.public_id)
    assert (first["type"], first["code"]) == ("error", ErrorCode.MEETING_GONE)
    assert await tab.close_code() == 4404


async def test_a_frame_that_is_not_a_hello_first_closes_the_connection(web_signing_key: Ed25519PrivateKey) -> None:
    """Not JSON, a frame with an extra field, a binary frame and an oversized one are each refused."""
    for frame in (
        "hello?",
        '{"type": "hello", "token": "t", "meeting": "AAAAAAAAAAAAAAAA", "more": 1}',
        '{"type": "state"}',
    ):
        tab = Tab(web_signing_key)
        await tab.communicator.connect()
        await tab.communicator.send_to(text_data=frame)
        assert await tab.close_code() == 4400
    binary = Tab(web_signing_key)
    await binary.communicator.connect()
    await binary.communicator.send_to(bytes_data=b"\x00")
    assert await binary.close_code() == 1003
    big = Tab(web_signing_key)
    await big.communicator.connect()
    await big.communicator.send_to(text_data="x" * (MAX_FRAME_BYTES + 1))
    assert await big.close_code() == 1009


async def test_a_second_frame_is_refused_and_a_chatty_client_is_closed(web_signing_key: Ed25519PrivateKey) -> None:
    """The connection only listens: another hello gets `already_said_hello`, and too many frames close it."""
    meeting = await run_blocking(make_meeting)
    tab = Tab(web_signing_key)
    await tab.hello(meeting.public_id)
    await tab.send({"type": "hello", "token": tab.token, "meeting": meeting.public_id})
    again = await tab.event()
    assert (again["type"], again["code"]) == ("error", ErrorCode.ALREADY_SAID_HELLO)
    for _ in range(10):
        await tab.send({"type": "hello", "token": tab.token, "meeting": meeting.public_id})
    codes = []
    while True:
        output = await tab.communicator.receive_output(timeout=PATIENCE_SECONDS)
        if output["type"] == "websocket.close":
            codes.append(output["code"])
            break
    assert codes == [4400]


async def test_no_hello_in_time_closes_the_connection(
    web_signing_key: Ed25519PrivateKey, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A connection that says nothing is closed with 4408."""
    monkeypatch.setattr(consumers, "HELLO_TIMEOUT_SECONDS", 0.2)
    tab = Tab(web_signing_key)
    await tab.communicator.connect()
    assert await tab.close_code() == 4408


async def test_a_visitor_may_hold_four_connections_and_the_fifth_is_turned_away(
    web_signing_key: Ed25519PrivateKey,
) -> None:
    """The fifth tab gets `too_many_connections` and 1013; once a tab leaves, a new one is let in."""
    meeting = await run_blocking(make_meeting)
    tabs = [Tab(web_signing_key) for _ in range(4)]
    for tab in tabs:
        assert (await tab.hello(meeting.public_id))["type"] == "state"
    fifth = Tab(web_signing_key)
    refused = await fifth.hello(meeting.public_id)
    assert (refused["type"], refused["code"]) == ("error", ErrorCode.TOO_MANY_CONNECTIONS)
    assert await fifth.close_code() == 1013
    await tabs[0].leave()
    sixth = Tab(web_signing_key)
    assert (await sixth.hello(meeting.public_id))["type"] == "state"
    for tab in [*tabs[1:], sixth]:
        await tab.leave()
    assert consumers.CONNECTIONS.open_for(JANA) == 0
