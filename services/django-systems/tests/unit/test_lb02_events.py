"""Tests for LB-02's WebSocket protocol: client frames are parsed strictly, and the server's events have one shape."""

import json
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from lb02.concierge import TurnResult
from lb02.events import (
    ERROR_SENTENCES,
    MAX_TOKEN_LENGTH,
    SERVER_EVENTS,
    Calendar,
    CalendarReset,
    CloseCode,
    ErrorCode,
    Hello,
    Problem,
    Say,
    Working,
    is_too_long,
    parse_client_frame,
    problem,
    ready_event,
    reply_event,
    slot_view,
)
from lb02.limits import MAX_MESSAGE_LENGTH
from lb02.messages import Receipt
from lb02.models import Message
from lb02.snapshot import BookingView, HoldView, OptionView, Snapshot
from lb02.tools import ToolOutcome

NOON = datetime(2026, 10, 2, 12, 0, tzinfo=UTC)
LATER = datetime(2026, 10, 2, 13, 0, tzinfo=UTC)
PUBLIC_ID = "Ab3_dEf-Gh1JkLmN"


def snapshot(**changes: object) -> Snapshot:
    """Build a snapshot of a conversation at the availability step with one option, and change what a test needs."""
    fields: dict[str, object] = {
        "step": "availability",
        "language": "cs",
        "options": [OptionView(1, 57, "cupping", NOON, LATER)],
        "hold": None,
        "booking": None,
        "messages_left": 27,
        "closed": False,
    }
    return Snapshot(**(fields | changes))  # type: ignore[arg-type]


# What a client sends


def test_a_hello_carries_a_token_and_may_name_a_conversation_to_resume() -> None:
    """The first frame says who is asking; with no conversation it starts a new one."""
    assert parse_client_frame('{"type": "hello", "token": "abc"}') == Hello(
        type="hello", token="abc", conversation=None
    )
    resumed = parse_client_frame(json.dumps({"type": "hello", "token": "abc", "conversation": PUBLIC_ID}))
    assert isinstance(resumed, Hello)
    assert resumed.conversation == PUBLIC_ID


@pytest.mark.parametrize(
    "frame",
    [
        {"type": "hello"},
        {"type": "hello", "token": ""},
        {"type": "hello", "token": "x" * (MAX_TOKEN_LENGTH + 1)},
        {"type": "hello", "token": 12},
        {"type": "hello", "token": "abc", "conversation": "short"},
        {"type": "hello", "token": "abc", "conversation": "has spaces in it, and is long"},
        {"type": "hello", "token": "abc", "conversation": "../../etc/passwd/../x"},
        {"type": "hello", "token": "abc", "extra": 1},
    ],
)
def test_a_hello_that_isnt_exactly_the_protocols_is_refused(frame: dict[str, object]) -> None:
    """A malformed token, an ID that couldn't be one of ours, a stray field: all errors, none guessed at."""
    with pytest.raises(ValidationError):
        parse_client_frame(json.dumps(frame))


def test_a_message_is_trimmed_and_cleaned() -> None:
    """Blank ends and control characters go before the text is measured or read."""
    frame = parse_client_frame(json.dumps({"type": "message", "text": "  Hi\x00 there\x07!  \n"}))

    assert frame == Say(type="message", text="Hi there!")


@pytest.mark.parametrize("text", ["", "   ", "\n\t ", "\x00\x00"])
def test_a_message_with_nothing_in_it_is_refused(text: str) -> None:
    """Nothing but blanks, or nothing but control characters, is an empty message."""
    with pytest.raises(ValidationError):
        parse_client_frame(json.dumps({"type": "message", "text": text}))


def test_a_message_of_500_characters_is_allowed_and_501_is_too_long() -> None:
    """The limit is on the cleaned text, and a refusal for length alone can be told from any other refusal."""
    assert isinstance(parse_client_frame(json.dumps({"type": "message", "text": "x" * MAX_MESSAGE_LENGTH})), Say)
    with pytest.raises(ValidationError) as too_long:
        parse_client_frame(json.dumps({"type": "message", "text": "x" * (MAX_MESSAGE_LENGTH + 1)}))
    with pytest.raises(ValidationError) as wrong_type:
        parse_client_frame(json.dumps({"type": "message", "text": 42}))
    with pytest.raises(ValidationError) as empty:
        parse_client_frame(json.dumps({"type": "message", "text": ""}))

    assert is_too_long(too_long.value)
    assert not is_too_long(wrong_type.value)
    assert not is_too_long(empty.value)


