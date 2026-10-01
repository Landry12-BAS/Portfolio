"""LB-02's WebSocket: a visitor's live connection to the booking concierge, and to the live calendar.

How a connection is trusted
---------------------------
The visitor token travels in the first frame, never in the address. An address ends up in
proxy and access logs, in browser history and in referrers; a message body is in none of them,
and the token is a bearer credential for five minutes. (A subprotocol header would keep it out
of the address too, but headers are logged by more proxies than message bodies are, and the
protocol would be misused to carry a secret.)

The server has to accept the handshake to read that frame, so a connection is trusted in
stages, and nothing that matters happens before the last one:

1. Accepted, and nothing else. The only frame it may send is `hello`, within 10 seconds; any
   other frame, a binary one, an oversized one or silence closes it.
2. `hello` is checked against the site's public key (core.visitors) before anything else is
   read from the database or sent to the client. A token that is missing, malformed, expired,
   signed by anyone else, minted for another system, or checked with no key configured closes
   the connection with 4401, and says nothing about why.
3. Only then is the conversation started or resumed (a visitor's own, never another's), the
   connection joins the live calendar group, and `ready` is sent.

No Origin check: the connection carries no cookie and no ambient credential, so a page on
another site can't use a visitor's browser to speak as them; it could only connect with a
token it already has.

How a conversation is served
----------------------------
Messages are taken one at a time, in order. A model call can take many seconds and blocks, so
each turn runs on a worker thread of its own (core/blocking.py; never the single thread
Channels' database helper shares by default, which would stall every other visitor), and two
tabs of one conversation take turns instead of overlapping. The 30-message limit, the call budget and
every booking rule are enforced by the concierge and the database underneath, not here; this
module only carries frames.

Calendar events reach every connection through the channel layer. Each connection turns them
into its own visitor's point of view: the slot this conversation holds is `mine`, everyone
else's is only `held` or `booked`.
"""

import asyncio
import logging
from dataclasses import dataclass
from functools import cache
from typing import Any
from weakref import WeakValueDictionary

from channels.generic.websocket import AsyncWebsocketConsumer
from pydantic import BaseModel, ValidationError

from core.blocking import run_blocking
from core.visitors import VisitorTokenError, visitor_from_token
from lb02.concierge import Concierge, TurnResult, connect_concierge
from lb02.conversations import ConversationLimitError, own_conversation, start_conversation
from lb02.events import (
    Calendar,
    CalendarReset,
    ClientFrame,
    CloseCode,
    ErrorCode,
    Hello,
    Ready,
    Say,
    Working,
    is_too_long,
    parse_client_frame,
    problem,
    ready_event,
    reply_event,
    slot_view,
)
from lb02.limits import HELLO_TIMEOUT_SECONDS, IDLE_TIMEOUT_SECONDS, MAX_FRAME_BYTES
from lb02.live import CALENDAR_GROUP
from lb02.models import Conversation, Message
from lb02.snapshot import snapshot_of

logger = logging.getLogger(__name__)

# The system a visitor token must be minted for.
SYSTEM = "lb-02"
# The conversations a process is taking a turn in, so two tabs of one conversation take turns. Held weakly: a
# lock lives as long as someone holds or awaits it.
TURN_LOCKS: WeakValueDictionary[str, asyncio.Lock] = WeakValueDictionary()


@cache
def shared_concierge() -> Concierge:
    """Build the concierge once per process: it holds the gateway connection, and every conversation shares it."""
    return connect_concierge()


@dataclass(frozen=True)
class Opened:
    """A conversation just started or resumed: its primary key, and the `ready` event that describes it."""

    pk: int
    ready: Ready


def lock_for(conversation_id: str) -> asyncio.Lock:
    """Return the lock that serialises the turns of one conversation in this process."""
    lock = TURN_LOCKS.get(conversation_id)
    if lock is None:
        lock = asyncio.Lock()
        TURN_LOCKS[conversation_id] = lock
    return lock


def open_conversation_sync(session_key: str, public_id: str | None, concierge: Concierge) -> Opened | None:
    """Start a conversation for the visitor, or resume one of their own; None when there is no such conversation.

    Raises ConversationLimitError when the visitor has started their ten for the day.
    """
    now = concierge.clock()
    if public_id is None:
        conversation = start_conversation(session_key, now)
    else:
        found = own_conversation(session_key, public_id)
        if found is None or found.expires_at <= now:
            return None
        conversation = found
    snapshot = snapshot_of(conversation, concierge.bookings)
    transcript = list(Message.objects.filter(conversation=conversation).order_by("position"))
    return Opened(conversation.pk, ready_event(conversation.public_id, public_id is not None, snapshot, transcript))


def take_turn_sync(conversation_pk: int, text: str, concierge: Concierge) -> TurnResult:
    """Read the conversation afresh, since another tab may have changed it, and answer one message."""
    conversation = Conversation.objects.select_related("offering").get(pk=conversation_pk)
    return concierge.take_turn(conversation, text)


