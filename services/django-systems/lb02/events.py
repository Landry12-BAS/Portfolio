"""The wire protocol of LB-02's WebSocket: every frame a client may send and every event the server sends.

One JSON object to a text frame, each with a `type`. Both directions are strict Pydantic
models that forbid fields they don't define, so a frame is exactly what the protocol says or
it is refused. The first frame a client sends must be `hello`, carrying its visitor token;
lb02/consumers.py says why the token travels there and not in the address.

    client to server
        {"type": "hello", "token": "<visitor token>", "conversation": null | "<conversation id>"}
        {"type": "message", "text": "Hi! I'd like a cupping for two tomorrow afternoon."}

    server to client
        ready           the conversation is open: transcript, step, slots on offer, hold, booking
        working         the message was accepted and the concierge is on it
        reply           the concierge's answer, and where the booking stands now
        calendar        slots that changed, held, booked or free, from this visitor's point of view
        calendar_reset  the demo calendar was laid out afresh: load the snapshot again
        error           something that can't be done, with a code that stays the same

Times are ISO 8601 in UTC; a client shows them in Prague time, the roastery's. A slot's
`mine` is true for the slot this conversation holds or has booked, and everyone else's
reservations are simply `held` or `booked`, with no hint of whose they are.
"""

from collections.abc import Sequence
from datetime import datetime
from enum import IntEnum, StrEnum
from typing import Annotated, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, TypeAdapter, ValidationError

from lb02.booking import SlotStatus
from lb02.concierge import TurnResult
from lb02.limits import MAX_MESSAGE_LENGTH
from lb02.models import Message
from lb02.privacy import VisitorText
from lb02.snapshot import BookingView, HoldView, OptionView, Snapshot

# A visitor token is a signed JWT of a few hundred characters; this is generous and still small.
MAX_TOKEN_LENGTH: Final = 2_048
# What a conversation's public ID looks like: URL-safe characters, 16 to 24 of them.
PUBLIC_ID_PATTERN: Final = r"^[A-Za-z0-9_-]{16,24}$"

type Role = Literal["visitor", "concierge", "action"]


class CloseCode(IntEnum):
    """Why the server closes a connection: the standard codes where one fits, and 4xxx codes of our own."""

    # Standard (RFC 6455).
    UNSUPPORTED = 1003
    TOO_BIG = 1009
    UNAVAILABLE = 1011
    # Ours: the 4xxx range is for applications. The numbers echo the HTTP statuses they stand for.
    BAD_FRAME = 4400
    UNAUTHORIZED = 4401
    NOT_FOUND = 4404
    TIMED_OUT = 4408
    TOO_MANY_CONVERSATIONS = 4429


class ErrorCode(StrEnum):
    """What went wrong, in a code a client can act on without reading the sentence next to it."""

    INVALID_FRAME = "invalid_frame"
    MESSAGE_TOO_LONG = "message_too_long"
    ALREADY_SAID_HELLO = "already_said_hello"
    CONVERSATION_GONE = "conversation_gone"
    TOO_MANY_CONVERSATIONS = "too_many_conversations"
    UNAVAILABLE = "unavailable"


ERROR_SENTENCES: Final = {
    ErrorCode.INVALID_FRAME: "That message wasn't understood.",
    ErrorCode.MESSAGE_TOO_LONG: f"A message may be at most {MAX_MESSAGE_LENGTH} characters.",
    ErrorCode.ALREADY_SAID_HELLO: "This connection is already open.",
    ErrorCode.CONVERSATION_GONE: "That conversation doesn't exist, or it has ended and its data has been removed.",
    ErrorCode.TOO_MANY_CONVERSATIONS: "You have started as many conversations today as you may. Come back tomorrow.",
    ErrorCode.UNAVAILABLE: "The concierge can't answer right now.",
}


class Wire(BaseModel):
    """The base of every frame: a field the protocol doesn't define is an error, and a frame never changes."""

    model_config = ConfigDict(extra="forbid", frozen=True)


# What a client sends


class Hello(Wire):
    """The first frame: who is asking, and which of their conversations to resume (none starts a new one)."""

    type: Literal["hello"]
    token: Annotated[str, StringConstraints(min_length=1, max_length=MAX_TOKEN_LENGTH)]
    conversation: Annotated[str, StringConstraints(pattern=PUBLIC_ID_PATTERN)] | None = None


class Say(Wire):
    """A visitor's message: text of one to 500 characters once it is cleaned of control characters and blank ends."""

    type: Literal["message"]
    text: VisitorText


ClientFrame = Hello | Say
CLIENT_FRAMES: Final[TypeAdapter[ClientFrame]] = TypeAdapter(Annotated[ClientFrame, Field(discriminator="type")])


def parse_client_frame(text: str) -> ClientFrame:
    """Read a text frame as one of the frames a client may send, or raise ValidationError.

    Strict: a number written as text, or a field the protocol doesn't have, is refused.
    """
    return CLIENT_FRAMES.validate_json(text, strict=True)


def is_too_long(error: ValidationError) -> bool:
    """Tell whether a refused frame was a message that only failed for being too long."""
    problems = error.errors()
    return len(problems) == 1 and problems[0]["type"] == "string_too_long" and problems[0]["loc"][-1] == "text"


# What the server sends