@pytest.mark.parametrize(
    "text",
    [
        "not json",
        "[]",
        "null",
        '"message"',
        "{}",
        '{"type": "shout", "text": "Hi"}',
        '{"type": "message", "text": "Hi", "voice": true}',
        '{"type": "ready"}',
        '{"type": "message", "text": NaN}',
    ],
)
def test_anything_that_isnt_a_known_frame_is_refused(text: str) -> None:
    """Not JSON, not an object, no type, an unknown type, an extra field, a server's event sent back: refused."""
    with pytest.raises(ValidationError):
        parse_client_frame(text)


# What the server sends


def test_every_error_code_has_a_sentence_and_the_event_carries_both() -> None:
    """A client acts on the code; the sentence is for people, and is the same each time."""
    assert set(ERROR_SENTENCES) == set(ErrorCode)
    event = problem(ErrorCode.MESSAGE_TOO_LONG)

    assert json.loads(event.model_dump_json()) == {
        "type": "error",
        "code": "message_too_long",
        "message": "A message may be at most 500 characters.",
    }


def test_the_close_codes_are_the_standard_ones_and_a_range_of_our_own() -> None:
    """1003, 1009 and 1011 mean what RFC 6455 says; ours sit in the range applications may use."""
    assert (CloseCode.UNSUPPORTED, CloseCode.TOO_BIG, CloseCode.UNAVAILABLE) == (1003, 1009, 1011)
    assert int(CloseCode.TRY_AGAIN_LATER) == 1013
    assert all(4000 <= code < 5000 for code in CloseCode if code >= 4000)
    assert len({int(code) for code in CloseCode}) == len(CloseCode)


def test_working_and_reset_are_just_their_type() -> None:
    """Two events carry nothing but what they are."""
    assert Working().model_dump_json() == '{"type":"working"}'
    assert CalendarReset().model_dump_json() == '{"type":"calendar_reset"}'


def test_ready_describes_the_conversation_and_what_was_said() -> None:
    """A resumed conversation arrives with its transcript, its options and where the booking stands."""
    lines = [Message(role="visitor", text="Dobrý den"), Message(role="concierge", text="Dobrý den! Co si přejete?")]
    held = snapshot(
        step="hold", options=[], hold=HoldView(57, "cupping", NOON, LATER, datetime(2026, 10, 1, 9, 5, tzinfo=UTC))
    )

    event = json.loads(ready_event(PUBLIC_ID, True, held, lines).model_dump_json())

    assert event["type"] == "ready"
    assert (event["conversation"], event["resumed"], event["step"], event["language"]) == (
        PUBLIC_ID,
        True,
        "hold",
        "cs",
    )
    assert event["transcript"] == [
        {"role": "visitor", "text": "Dobrý den"},
        {"role": "concierge", "text": "Dobrý den! Co si přejete?"},
    ]
    assert event["hold"] == {
        "slot": 57,
        "offering": "cupping",
        "starts_at": "2026-10-02T12:00:00Z",
        "ends_at": "2026-10-02T13:00:00Z",
        "expires_at": "2026-10-01T09:05:00Z",
    }
    assert (event["booking"], event["options"], event["messages_left"], event["closed"]) == (None, [], 27, False)


def test_ready_says_whether_the_answer_to_the_last_message_is_still_on_its_way() -> None:
    """A resumed page waits for the answer only when it is told to; a conversation that is not mid-turn says no."""
    waiting = json.loads(ready_event(PUBLIC_ID, True, snapshot(), [], pending=True).model_dump_json())
    quiet = json.loads(ready_event(PUBLIC_ID, True, snapshot(), []).model_dump_json())

    assert (waiting["pending"], quiet["pending"]) == (True, False)


