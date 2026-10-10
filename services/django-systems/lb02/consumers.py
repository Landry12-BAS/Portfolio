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
3. Only then is the visitor's connection counted (a visitor may hold only a few), the
   conversation started or resumed (a visitor's own, never another's), the connection joins the
   live calendar and the conversation's own group, and `ready` is sent.

No Origin check: the connection carries no cookie and no ambient credential, so a page on
another site can't use a visitor's browser to speak as them; it could only connect with a
token it already has.

How a conversation is served
----------------------------
Frames are read as they arrive, and a message is not answered where it is read. It joins a short
line (two messages a connection may have in hand: the one being answered and one behind it), and
a worker task of the connection answers them one at a time. A frame past the line is refused with
`too_many_pending`, so a client that never waits cannot pile work up in memory, and the calendar
keeps moving while a message is answered.

Each answer runs on a worker thread of its own (core/blocking.py; never the single thread
Channels' database helper shares by default, which would stall every other visitor), and two
tabs of one conversation take turns instead of overlapping. The 30-message limit, the call
budget and every booking rule are enforced by the concierge and the database underneath, not
here; this module only carries frames.

A turn is finished even if its connection is not. When the network cuts a connection while the
concierge is answering, the turn still ends, the answer is saved, and the connection that ran it
tells the conversation's group. A connection that resumed the conversation meanwhile was told in
`ready` that the answer was on its way (`pending`), and receives it from the group; one that
resumed after the turn ended finds the answer in the transcript. A turn that fails with an error
nobody planned for is not allowed to take the connection down: the visitor is sent
`turn_failed`, the conversation is left as it was, and the second failure in a row hands it to a
person.

Calendar events reach every connection through the channel layer. Each connection turns them
into its own visitor's point of view: the slot this conversation holds is `mine`, everyone
else's is only `held` or `booked`.
"""

import asyncio
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from functools import cache
from typing import Any
from weakref import WeakValueDictionary

from channels.exceptions import ChannelFull
from channels.generic.websocket import AsyncWebsocketConsumer
from pydantic import BaseModel, ValidationError
from redis.exceptions import RedisError

from core.blocking import run_blocking
from core.visitors import VisitorTokenError, visitor_from_token
from lb02.concierge import Concierge, TurnResult, connect_concierge
from lb02.connections import ConnectionCounts
from lb02.conversations import ConversationLimitError, own_conversation, start_conversation
from lb02.events import (
    SERVER_EVENTS,
    Calendar,
    CalendarReset,
    ClientFrame,
    CloseCode,
    ErrorCode,
    Hello,
    Problem,
    Ready,
    Reply,
    Say,
    Working,
    is_too_long,
    parse_client_frame,
    problem,
    ready_event,
    reply_event,
    slot_view,
)
from lb02.limits import (
    HELLO_TIMEOUT_SECONDS,
    IDLE_TIMEOUT_SECONDS,
    MAX_CONNECTIONS_PER_VISITOR,
    MAX_FRAME_BYTES,
    MAX_PENDING_MESSAGES,
)
from lb02.live import ANSWERED, CALENDAR_GROUP, conversation_group
from lb02.models import Conversation, Message
from lb02.snapshot import snapshot_of

logger = logging.getLogger(__name__)

# The system a visitor token must be minted for.
SYSTEM = "lb-02"
# The conversations a process is taking a turn in, so two tabs of one conversation take turns. Held weakly: a
# lock lives as long as someone holds or awaits it.
TURN_LOCKS: WeakValueDictionary[str, asyncio.Lock] = WeakValueDictionary()
# Every visitor's open connections in this process, so one visitor can't hold them all.
CONNECTIONS = ConnectionCounts(MAX_CONNECTIONS_PER_VISITOR)


@cache
def shared_concierge() -> Concierge:
    """Build the concierge once per process: it holds the gateway connection, and every conversation shares it."""
    return connect_concierge()


@dataclass(frozen=True)
class Opened:
    """A conversation just started or found: its primary key, its public ID, and whether it was resumed."""

    pk: int
    public_id: str
    resumed: bool


@dataclass(frozen=True)
class Described:
    """A conversation as `ready` tells it, where its transcript ends, and whether its last line wants an answer."""

    ready: Ready
    last_position: int
    awaiting_reply: bool


@dataclass(frozen=True)
class Answer:
    """How a turn ended, as the client is told: the reply or the error that says it failed, and the reply's place."""

    event: Reply | Problem
    position: int | None


def lock_for(conversation_id: str) -> asyncio.Lock:
    """Return the lock that serialises the turns of one conversation in this process."""
    lock = TURN_LOCKS.get(conversation_id)
    if lock is None:
        lock = asyncio.Lock()
        TURN_LOCKS[conversation_id] = lock
    return lock


def is_awaiting_reply(transcript: Sequence[Message]) -> bool:
    """Tell whether the last thing said wants an answer: the concierge's notes of what it did don't count as saying."""
    for line in reversed(transcript):
        if line.role != Message.Role.ACTION:
            return line.role == Message.Role.VISITOR
    return False


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
    return Opened(conversation.pk, conversation.public_id, public_id is not None)


def describe_sync(conversation_pk: int, resumed: bool, concierge: Concierge) -> Described:
    """Read the conversation afresh and describe it for `ready`: its state and its whole transcript."""
    conversation = Conversation.objects.select_related("offering").get(pk=conversation_pk)
    snapshot = snapshot_of(conversation, concierge.bookings)
    transcript = list(Message.objects.filter(conversation=conversation).order_by("position"))
    ready = ready_event(conversation.public_id, resumed, snapshot, transcript)
    last_position = transcript[-1].position if transcript else 0
    return Described(ready, last_position, is_awaiting_reply(transcript))


def take_turn_sync(conversation_pk: int, text: str, concierge: Concierge) -> TurnResult:
    """Read the conversation afresh, since another tab may have changed it, and answer one message."""
    conversation = Conversation.objects.select_related("offering").get(pk=conversation_pk)
    return concierge.take_turn(conversation, text)


def recover_sync(conversation_pk: int, concierge: Concierge) -> TurnResult | None:
    """Make the conversation usable after a turn failed: note it, count it, and hand over when it keeps happening."""
    conversation = Conversation.objects.select_related("offering").get(pk=conversation_pk)
    return concierge.turn_crashed(conversation)


class ConciergeConsumer(AsyncWebsocketConsumer):  # type: ignore[misc]
    """One visitor's connection: it says hello with its token, then talks to the concierge and watches the calendar."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        """Start as a connection nobody has vouched for."""
        super().__init__(*args, **kwargs)
        # Set once the hello has been checked; until then the connection may do nothing.
        self.conversation_pk: int | None = None
        self.conversation_id = ""
        self.concierge: Concierge | None = None
        # The visitor this connection is counted for, once it is.
        self.visitor_key = ""
        self.counted = False
        self.in_calendar = False
        self.in_conversation = False
        self.closing = False
        self.timer: asyncio.TimerHandle | None = None
        self.closer: asyncio.Task[None] | None = None
        # The messages accepted and not yet answered, and the task that answers them one at a time.
        self.waiting: asyncio.Queue[str] = asyncio.Queue()
        self.in_hand = 0
        self.answering = False
        self.worker: asyncio.Task[None] | None = None
        # What the client has been told: how far into the transcript, and whether it still waits for an answer.
        self.delivered_through = 0
        self.awaiting_reply = False

    # The connection's life

    async def connect(self) -> None:
        """Accept the handshake, and give the visitor ten seconds to say hello."""
        await self.accept()
        self.arm_timer(HELLO_TIMEOUT_SECONDS)

    async def disconnect(self, code: int) -> None:  # noqa: ARG002 - Channels' signature
        """Let go of everything the connection held, and let a turn in progress finish and pass its answer on.

        Messages that had not started are dropped: nobody was told they were being answered. The visitor's
        count is released first, so a client that comes straight back is not turned away by its own ghost.
        """
        self.closing = True
        self.disarm_timer()
        self.drop_waiting_messages()
        if self.counted:
            self.counted = False
            CONNECTIONS.leave(self.visitor_key)
        try:
            await self.leave_groups()
        finally:
            await self.finish_worker()

    async def leave_groups(self) -> None:
        """Stop hearing the calendar and the conversation's group."""
        if self.in_calendar:
            self.in_calendar = False
            await self.channel_layer.group_discard(CALENDAR_GROUP, self.channel_name)
        if self.in_conversation:
            self.in_conversation = False
            await self.channel_layer.group_discard(conversation_group(self.conversation_id), self.channel_name)

    def drop_waiting_messages(self) -> None:
        """Forget the messages that are waiting for their turn: a closed connection can't be told their answers."""
        while not self.waiting.empty():
            self.waiting.get_nowait()
            self.in_hand -= 1

    async def finish_worker(self) -> None:
        """Stop the worker once the message it is answering, if any, has been answered."""
        worker = self.worker
        self.worker = None
        if worker is None:
            return
        if not self.answering:
            worker.cancel()
        await asyncio.gather(worker, return_exceptions=True)

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
        """Send the client an event, unless the connection is closing or the client has already gone.

        An answer can be ready after its connection dropped, and then there is nobody to tell.
        """
        if self.closing:
            return
        try:
            await self.send(text_data=event.model_dump_json())
        except OSError:
            logger.debug("The client of conversation %s had gone when it was told something.", self.conversation_id)

    # Timers: ten seconds to say hello, a quarter of an hour of silence after

    def arm_timer(self, seconds: float) -> None:
        """Close the connection if nothing arrives for this long, replacing any timer already running."""
        self.disarm_timer()
        if not self.closing:
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
        if not CONNECTIONS.enter(visitor.session_key):
            await self.tell(problem(ErrorCode.TOO_MANY_CONNECTIONS))
            await self.shut(CloseCode.TRY_AGAIN_LATER)
            return
        self.visitor_key = visitor.session_key
        self.counted = True
        await self.open_conversation(frame, visitor.session_key, concierge)

    async def open_conversation(self, frame: Hello, session_key: str, concierge: Concierge) -> None:
        """Start or resume the visitor's conversation, join its groups, tell the client where it stands, and serve it.

        The conversation's group is joined before its transcript is read, so an answer saved after the
        transcript was read is certain to reach this connection through the group.
        """
        try:
            opened = await run_blocking(open_conversation_sync, session_key, frame.conversation, concierge)
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
        self.conversation_id = opened.public_id
        await self.channel_layer.group_add(CALENDAR_GROUP, self.channel_name)
        self.in_calendar = True
        await self.channel_layer.group_add(conversation_group(opened.public_id), self.channel_name)
        self.in_conversation = True
        described = await run_blocking(describe_sync, opened.pk, opened.resumed, concierge)
        pending = opened.resumed and described.awaiting_reply and lock_for(opened.public_id).locked()
        self.delivered_through = described.last_position
        self.awaiting_reply = described.awaiting_reply
        self.arm_timer(IDLE_TIMEOUT_SECONDS)
        await self.tell(described.ready.model_copy(update={"pending": pending}))
        self.worker = asyncio.ensure_future(self.serve())

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
        """Put a visitor's message in line to be answered, or refuse it: a second hello, or one too many at once."""
        if not isinstance(frame, Say):
            await self.tell(problem(ErrorCode.ALREADY_SAID_HELLO))
            return
        if self.conversation_pk is None or self.concierge is None:
            await self.shut(CloseCode.BAD_FRAME)
            return
        if self.in_hand >= MAX_PENDING_MESSAGES:
            await self.tell(problem(ErrorCode.TOO_MANY_PENDING))
            return
        self.in_hand += 1
        self.arm_timer(IDLE_TIMEOUT_SECONDS)
        self.waiting.put_nowait(frame.text)

    async def serve(self) -> None:
        """Answer the connection's messages one at a time, until the connection closes."""
        while not self.closing:
            text = await self.waiting.get()
            self.answering = True
            try:
                await self.answer(text)
            except Exception as error:  # noqa: BLE001 - one message's trouble must not end the loop
                logger.error(
                    "Answering a message failed with %s in conversation %s.", type(error).__name__, self.conversation_id
                )
            finally:
                self.answering = False
                self.in_hand -= 1

    async def answer(self, text: str) -> None:
        """Answer one message: say it is being worked on, take the turn, tell the client, and pass the answer on."""
        conversation_pk, concierge = self.conversation_pk, self.concierge
        if conversation_pk is None or concierge is None:
            return
        self.awaiting_reply = True
        await self.tell(Working())
        async with lock_for(self.conversation_id):
            outcome = await self.attempt(conversation_pk, concierge, text)
        if outcome is None:
            return
        await self.tell(outcome.event)
        self.awaiting_reply = False
        if outcome.position is not None:
            self.delivered_through = max(self.delivered_through, outcome.position)
        self.arm_timer(IDLE_TIMEOUT_SECONDS)
        await self.pass_on(outcome)

    async def attempt(self, conversation_pk: int, concierge: Concierge, text: str) -> Answer | None:
        """Take the turn, and say how it ended; None when the conversation is gone and the client has been told so.

        Whatever else goes wrong, the connection and the conversation go on: the error is logged by its type
        and the conversation's ID only, since what an error says may hold the visitor's words or a model's.
        """
        try:
            result = await run_blocking(take_turn_sync, conversation_pk, text, concierge)
        except Conversation.DoesNotExist:
            await self.tell(problem(ErrorCode.CONVERSATION_GONE))
            await self.shut(CloseCode.NOT_FOUND)
            return None
        except Exception as error:  # noqa: BLE001 - whatever failed, the visitor is told and the conversation goes on
            return await self.recover(conversation_pk, concierge, error)
        return Answer(reply_event(result), result.position)

    async def recover(self, conversation_pk: int, concierge: Concierge, error: Exception) -> Answer:
        """Leave the conversation usable after a turn failed, and say how the visitor is told."""
        logger.error("A turn failed with %s in conversation %s.", type(error).__name__, self.conversation_id)
        try:
            handed_over = await run_blocking(recover_sync, conversation_pk, concierge)
        except Exception as trouble:  # noqa: BLE001 - the visitor is told whether or not the note could be kept
            logger.error(
                "A failed turn could not be written down (%s) in conversation %s.",
                type(trouble).__name__,
                self.conversation_id,
            )
            handed_over = None
        if handed_over is None:
            return Answer(problem(ErrorCode.TURN_FAILED), None)
        return Answer(reply_event(handed_over), handed_over.position)

    async def pass_on(self, outcome: Answer) -> None:
        """Tell the conversation's other connections how the turn ended, for any that were told it was on its way."""
        message = {
            "type": ANSWERED,
            "origin": self.channel_name,
            "position": outcome.position,
            "event": outcome.event.model_dump(mode="json"),
        }
        try:
            await self.channel_layer.group_send(conversation_group(self.conversation_id), message)
        except (RedisError, ChannelFull, OSError, TimeoutError):
            logger.warning("The answer in conversation %s could not be passed on.", self.conversation_id)

    # The conversation's other connections

    async def conversation_answered(self, event: dict[str, Any]) -> None:
        """Pass on the answer to a message another connection of this conversation answered, if this one waits for it.

        Only a connection that is waiting hears it: a tab that was told nothing about the message would be
        shown an answer to a question it never saw. An answer this connection already holds is not sent twice.
        """
        if event.get("origin") == self.channel_name or self.answering or not self.awaiting_reply:
            return
        position = event.get("position")
        if position is not None and position <= self.delivered_through:
            return
        try:
            answer = SERVER_EVENTS.validate_python(event.get("event"))
        except ValidationError:
            logger.warning("A message to conversation %s was not an answer, and was ignored.", self.conversation_id)
            return
        if not isinstance(answer, Reply | Problem):
            return
        await self.tell(answer)
        self.awaiting_reply = False
        if position is not None:
            self.delivered_through = position
        self.arm_timer(IDLE_TIMEOUT_SECONDS)

    # The live calendar

    async def calendar_changed(self, event: dict[str, Any]) -> None:
        """Pass on the slots that changed, as this visitor sees them."""
        changes = [slot_view(change, viewer=self.conversation_pk) for change in event["changes"]]
        await self.tell(Calendar(changes=changes))

    async def calendar_reset(self, event: dict[str, Any]) -> None:  # noqa: ARG002 - Channels' signature
        """Tell the client the calendar was laid out afresh, so it loads the snapshot again."""
        await self.tell(CalendarReset())
