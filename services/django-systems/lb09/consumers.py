"""LB-09's WebSocket: a visitor's live view of one meeting's progress while the worker goes through it.

The connection only listens. Its first and only frame is a hello with the visitor token and the meeting to
follow; the token travels in the frame, never in the address, because addresses end up in proxy and access
logs and a frame is in none of them (LB-02's consumer says the rest). The server accepts the handshake to read
that frame, checks the token against the site's key before anything else is read or sent, counts the
visitor's connections (a visitor may hold a few), finds the meeting among the visitor's own, joins its group,
sends its state now, then sends every state the worker announces (lb09/progress.py) until the meeting ends,
lingers a few seconds so the page reads the last one, and closes. A second frame, a frame that is not a
hello, a binary or oversized frame, ten seconds without a hello, or minutes of silence close it.

A socket can drop, and a page that loses it polls `GET /api/lb09/meetings/{id}` instead: the row and the
socket say the same thing, because the worker writes the row before it tells the group.
"""

import asyncio
import logging
from typing import Any

from channels.generic.websocket import AsyncWebsocketConsumer
from pydantic import ValidationError

from core.blocking import run_blocking
from core.visitors import VisitorTokenError, visitor_from_token
from lb02.connections import ConnectionCounts
from lb09.events import CloseCode, ErrorCode, Hello, State, is_over, parse_hello, problem, state_of
from lb09.limits import (
    HELLO_TIMEOUT_SECONDS,
    IDLE_TIMEOUT_SECONDS,
    LINGER_AFTER_END_SECONDS,
    MAX_CONNECTIONS_PER_VISITOR,
    MAX_FRAME_BYTES,
    MAX_FRAMES_PER_CONNECTION,
)
from lb09.meetings import own_meeting
from lb09.progress import meeting_group

logger = logging.getLogger(__name__)

# The system a visitor token must be minted for.
SYSTEM = "lb-09"
# Every visitor's open connections in this process, so one visitor can't hold them all.
CONNECTIONS = ConnectionCounts(MAX_CONNECTIONS_PER_VISITOR)


def find_state_sync(session_key: str, public_id: str) -> State | None:
    """Read the visitor's own meeting and describe where it stands, or None when there is no such meeting."""
    meeting = own_meeting(session_key, public_id)
    return state_of(meeting) if meeting is not None else None


class ProgressConsumer(AsyncWebsocketConsumer):  # type: ignore[misc]
    """One visitor's connection: it says hello with its token, then is told each stage the worker reaches."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        """Start as a connection nobody has vouched for."""
        super().__init__(*args, **kwargs)
        self.meeting_id = ""
        self.visitor_key = ""
        self.counted = False
        self.joined = False
        self.closing = False
        self.frames = 0
        self.timer: asyncio.TimerHandle | None = None
        self.closer: asyncio.Task[None] | None = None

    async def connect(self) -> None:
        """Accept the handshake, and give the visitor ten seconds to say hello."""
        await self.accept()
        self.arm_timer(HELLO_TIMEOUT_SECONDS)

    async def disconnect(self, code: int) -> None:  # noqa: ARG002 - Channels' signature
        """Let go of everything the connection held."""
        self.closing = True
        self.disarm_timer()
        if self.counted:
            self.counted = False
            CONNECTIONS.leave(self.visitor_key)
        if self.joined:
            self.joined = False
            await self.channel_layer.group_discard(meeting_group(self.meeting_id), self.channel_name)

    async def receive(self, text_data: str | None = None, bytes_data: bytes | None = None) -> None:  # noqa: ARG002
        """Take one frame: the hello, and nothing after it."""
        if self.closing:
            return
        if text_data is None:
            await self.shut(CloseCode.UNSUPPORTED)
            return
        if len(text_data.encode("utf-8")) > MAX_FRAME_BYTES:
            await self.shut(CloseCode.TOO_BIG)
            return
        self.frames += 1
        if self.meeting_id:
            await self.refuse_more()
            return
        try:
            hello = parse_hello(text_data)
        except ValidationError:
            await self.shut(CloseCode.BAD_FRAME)
            return
        await self.greet(hello)

    async def refuse_more(self) -> None:
        """Tell a client that sends more than its hello that nothing more is listened to, and close a chatty one."""
        if self.frames > MAX_FRAMES_PER_CONNECTION:
            await self.shut(CloseCode.BAD_FRAME)
            return
        await self.tell(problem(ErrorCode.ALREADY_SAID_HELLO))

    async def greet(self, hello: Hello) -> None:
        """Check the token, count the visitor, find their meeting, join its group and send its state."""
        try:
            visitor = visitor_from_token(hello.token, SYSTEM)
        except VisitorTokenError:
            await self.shut(CloseCode.UNAUTHORIZED)
            return
        except ValueError:
            logger.error("The site's public key (LB_WEB_TOKEN_KEY) is not a valid key, so no visitor can be checked.")
            await self.shut(CloseCode.UNAVAILABLE)
            return
        if not CONNECTIONS.enter(visitor.session_key):
            await self.tell(problem(ErrorCode.TOO_MANY_CONNECTIONS))
            await self.shut(CloseCode.TRY_AGAIN_LATER)
            return
        self.visitor_key = visitor.session_key
        self.counted = True
        # The group is joined before the row is read, so a stage announced in between still reaches this connection.
        await self.channel_layer.group_add(meeting_group(hello.meeting), self.channel_name)
        self.joined = True
        self.meeting_id = hello.meeting
        state = await run_blocking(find_state_sync, visitor.session_key, hello.meeting)
        if state is None:
            await self.tell(problem(ErrorCode.MEETING_GONE))
            await self.shut(CloseCode.NOT_FOUND)
            return
        await self.show(state)

    async def meeting_progress(self, event: dict[str, Any]) -> None:
        """Pass a state the worker announced on to the client."""
        await self.show(State.model_validate(event["state"]))

    async def show(self, state: State) -> None:
        """Send a state, and once the meeting is over, keep the connection a few seconds and close it."""
        await self.tell(state)
        if is_over(state):
            self.arm_timer(LINGER_AFTER_END_SECONDS, CloseCode.NORMAL)
        else:
            self.arm_timer(IDLE_TIMEOUT_SECONDS)

    async def shut(self, code: CloseCode) -> None:
        """Close the connection for good, and ignore whatever arrives after."""
        self.closing = True
        self.disarm_timer()
        await self.close(code=int(code))

    async def tell(self, event: State | Any) -> None:
        """Send the client an event, unless the connection is closing or the client has already gone."""
        if self.closing:
            return
        try:
            await self.send(text_data=event.model_dump_json())
        except OSError:
            logger.debug("The client of meeting %s had gone when it was told something.", self.meeting_id)

    def arm_timer(self, seconds: float, code: CloseCode = CloseCode.TIMED_OUT) -> None:
        """Close the connection with `code` after `seconds`, replacing any timer already running."""
        self.disarm_timer()
        if not self.closing:
            self.timer = asyncio.get_running_loop().call_later(seconds, self.time_out, code)

    def disarm_timer(self) -> None:
        """Stop the timer, if one is running."""
        if self.timer is not None:
            self.timer.cancel()
            self.timer = None

    def time_out(self, code: CloseCode) -> None:
        """Close the connection; the task is kept so it can't be collected half done."""
        self.closer = asyncio.ensure_future(self.shut(code))
