"""The wire protocol of LB-09's WebSocket: the one frame a client sends, and the events the server sends.

One JSON object to a text frame, each with a `type`, strict in both directions. The first and only frame a
client sends is `hello`, with its visitor token and the meeting it wants to follow (lb09/consumers.py says
why the token travels in the frame and not the address). The server answers with the meeting's `state`,
sends a new `state` at every stage the worker reaches, and closes a little after the last one. A page that
loses the socket polls `GET /api/lb09/meetings/{id}` instead: the two say the same thing.

    client to server
        {"type": "hello", "token": "<visitor token>", "meeting": "<meeting id>"}
    server to client
        state   where the meeting stands: status, stage, failure, run ID, counters
        error   something that can't be done, with a code that stays the same
"""

from datetime import datetime
from enum import IntEnum, StrEnum
from typing import Annotated, Final, Literal

from pydantic import BaseModel, ConfigDict, StringConstraints, TypeAdapter

from lb09.models import Meeting

# A visitor token is a signed JWT of a few hundred characters; this is generous and still small.
MAX_TOKEN_LENGTH: Final = 2_048
# What a meeting's public ID looks like: URL-safe characters, 16 to 24 of them.
PUBLIC_ID_PATTERN: Final = r"^[A-Za-z0-9_-]{16,24}$"


class CloseCode(IntEnum):
    """Why the server closes a connection: the standard codes where one fits, and 4xxx codes of our own."""

    NORMAL = 1000
    UNSUPPORTED = 1003
    TOO_BIG = 1009
    UNAVAILABLE = 1011
    TRY_AGAIN_LATER = 1013
    BAD_FRAME = 4400
    UNAUTHORIZED = 4401
    NOT_FOUND = 4404
    TIMED_OUT = 4408


class ErrorCode(StrEnum):
    """What went wrong, in a code a client can act on without reading the sentence next to it."""

    INVALID_FRAME = "invalid_frame"
    ALREADY_SAID_HELLO = "already_said_hello"
    MEETING_GONE = "meeting_gone"
    TOO_MANY_CONNECTIONS = "too_many_connections"
    TOO_MANY_FRAMES = "too_many_frames"
    UNAVAILABLE = "unavailable"


ERROR_SENTENCES: Final = {
    ErrorCode.INVALID_FRAME: "That message wasn't understood.",
    ErrorCode.ALREADY_SAID_HELLO: "This connection is already open.",
    ErrorCode.MEETING_GONE: "That meeting doesn't exist, or its data has been removed.",
    ErrorCode.TOO_MANY_CONNECTIONS: "This browser has too many connections open. Close another tab and try again.",
    ErrorCode.TOO_MANY_FRAMES: "This connection only listens: nothing more can be sent on it.",
    ErrorCode.UNAVAILABLE: "The recorder can't answer right now.",
}


class Wire(BaseModel):
    """The base of every frame: a field the protocol doesn't define is an error, and a frame never changes."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class Hello(Wire):
    """The first frame: who is asking, and which of their meetings to follow."""

    type: Literal["hello"]
    token: Annotated[str, StringConstraints(min_length=1, max_length=MAX_TOKEN_LENGTH)]
    meeting: Annotated[str, StringConstraints(pattern=PUBLIC_ID_PATTERN)]


HELLO: Final[TypeAdapter[Hello]] = TypeAdapter(Hello)


def parse_hello(text: str) -> Hello:
    """Read a text frame as a hello, or raise ValidationError. Strict: a field the protocol lacks is refused."""
    return HELLO.validate_json(text, strict=True)


class State(Wire):
    """Where a meeting stands, as the WebSocket and `GET /api/lb09/meetings/{id}` both say it."""

    type: Literal["state"] = "state"
    meeting: str
    status: str
    stage: str
    failure: str | None
    run_id: str
    model_calls: int
    dropped_items: int
    updated_at: datetime


class Problem(Wire):
    """Something that can't be done."""

    type: Literal["error"] = "error"
    code: ErrorCode
    message: str


def problem(code: ErrorCode) -> Problem:
    """Make the error event for a code, with its fixed sentence."""
    return Problem(code=code, message=ERROR_SENTENCES[code])


def state_of(meeting: Meeting) -> State:
    """Describe a meeting's progress, which is all the socket ever says about it."""
    return State(
        meeting=meeting.public_id,
        status=meeting.status,
        stage=meeting.stage,
        failure=meeting.failure or None,
        run_id=meeting.run_id,
        model_calls=meeting.model_calls,
        dropped_items=meeting.dropped_items,
        updated_at=meeting.updated_at,
    )


def is_over(state: State) -> bool:
    """Tell whether a meeting has ended, one way or the other, so the connection can be closed."""
    return state.status in (Meeting.Status.DONE, Meeting.Status.FAILED)