class ConciergeConsumer(AsyncWebsocketConsumer):  # type: ignore[misc]
    """One visitor's connection: it says hello with its token, then talks to the concierge and watches the calendar."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        """Start as a connection nobody has vouched for."""
        super().__init__(*args, **kwargs)
        # Set once the hello has been checked; until then the connection may do nothing.
        self.conversation_pk: int | None = None
        self.conversation_id = ""
        self.concierge: Concierge | None = None
        self.in_calendar = False
        self.closing = False
        self.timer: asyncio.TimerHandle | None = None
        self.closer: asyncio.Task[None] | None = None

    # The connection's life

    async def connect(self) -> None:
        """Accept the handshake, and give the visitor ten seconds to say hello."""
        await self.accept()
        self.arm_timer(HELLO_TIMEOUT_SECONDS)

    async def disconnect(self, code: int) -> None:  # noqa: ARG002 - Channels' signature
        """Stop the timer and leave the calendar group."""
        self.closing = True
        self.disarm_timer()
        if self.in_calendar:
            self.in_calendar = False
            await self.channel_layer.group_discard(CALENDAR_GROUP, self.channel_name)

    async def receive(self, text_data: str | None = None, bytes_data: bytes | None = None) -> None:  # noqa: ARG002
        """Take one frame: check its size and shape, then treat it as a hello or as a message."""
        if self.closing:
            return
        if text_data is None:
            await self.shut(CloseCode.UNSUPPORTED)
            return
        if len(text_data.encode("utf-8")) > MAX_FRAME_BYTES:
            await self.shut(CloseCode.TOO_BIG)
            return
        try:
            frame = parse_client_frame(text_data)
        except ValidationError as error:
            await self.refuse(error)
            return
        if self.conversation_pk is None:
            await self.greet(frame)
        else:
            await self.hear(frame)

    async def shut(self, code: CloseCode) -> None:
        """Close the connection for good, and ignore whatever arrives after."""
        self.closing = True
        self.disarm_timer()
        await self.close(code=int(code))

    async def tell(self, event: BaseModel) -> None:
        """Send the client an event."""
        await self.send(text_data=event.model_dump_json())

    # Timers: ten seconds to say hello, a quarter of an hour of silence after

    def arm_timer(self, seconds: float) -> None:
        """Close the connection if nothing arrives for this long, replacing any timer already running."""
        self.disarm_timer()
        self.timer = asyncio.get_running_loop().call_later(seconds, self.time_out)

    def disarm_timer(self) -> None:
        """Stop the timer, if one is running."""
        if self.timer is not None:
            self.timer.cancel()
            self.timer = None

    def time_out(self) -> None:
        """Close a connection that has gone quiet; the task is kept so it can't be collected half done."""
        self.closer = asyncio.ensure_future(self.shut(CloseCode.TIMED_OUT))

    # Hello

    async def greet(self, frame: ClientFrame) -> None:
        """Check the first frame, which must be a hello with a good token, and open the conversation it asks for."""
        if not isinstance(frame, Hello):
            await self.shut(CloseCode.BAD_FRAME)
            return
        try:
            visitor = visitor_from_token(frame.token, SYSTEM)
        except VisitorTokenError:
            await self.shut(CloseCode.UNAUTHORIZED)
            return
        except ValueError:
            logger.error("The site's public key (LB_WEB_TOKEN_KEY) is not a valid key, so no visitor can be checked.")
            await self.shut(CloseCode.UNAVAILABLE)
            return
        try:
            concierge = shared_concierge()
        except (ValueError, OSError):
            logger.error("The concierge could not be set up: the gateway settings are missing or wrong.")
            await self.shut(CloseCode.UNAVAILABLE)
            return
        try:
            opened = await run_blocking(open_conversation_sync, visitor.session_key, frame.conversation, concierge)
        except ConversationLimitError:
            await self.tell(problem(ErrorCode.TOO_MANY_CONVERSATIONS))
            await self.shut(CloseCode.TOO_MANY_CONVERSATIONS)
            return
        if opened is None:
            await self.tell(problem(ErrorCode.CONVERSATION_GONE))
            await self.shut(CloseCode.NOT_FOUND)
            return
        self.concierge = concierge
        self.conversation_pk = opened.pk
        self.conversation_id = opened.ready.conversation
        await self.channel_layer.group_add(CALENDAR_GROUP, self.channel_name)
        self.in_calendar = True
        self.arm_timer(IDLE_TIMEOUT_SECONDS)
        await self.tell(opened.ready)

    # Messages

    async def refuse(self, error: ValidationError) -> None:
        """Answer a frame that isn't in the protocol: close before the hello, and say so after it."""
        if self.conversation_pk is None:
            await self.shut(CloseCode.BAD_FRAME)
        elif is_too_long(error):
            await self.tell(problem(ErrorCode.MESSAGE_TOO_LONG))
        else:
            await self.tell(problem(ErrorCode.INVALID_FRAME))

    async def hear(self, frame: ClientFrame) -> None:
        """Answer a visitor's message, and refuse a second hello."""
        if not isinstance(frame, Say):
            await self.tell(problem(ErrorCode.ALREADY_SAID_HELLO))
            return
        if self.conversation_pk is None or self.concierge is None:
            await self.shut(CloseCode.BAD_FRAME)
            return
        self.arm_timer(IDLE_TIMEOUT_SECONDS)
        await self.tell(Working())
        async with lock_for(self.conversation_id):
            try:
                result = await run_blocking(take_turn_sync, self.conversation_pk, frame.text, self.concierge)
            except Conversation.DoesNotExist:
                await self.tell(problem(ErrorCode.CONVERSATION_GONE))
                await self.shut(CloseCode.NOT_FOUND)
                return
        await self.tell(reply_event(result))
        self.arm_timer(IDLE_TIMEOUT_SECONDS)

    # The live calendar

    async def calendar_changed(self, event: dict[str, Any]) -> None:
        """Pass on the slots that changed, as this visitor sees them."""
        changes = [slot_view(change, viewer=self.conversation_pk) for change in event["changes"]]
        await self.tell(Calendar(changes=changes))

    async def calendar_reset(self, event: dict[str, Any]) -> None:  # noqa: ARG002 - Channels' signature
        """Tell the client the calendar was laid out afresh, so it loads the snapshot again."""
        await self.tell(CalendarReset())
