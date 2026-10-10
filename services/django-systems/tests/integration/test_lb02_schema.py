"""Integration tests for LB-02's schema on a real Postgres: where things live, and what the database refuses."""

import re
from datetime import timedelta

import pytest
from django.db import DatabaseError, IntegrityError, connections, transaction
from django.db.utils import DataError
from django.utils import timezone

from core.extensions import CHECK_BTREE_GIST_SCHEMA
from lb02.limits import MESSAGES_PER_SESSION, VISITOR_DATA_LIFETIME
from lb02.models import (
    CODE_ALPHABET,
    Confirmation,
    Conversation,
    Handoff,
    Message,
    Offering,
    Reservation,
    Resource,
)
from tests.lb02_support import (
    FakeClock,
    make_conversation,
    make_offering,
    make_room,
    make_slot,
    raw_reservation,
    tomorrow_at,
)

pytestmark = [pytest.mark.integration, pytest.mark.django_db(databases=["lb02"])]


def query_lb02(sql: str) -> list[tuple[object, ...]]:
    """Run a fixed query on LB-02's connection and return every row."""
    with connections["lb02"].cursor() as cursor:
        cursor.execute(sql)
        return list(cursor.fetchall())


def test_lb02_tables_live_only_in_the_lb02_schema() -> None:
    """Every LB-02 table, and LB-02's own migration history, sit in schema lb02 and nowhere else."""
    rows = query_lb02(
        "SELECT table_schema, table_name FROM information_schema.tables"
        " WHERE table_name LIKE 'lb02%' OR table_name = 'django_migrations'"
    )

    assert {schema for schema, _ in rows} == {"lb02"}
    assert {"lb02_reservation", "lb02_slot", "lb02_conversation", "django_migrations"} <= {name for _, name in rows}


def test_btree_gist_lives_in_the_shared_extensions_schema() -> None:
    """The extension sits where every system's search_path can see it, as pgvector does."""
    assert query_lb02("SELECT extnamespace::regnamespace::text FROM pg_extension WHERE extname = 'btree_gist'") == [
        ("extensions",)
    ]


def test_the_migration_stops_when_btree_gist_lives_elsewhere() -> None:
    """With btree_gist installed outside `extensions`, the migration's first step fails with the fix in its hint."""
    with connections["lb02"].cursor() as cursor:
        # Undone with the rest of the test's transaction.
        cursor.execute("ALTER EXTENSION btree_gist SET SCHEMA public")
        with pytest.raises(DatabaseError, match="outside the extensions schema"), transaction.atomic(using="lb02"):
            cursor.execute(CHECK_BTREE_GIST_SCHEMA)


def test_the_exclusion_constraint_compares_the_room_and_the_range_and_only_for_active_reservations() -> None:
    """The constraint is a GiST exclusion on `resource =` and `during &&`, counting only held and booked rows."""
    [(definition,)] = query_lb02(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'lb02_no_double_booking'"
    )

    assert isinstance(definition, str)
    assert definition.startswith("EXCLUDE USING gist (resource_id WITH =, during WITH &&)")
    assert re.search(r"WHERE .*status.*held.*booked", definition)


def test_a_conversation_cannot_pass_30_messages_whatever_writes_it() -> None:
    """The message limit is a database rule: the 31st message count is refused."""
    conversation = make_conversation()

    Conversation.objects.filter(pk=conversation.pk).update(message_count=MESSAGES_PER_SESSION)
    with pytest.raises(IntegrityError, match="lb02_conversation_message_limit"), transaction.atomic(using="lb02"):
        Conversation.objects.filter(pk=conversation.pk).update(message_count=MESSAGES_PER_SESSION + 1)


