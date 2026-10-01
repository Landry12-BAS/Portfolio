"""Integration tests for LB-02's conversation mechanics: starting, the transcript, the counted limits and the step."""

from datetime import timedelta

import pytest
from django.db import IntegrityError, transaction

from lb02.booking import BookingService
from lb02.conversations import (
    ConversationLimitError,
    details_summary,
    messages_left,
    own_conversation,
    record,
    spend_call,
    spend_message,
    start_conversation,
    sync_step,
    transcript_json,
    transcript_pairs,
)
from lb02.limits import (
    CONVERSATIONS_PER_VISITOR_PER_DAY,
    MAX_MODEL_CALLS_PER_CONVERSATION,
    MESSAGES_PER_SESSION,
    VISITOR_DATA_LIFETIME,
)
from lb02.models import MAX_LINE_LENGTH, Conversation, Handoff, Message, Offering, Reservation
from lb02.states import Step
from tests.lb02_support import (
    FakeClock,
    make_conversation,
    make_offering,
    make_room,
    make_slot,
    race,
    reload,
    tomorrow_at,
)

pytestmark = [pytest.mark.integration, pytest.mark.django_db(databases=["lb02"])]

SESSION = "session-of-jana-visitor-01"


@pytest.fixture
def clock() -> FakeClock:
    """Return a clock that stands still on a Thursday morning."""
    return FakeClock()


# Starting a conversation


def test_a_new_conversation_has_its_own_run_and_a_day_to_live(clock: FakeClock) -> None:
    """The run ID is what the gateway's quotas and the Scope follow; the expiry is the visitor-data lifetime."""
    first = start_conversation(SESSION, clock())
    second = start_conversation(SESSION, clock())

    assert first.run_id != second.run_id
    assert first.public_id != second.public_id
    assert first.expires_at == clock() + VISITOR_DATA_LIFETIME
    assert (first.step, first.message_count, first.model_calls) == (Step.DETAILS, 0, 0)


def test_a_visitor_may_start_ten_conversations_a_day_and_not_an_eleventh(clock: FakeClock) -> None:
    """The limit counts per visitor, so the eleventh is refused for them and nobody else."""
    for _ in range(CONVERSATIONS_PER_VISITOR_PER_DAY):
        start_conversation(SESSION, clock())

    with pytest.raises(ConversationLimitError):
        start_conversation(SESSION, clock())

    assert start_conversation("session-of-another-visitor", clock()).session_key == "session-of-another-visitor"


def test_yesterdays_conversations_dont_count_against_today(clock: FakeClock) -> None:
    """The day starts at midnight UTC: ten conversations from yesterday leave today's ten untouched."""
    yesterday = clock() - timedelta(days=1)
    for _ in range(CONVERSATIONS_PER_VISITOR_PER_DAY):
        start_conversation(SESSION, yesterday)

    assert start_conversation(SESSION, clock()).message_count == 0


def test_a_visitor_finds_their_own_conversation_and_nobody_elses(clock: FakeClock) -> None:
    """The public ID alone opens nothing: it has to be the session's own conversation."""
    mine = start_conversation(SESSION, clock())

    assert own_conversation(SESSION, mine.public_id) == mine
    assert own_conversation("session-of-another-visitor", mine.public_id) is None
    assert own_conversation(SESSION, "no-such-conversation") is None


# The transcript


def test_lines_are_numbered_in_the_order_they_are_recorded(clock: FakeClock) -> None:
    """The transcript is a numbered list, and a handoff carries it whole, in order."""
    conversation = start_conversation(SESSION, clock())

    record(conversation, "visitor", "Hello", clock())
    record(conversation, "concierge", "Hi! What would you like to book?", clock())
    record(conversation, "action", "Recorded offering.", clock())

    assert [message.position for message in Message.objects.filter(conversation=conversation)] == [1, 2, 3]
    assert transcript_pairs(conversation) == [
        ("visitor", "Hello"),
        ("concierge", "Hi! What would you like to book?"),
        ("action", "Recorded offering."),
    ]
    assert [line["text"] for line in transcript_json(conversation)] == [
        "Hello",
        "Hi! What would you like to book?",
        "Recorded offering.",
    ]


def test_a_line_longer_than_the_table_allows_is_cut(clock: FakeClock) -> None:
    """A long reply can't make the write fail: the line is cut to the length the table accepts."""
    conversation = start_conversation(SESSION, clock())

    line = record(conversation, "concierge", "w" * (MAX_LINE_LENGTH + 500), clock())

    assert len(line.text) == MAX_LINE_LENGTH


def test_two_lines_can_never_take_the_same_place(clock: FakeClock) -> None:
    """The table refuses a duplicate place on its own, whatever the code above it does."""
    conversation = start_conversation(SESSION, clock())
    record(conversation, "visitor", "Hello", clock())

    with pytest.raises(IntegrityError), transaction.atomic(using="lb02"):
        Message.objects.create(conversation=conversation, position=1, role="visitor", text="Again", created_at=clock())


# The counted limits


def test_thirty_messages_are_counted_and_the_thirty_first_is_not(clock: FakeClock) -> None:
    """The count stops at the datasheet's 30, and the answer says whether this message was counted."""
    conversation = start_conversation(SESSION, clock())

    counted = [spend_message(conversation) for _ in range(MESSAGES_PER_SESSION + 3)]

    assert counted == [True] * MESSAGES_PER_SESSION + [False] * 3
    assert reload(conversation).message_count == MESSAGES_PER_SESSION
    assert conversation.message_count == MESSAGES_PER_SESSION
    assert messages_left(conversation) == 0


