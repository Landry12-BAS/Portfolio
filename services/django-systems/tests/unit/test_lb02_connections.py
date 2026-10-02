"""Unit tests for counting a visitor's open connections, and for telling when a conversation waits for an answer."""

from lb02.connections import ConnectionCounts
from lb02.consumers import is_awaiting_reply
from lb02.models import Message


def said(role: str) -> Message:
    """Make a line of a transcript, unsaved, by a role."""
    return Message(role=role, text="Something.")


def test_a_visitor_is_let_in_up_to_the_limit_and_no_further() -> None:
    """The limit-th connection is counted and the next is refused, and refusing it counts nothing."""
    counts = ConnectionCounts(limit=2)

    assert [counts.enter("jana"), counts.enter("jana"), counts.enter("jana")] == [True, True, False]
    assert counts.open_for("jana") == 2


def test_a_connection_that_closes_makes_room_for_the_next() -> None:
    """Leaving counts one fewer, so a visitor who comes straight back is let in."""
    counts = ConnectionCounts(limit=1)
    counts.enter("jana")

    counts.leave("jana")

    assert counts.enter("jana") is True


def test_visitors_are_counted_apart() -> None:
    """One visitor using all their connections costs another none of theirs."""
    counts = ConnectionCounts(limit=1)

    assert (counts.enter("jana"), counts.enter("dan")) == (True, True)
    assert counts.total() == 2


def test_leaving_more_often_than_entering_leaves_nothing_counted() -> None:
    """A count never goes below nothing, and a visitor with none is forgotten rather than kept at zero."""
    counts = ConnectionCounts(limit=3)
    counts.enter("jana")

    counts.leave("jana")
    counts.leave("jana")
    counts.leave("nobody")

    assert counts.counts == {}


def test_a_conversation_waits_for_an_answer_when_the_last_thing_said_is_the_visitors() -> None:
    """The visitor spoke last, so the concierge's answer is still to come."""
    assert is_awaiting_reply([said("visitor")]) is True
    assert is_awaiting_reply([said("visitor"), said("concierge"), said("visitor")]) is True


def test_a_conversation_does_not_wait_when_the_concierge_spoke_last() -> None:
    """The answer is there, and an empty conversation has nothing to answer."""
    assert is_awaiting_reply([said("visitor"), said("concierge")]) is False
    assert is_awaiting_reply([]) is False


def test_the_concierges_notes_of_what_it_did_are_not_counted_as_saying_anything() -> None:
    """A hold made in the middle of a turn leaves a note after the visitor's line, and the answer is still to come."""
    assert is_awaiting_reply([said("visitor"), said("action")]) is True
    assert is_awaiting_reply([said("visitor"), said("action"), said("concierge"), said("action")]) is False