def test_a_confirmation_can_only_ever_be_a_mock() -> None:
    """The database refuses any delivery but `mock`, so no bug can mark a message as sent."""
    clock = FakeClock()
    slot = make_slot(make_offering(make_room()), tomorrow_at(clock, 14))
    booking = raw_reservation(make_conversation(slot.offering), slot, status="booked")

    with pytest.raises(IntegrityError, match="lb02_confirmation_is_a_mock"), transaction.atomic(using="lb02"):
        Confirmation.objects.create(
            reservation=booking,
            to_address="jana@example.test",
            subject="Booked",
            body="You are booked.",
            language="en",
            delivery="sent",
            recorded_at=timezone.now(),
        )
    stored = Confirmation.objects.create(
        reservation=booking,
        to_address="jana@example.test",
        subject="Booked",
        body="You are booked.",
        language="en",
        recorded_at=timezone.now(),
    )
    assert stored.delivery == "mock"


def test_an_offering_must_fit_the_room_and_the_clock() -> None:
    """Durations outside 15 minutes to 8 hours and parties outside 1 to 12 guests are refused."""
    room = make_room()
    with pytest.raises(IntegrityError, match="lb02_offering_duration"), transaction.atomic(using="lb02"):
        make_offering(room, key="too-short", minutes=10)
    with pytest.raises(IntegrityError, match="lb02_offering_capacity"), transaction.atomic(using="lb02"):
        make_offering(room, key="too-big", capacity=13)
    with pytest.raises(IntegrityError, match="lb02_offering_capacity"), transaction.atomic(using="lb02"):
        make_offering(room, key="too-small", capacity=0)
    assert Offering.objects.count() == 0


def test_a_transcript_line_is_never_empty_and_never_repeats_a_place() -> None:
    """The text must be 1 to 2000 characters, and each place in a transcript is used once."""
    conversation = make_conversation()
    Message.objects.create(conversation=conversation, position=1, role="visitor", text="Hello")

    with pytest.raises(IntegrityError, match="lb02_message_text_length"), transaction.atomic(using="lb02"):
        Message.objects.create(conversation=conversation, position=2, role="concierge", text="")
    with pytest.raises(IntegrityError, match="lb02_message_position_once"), transaction.atomic(using="lb02"):
        Message.objects.create(conversation=conversation, position=1, role="concierge", text="Hi")
    with pytest.raises((IntegrityError, DataError)), transaction.atomic(using="lb02"):
        Message.objects.create(conversation=conversation, position=3, role="concierge", text="x" * 2_001)


def test_a_conversation_has_at_most_one_handoff() -> None:
    """A conversation is handed over once."""
    conversation = make_conversation()
    Handoff.objects.create(
        conversation=conversation, reason="out_of_scope", summary="x", transcript=[], created_at=timezone.now()
    )

    with pytest.raises(IntegrityError), transaction.atomic(using="lb02"):
        Handoff.objects.create(
            conversation=conversation, reason="abuse", summary="y", transcript=[], created_at=timezone.now()
        )


def test_a_conversation_gets_an_unguessable_id_and_expires_after_24_hours() -> None:
    """Public IDs are random, and visitor data is due for deletion a day after it arrives."""
    before = timezone.now()
    first = make_conversation(session="session-of-the-first-visitor")
    second = make_conversation(session="session-of-the-second-visitor")

    assert first.public_id != second.public_id
    assert len(first.public_id) == 16
    assert before + VISITOR_DATA_LIFETIME <= first.expires_at <= timezone.now() + VISITOR_DATA_LIFETIME
    assert timedelta(hours=24) == VISITOR_DATA_LIFETIME


def test_a_booking_code_is_easy_to_read_out() -> None:
    """Codes are two groups of four letters and digits that can't be mistaken for each other, and are unique."""
    clock = FakeClock()
    slot = make_slot(make_offering(make_room()), tomorrow_at(clock, 14))
    codes = {
        raw_reservation(make_conversation(session=f"session-of-visitor-number-{n}"), slot, status="expired").code
        for n in range(20)
    }

    assert len(codes) == 20
    assert all(re.fullmatch(rf"[{CODE_ALPHABET}]{{4}}-[{CODE_ALPHABET}]{{4}}", code) for code in codes)
    assert Resource.objects.count() == 1
    assert Reservation.objects.count() == 20