def test_the_errors_a_failed_turn_and_a_flooding_client_earn_are_typed() -> None:
    """Each has a code that stays the same and a sentence that says what to do, with nothing of the error in it."""
    failed = json.loads(problem(ErrorCode.TURN_FAILED).model_dump_json())
    flood = json.loads(problem(ErrorCode.TOO_MANY_PENDING).model_dump_json())
    crowd = json.loads(problem(ErrorCode.TOO_MANY_CONNECTIONS).model_dump_json())

    assert (failed["type"], failed["code"]) == ("error", "turn_failed")
    assert "send it again" in failed["message"]
    assert flood["code"] == "too_many_pending"
    assert crowd["code"] == "too_many_connections"


def test_a_line_with_a_role_the_protocol_doesnt_know_is_an_error() -> None:
    """Lines come from the database, and the boundary checks them anyway."""
    with pytest.raises(ValidationError):
        ready_event(PUBLIC_ID, False, snapshot(), [Message(role="narrator", text="Once upon a time")])


def test_a_reply_carries_the_text_the_receipt_the_tools_and_where_things_stand() -> None:
    """What a page needs after a message: the answer, and enough state to redraw without asking again."""
    booking = BookingView("K7QW-39XD", 57, "cupping", NOON, LATER, 2, "jana@example.test")
    result = TurnResult(
        **snapshot(step="done", options=[], booking=booking).__dict__,
        reply="You're booked.",
        receipt=Receipt.BOOKING_CONFIRMED,
        position=12,
        tools=[ToolOutcome("confirm_booking", True, True, {"ok": True})],
        model_calls=7,
    )

    event = json.loads(reply_event(result).model_dump_json())

    assert event["type"] == "reply"
    assert (event["text"], event["receipt"], event["step"], event["model_calls"]) == (
        "You're booked.",
        "booking_confirmed",
        "done",
        7,
    )
    assert event["tools"] == [{"name": "confirm_booking", "executed": True, "ok": True, "error": ""}]
    assert event["booking"]["to"] == "jana@example.test"
    assert event["hold"] is None


def test_a_reply_that_isnt_a_receipt_has_none() -> None:
    """The model's own words carry no receipt."""
    result = TurnResult(**snapshot().__dict__, reply="Which day suits you?", receipt=None, position=4)

    assert reply_event(result).receipt is None


def test_server_events_round_trip_through_their_union() -> None:
    """Whatever the server sends can be read back as exactly that event: one tag, one shape."""
    events = [Working(), CalendarReset(), problem(ErrorCode.UNAVAILABLE)]

    assert [SERVER_EVENTS.validate_json(event.model_dump_json()) for event in events] == events
    assert isinstance(SERVER_EVENTS.validate_json('{"type": "error", "code": "unavailable", "message": "x"}'), Problem)


# The live calendar, from one visitor's point of view


def change(owner: int | None, status: str = "held") -> dict[str, object]:
    """Describe one slot's change the way the channel layer carries it."""
    return {
        "slot": 57,
        "offering": "cupping",
        "starts_at": NOON.isoformat(),
        "ends_at": LATER.isoformat(),
        "status": status,
        "owner": owner,
        "until": datetime(2026, 10, 1, 9, 5, tzinfo=UTC).isoformat() if status == "held" else None,
    }


def test_a_slot_is_mine_only_for_the_conversation_that_owns_it() -> None:
    """The owner's ID decides `mine` and goes no further: nobody is told whose a reservation is."""
    mine = slot_view(change(owner=7), viewer=7)
    someone_elses = slot_view(change(owner=8), viewer=7)

    assert (mine.mine, someone_elses.mine) == (True, False)
    assert "owner" not in json.loads(mine.model_dump_json())
    assert mine.until == datetime(2026, 10, 1, 9, 5, tzinfo=UTC)


def test_a_free_slot_is_nobodys() -> None:
    """With no owner it is not mine, whoever is asking, including a viewer with no conversation."""
    assert not slot_view(change(owner=None, status="free"), viewer=7).mine
    assert not slot_view(change(owner=None, status="free"), viewer=None).mine
    assert slot_view(change(owner=None, status="free"), viewer=7).until is None


def test_a_calendar_event_is_its_changes() -> None:
    """The event the tab receives: the type, and every slot that changed."""
    event = Calendar(changes=[slot_view(change(owner=7), viewer=8)])

    assert json.loads(event.model_dump_json())["changes"][0]["status"] == "held"