class Line(Wire):
    """One line of the transcript."""

    role: Role
    text: str


class Option(Wire):
    """A slot on offer, by the number the concierge holds it with."""

    number: int
    slot: int
    offering: str
    starts_at: datetime
    ends_at: datetime


class Hold(Wire):
    """The slot this conversation holds, and when the hold runs out."""

    slot: int
    offering: str
    starts_at: datetime
    ends_at: datetime
    expires_at: datetime


class Booking(Wire):
    """This conversation's booking: its code, its slot, and where the mock confirmation was addressed (never sent)."""

    code: str
    slot: int
    offering: str
    starts_at: datetime
    ends_at: datetime
    party_size: int
    to: str


class ToolUse(Wire):
    """A tool the concierge's model called this turn: which, whether the booking rules let it run, and how it went."""

    name: str
    executed: bool
    ok: bool
    error: str


class State(Wire):
    """Where a conversation stands: shared by `ready` and `reply`."""

    step: str
    language: str
    messages_left: int
    closed: bool
    options: list[Option]
    hold: Hold | None
    booking: Booking | None


class Ready(State):
    """The conversation is open. `transcript` is everything said so far, oldest first."""

    type: Literal["ready"] = "ready"
    conversation: str
    resumed: bool
    transcript: list[Line]


class Working(Wire):
    """The message was accepted, and the concierge is working on it."""

    type: Literal["working"] = "working"


class Reply(State):
    """The concierge's answer. `receipt` names the kinds of message the code writes itself, when this was one."""

    type: Literal["reply"] = "reply"
    text: str
    receipt: str | None
    tools: list[ToolUse]
    model_calls: int


class SlotView(Wire):
    """One slot's new state, from this visitor's point of view."""

    slot: int
    offering: str
    starts_at: datetime
    ends_at: datetime
    status: SlotStatus
    mine: bool
    until: datetime | None


class Calendar(Wire):
    """Slots that changed."""

    type: Literal["calendar"] = "calendar"
    changes: list[SlotView]


class CalendarReset(Wire):
    """The demo calendar was laid out afresh: every client loads the snapshot again."""

    type: Literal["calendar_reset"] = "calendar_reset"


class Problem(Wire):
    """Something that can't be done, with a code that stays the same and a sentence for a human."""

    type: Literal["error"] = "error"
    code: ErrorCode
    message: str


ServerEvent = Ready | Working | Reply | Calendar | CalendarReset | Problem
SERVER_EVENTS: Final[TypeAdapter[ServerEvent]] = TypeAdapter(Annotated[ServerEvent, Field(discriminator="type")])


def problem(code: ErrorCode) -> Problem:
    """Build the error event for a code, with its fixed sentence."""
    return Problem(code=code, message=ERROR_SENTENCES[code])


def option_event(view: OptionView) -> Option:
    """Describe an option on offer for the wire."""
    return Option(
        number=view.number, slot=view.slot_id, offering=view.offering, starts_at=view.starts_at, ends_at=view.ends_at
    )


def hold_event(view: HoldView) -> Hold:
    """Describe a hold for the wire."""
    return Hold(
        slot=view.slot_id,
        offering=view.offering,
        starts_at=view.starts_at,
        ends_at=view.ends_at,
        expires_at=view.expires_at,
    )


def booking_event(view: BookingView) -> Booking:
    """Describe a booking for the wire."""
    return Booking(
        code=view.code,
        slot=view.slot_id,
        offering=view.offering,
        starts_at=view.starts_at,
        ends_at=view.ends_at,
        party_size=view.party_size,
        to=view.to,
    )


def state_event(snapshot: Snapshot) -> State:
    """Describe where a conversation stands for the wire."""
    return State(
        step=snapshot.step,
        language=snapshot.language,
        messages_left=snapshot.messages_left,
        closed=snapshot.closed,
        options=[option_event(view) for view in snapshot.options],
        hold=hold_event(snapshot.hold) if snapshot.hold else None,
        booking=booking_event(snapshot.booking) if snapshot.booking else None,
    )


def ready_event(conversation_id: str, resumed: bool, snapshot: Snapshot, transcript: Sequence[Message]) -> Ready:
    """Build the `ready` event for a conversation that has just opened or resumed."""
    lines = [Line.model_validate({"role": line.role, "text": line.text}) for line in transcript]
    return Ready(conversation=conversation_id, resumed=resumed, transcript=lines, **dict(state_event(snapshot)))


def reply_event(result: TurnResult) -> Reply:
    """Build the `reply` event for a finished turn."""
    tools = [ToolUse(name=tool.tool, executed=tool.executed, ok=tool.ok, error=tool.error) for tool in result.tools]
    return Reply(
        text=result.reply,
        receipt=str(result.receipt) if result.receipt else None,
        tools=tools,
        model_calls=result.model_calls,
        **dict(state_event(result)),
    )


def slot_view(change: dict[str, object], viewer: int | None) -> SlotView:
    """Read one slot change from the channel layer's plain values, as the conversation `viewer` sees it.

    A reservation's owner is an internal ID that never goes to a client: it only decides `mine`.
    """
    owner = change.get("owner")
    fields = {key: value for key, value in change.items() if key != "owner"}
    return SlotView.model_validate({**fields, "mine": owner is not None and owner == viewer})