def test_the_messages_left_count_down_from_thirty(clock: FakeClock) -> None:
    """The client shows how many messages remain, taken from the count and never below zero."""
    conversation = start_conversation(SESSION, clock())

    assert messages_left(conversation) == MESSAGES_PER_SESSION
    spend_message(conversation)
    assert messages_left(conversation) == MESSAGES_PER_SESSION - 1


def test_the_table_itself_refuses_a_message_count_above_thirty(clock: FakeClock) -> None:
    """If code ever wrote 31, the database would still say no."""
    conversation = start_conversation(SESSION, clock())

    with pytest.raises(IntegrityError), transaction.atomic(using="lb02"):
        Conversation.objects.filter(pk=conversation.pk).update(message_count=MESSAGES_PER_SESSION + 1)


def test_gateway_calls_are_counted_against_the_conversations_budget(clock: FakeClock) -> None:
    """Each call is counted before it is made, and the one past the budget is not allowed."""
    conversation = start_conversation(SESSION, clock())

    allowed = [spend_call(conversation) for _ in range(MAX_MODEL_CALLS_PER_CONVERSATION + 2)]

    assert allowed == [True] * MAX_MODEL_CALLS_PER_CONVERSATION + [False] * 2
    assert reload(conversation).model_calls == MAX_MODEL_CALLS_PER_CONVERSATION


# The limits, racing


@pytest.mark.django_db(databases=["lb02"], transaction=True)
def test_forty_messages_racing_for_thirty_places_are_counted_thirty_times(clock: FakeClock) -> None:
    """Two tabs, or a script, can't squeeze a 31st message in: one statement checks and counts."""
    conversation = start_conversation(SESSION, clock())

    def job() -> bool:
        """Spend a message on this thread's own connection, as the visitor's other tab would."""
        return spend_message(Conversation.objects.get(pk=conversation.pk))

    outcomes = race([job for _ in range(40)])

    assert all(isinstance(outcome, bool) for outcome in outcomes)
    assert outcomes.count(True) == MESSAGES_PER_SESSION
    assert reload(conversation).message_count == MESSAGES_PER_SESSION


@pytest.mark.django_db(databases=["lb02"], transaction=True)
def test_lines_recorded_at_the_same_moment_all_get_a_place(clock: FakeClock) -> None:
    """Eight writers on one conversation each get a place of their own, with nobody failing."""
    conversation = start_conversation(SESSION, clock())

    def job() -> Message:
        """Record a line on this thread's own connection."""
        return record(Conversation.objects.get(pk=conversation.pk), "visitor", "Hello", clock())

    outcomes = race([job for _ in range(8)])

    assert all(isinstance(outcome, Message) for outcome in outcomes)
    assert sorted(message.position for message in Message.objects.filter(conversation=conversation)) == list(
        range(1, 9)
    )


# The step follows the facts


def test_the_step_follows_the_facts_and_the_stored_one_is_kept_in_line(clock: FakeClock) -> None:
    """Details, then availability, hold, done and handoff: each from what is in the database, nothing from a model."""
    bookings = BookingService(clock=clock)
    offering = make_offering(make_room(), key="tasting")
    slot = make_slot(offering, tomorrow_at(clock, 14))
    conversation = Conversation.objects.create(session_key=SESSION, language="en")
    assert sync_step(conversation, bookings) == Step.DETAILS

    conversation.offering, conversation.party_size = offering, 2
    conversation.guest_name, conversation.guest_email = "Jana Novak", "jana@example.test"
    conversation.save()
    assert sync_step(conversation, bookings) == Step.AVAILABILITY
    assert reload(conversation).step == Step.AVAILABILITY

    held = bookings.place_hold(conversation, slot)
    assert sync_step(conversation, bookings) == Step.HOLD

    bookings.confirm_hold(conversation, f"confirm-{held.reservation.code}")
    assert sync_step(conversation, bookings) == Step.DONE

    Handoff.objects.create(
        conversation=conversation,
        reason=Handoff.Reason.ASKED_FOR_PERSON,
        summary="",
        transcript=[],
        created_at=clock(),
    )
    assert sync_step(conversation, bookings) == Step.HANDOFF
    assert reload(conversation).step == Step.HANDOFF


def test_a_hold_that_ran_out_is_no_longer_a_hold_to_the_step(clock: FakeClock) -> None:
    """The step is worked out at the clock's time, so an expired hold sends the conversation back to availability."""
    bookings = BookingService(clock=clock)
    offering = make_offering(make_room(), key="tasting")
    conversation = make_conversation(offering)
    bookings.place_hold(conversation, make_slot(offering, tomorrow_at(clock, 14)))
    assert sync_step(conversation, bookings) == Step.HOLD

    clock.advance(6)

    assert sync_step(conversation, bookings) == Step.AVAILABILITY
    assert Reservation.objects.get(conversation=conversation).status == Reservation.Status.HELD


# The summary a person reads


def test_the_summary_says_what_was_collected_and_what_was_not(clock: FakeClock) -> None:
    """A person who takes over reads this first, so they needn't ask again for what the visitor already gave."""
    offering = Offering.objects.create(
        resource=make_room(),
        key="cupping",
        position=1,
        title_en="Cupping",
        title_cs="Cupping",
        summary_en="x",
        summary_cs="x",
        duration_minutes=60,
        capacity=8,
        price_czk=450,
    )
    empty = Conversation.objects.create(session_key=SESSION)
    full = make_conversation(offering, session="session-of-jana-visitor-02")
    full.search_from = tomorrow_at(clock, 0).date()

    assert (
        details_summary(empty)
        == "offering: not chosen; guests: not given; name: not given; contact: not given; language: unknown"
    )
    assert details_summary(full) == (
        "offering: cupping; guests: 2; name: Jana Novak; contact: jana@example.test; "
        "last search: 2026-10-02 to 2026-10-02, any time; language: en"
    )
