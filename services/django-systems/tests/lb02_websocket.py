"""What LB-02's WebSocket tests share: a browser tab to talk through, and the fixtures that serve the concierge to it.

A `Tab` is a WebSocket to the real ASGI application with the frames a page would send, so a test
reads like what a visitor does. The concierge behind it is built on fakes (`rig`): the models are a
script, so a test chooses what they say and checks what the service does with it.
"""

import asyncio
import threading
from collections.abc import Callable
from typing import Any

import pytest
from channels.testing import WebsocketCommunicator
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from django.db.models import QuerySet

from config.asgi import application
from core.blocking import closing_connections, run_blocking
from lb02 import consumers
from lb02.live import ChannelLayerNotifier
from tests.lb02_support import Rig, build_rig, mint_token

JANA = "session-of-jana-visitor-01"
DAN = "session-of-dan-visitor-002"
# How long a test waits for the server, so a hang fails the test instead of stalling it.
PATIENCE_SECONDS = 10


def serve_concierge(monkeypatch: pytest.MonkeyPatch) -> Rig:
    """Build the concierge on fakes, with its calendar changes sent through the channel layer, and serve it."""
    built = build_rig(notifier=ChannelLayerNotifier())
    monkeypatch.setattr(consumers, "shared_concierge", lambda: built.concierge)
    return built


def forget_connections() -> None:
    """Count no visitor's connections, as a fresh process would.

    A test that only looks at how the server closes never sends the disconnect a real server sends
    afterwards, so its connection would otherwise be counted for the rest of the run.
    """
    consumers.CONNECTIONS.counts.clear()


class Gate:
    """Holds a turn on its worker thread, in the middle of its model call, until the test lets it go.

    The scripted model runs `hold` while it "thinks" (`ScriptedToolChat.meanwhile`), so the visitor's
    line is already in the transcript and the answer is not: the state a dropped connection leaves.
    """

    def __init__(self) -> None:
        """Make a gate that is shut and that nobody has reached."""
        self.arrived = threading.Event()
        self.released = threading.Event()

    def hold(self) -> None:
        """Say the turn has got this far, and wait to be let go."""
        self.arrived.set()
        if not self.released.wait(timeout=PATIENCE_SECONDS):
            raise TimeoutError("The test never let the turn go.")

    async def arrival(self) -> None:
        """Wait, without blocking the event loop, until the turn has got to the gate."""
        arrived = await asyncio.get_running_loop().run_in_executor(None, self.arrived.wait, PATIENCE_SECONDS)
        assert arrived, "The turn never got to the gate."

    def release(self) -> None:
        """Let the turn go on."""
        self.released.set()


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

    async def calendar_event(self) -> dict[str, Any]:
        """Return the next calendar event: one that arrived while a message was being answered, or the next to come."""
        if self.calendar:
            return self.calendar.pop(0)
        return await self.event()

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

    async def drop(self) -> None:
        """Lose the connection the way a network does: the server hears of it, and nobody waits for it to finish."""
        await self.communicator.send_input({"type": "websocket.disconnect", "code": 1006})


async def count(rows: Callable[[], QuerySet[Any]]) -> int:
    """Count rows from a coroutine, which may not touch the database directly."""
    return await run_blocking(lambda: rows().count())


async def fetch[Row](read: Callable[[], Row]) -> Row:
    """Run a database read from a coroutine."""
    return await run_blocking(read)


async def in_another_thread[Result](work: Callable[[], Result]) -> Result:
    """Run work on a thread that has nothing to do with the server's event loop, as a Celery worker's code does."""
    return await asyncio.get_running_loop().run_in_executor(None, closing_connections(work))
