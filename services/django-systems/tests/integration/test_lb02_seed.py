"""Integration tests for LB-02's seed: a calendar relative to the day it runs, and no booking ever lost."""

import shutil
from datetime import date, timedelta
from io import StringIO
from pathlib import Path

import pytest
from django.conf import settings
from django.core.management import CommandError, call_command

from lb02.booking import BookingService
from lb02.limits import CALENDAR_DAYS_AHEAD
from lb02.models import Conversation, Message, Offering, Reservation, Resource, Slot
from lb02.seed import SeedError, reset_calendar, seed
from tests.lb02_support import FakeClock, make_conversation

pytestmark = [pytest.mark.integration, pytest.mark.django_db(databases=["lb02"])]

TODAY = date(2026, 10, 1)
SEED_DIRECTORY = settings.SEED_DIR / "lb02"
# Four tastings, two cuppings and two workshops a day, for 14 days.
SLOTS = (4 + 2 + 2) * CALENDAR_DAYS_AHEAD


def test_seeding_creates_the_rooms_offerings_and_two_weeks_of_slots() -> None:
    """The three offerings, in two rooms, with a slot for each start time on each of the next 14 days."""
    report = seed(SEED_DIRECTORY, TODAY)

    assert (report.resources.created, report.offerings.created, report.slots.created) == (2, 3, SLOTS)
    assert Resource.objects.count() == 2
    assert [o.key for o in Offering.objects.all()] == ["tasting", "cupping", "roasting-workshop"]
    assert Slot.objects.count() == SLOTS
    first = Slot.objects.order_by("during").first()
    last = Slot.objects.order_by("-during").first()
    assert first is not None
    assert last is not None
    assert first.starts_at.date() == TODAY + timedelta(days=1)
    assert last.starts_at.date() == TODAY + timedelta(days=CALENDAR_DAYS_AHEAD)


def test_seeding_twice_changes_nothing() -> None:
    """The second run finds everything in place."""
    seed(SEED_DIRECTORY, TODAY)

    report = seed(SEED_DIRECTORY, TODAY)

    assert report.lines() == [
        "Rooms: 0 created, 0 updated, 0 deleted",
        "Offerings: 0 created, 0 updated, 0 deleted",
        "Slots: 0 created, 0 updated, 0 deleted, 0 kept for their reservations",
    ]
    assert Slot.objects.count() == SLOTS


def test_a_new_day_moves_the_calendar_on() -> None:
    """Tomorrow's slots go once their day has passed, and a new last day is added."""
    seed(SEED_DIRECTORY, TODAY)

    report = seed(SEED_DIRECTORY, TODAY + timedelta(days=1))

    assert (report.slots.created, report.slots.deleted) == (8, 8)
    first = Slot.objects.order_by("during").first()
    assert first is not None
    assert first.starts_at.date() == TODAY + timedelta(days=2)
    assert Slot.objects.count() == SLOTS


def test_a_slot_with_a_reservation_survives_the_calendar_moving_on() -> None:
    """Seeding never takes a visitor's booking away: the slot stays, and the report says so."""
    seed(SEED_DIRECTORY, TODAY)
    clock = FakeClock()
    first_slot = Slot.objects.select_related("offering").order_by("during").first()
    assert first_slot is not None
    conversation = make_conversation(first_slot.offering)
    service = BookingService(clock=clock)
    service.place_hold(conversation, first_slot)
    service.confirm_hold(conversation, "key-1")

    report = seed(SEED_DIRECTORY, TODAY + timedelta(days=2))

    assert Slot.objects.filter(pk=first_slot.pk).exists()
    assert report.slots_kept >= 1
    assert Reservation.objects.filter(status=Reservation.Status.BOOKED).count() == 1


def test_the_nightly_reset_clears_what_visitors_made_and_lays_the_calendar_out_afresh() -> None:
    """Conversations, holds, bookings and messages go; the slots are those of the new day."""
    seed(SEED_DIRECTORY, TODAY)
    slot = Slot.objects.select_related("offering").order_by("during").first()
    assert slot is not None
    conversation = make_conversation(slot.offering)
    Message.objects.create(conversation=conversation, position=1, role="visitor", text="Hello")
    service = BookingService(clock=FakeClock())
    service.place_hold(conversation, slot)
    service.confirm_hold(conversation, "key-1")

    report = reset_calendar(SEED_DIRECTORY, TODAY + timedelta(days=1))

    assert report.conversations_deleted == 1
    assert not Conversation.objects.exists()
    assert not Reservation.objects.exists()
    assert not Message.objects.exists()
    assert Slot.objects.count() == SLOTS
    first = Slot.objects.order_by("during").first()
    assert first is not None
    assert first.starts_at.date() == TODAY + timedelta(days=2)


def test_seeding_stops_before_removing_an_offering_that_has_been_booked(tmp_path: Path) -> None:
    """Dropping a room or an offering a visitor has booked would lose their booking, so the seed refuses."""
    seed(SEED_DIRECTORY, TODAY)
    slot = Slot.objects.select_related("offering").filter(offering__key="cupping").order_by("during").first()
    assert slot is not None
    conversation = make_conversation(slot.offering)
    service = BookingService(clock=FakeClock())
    service.place_hold(conversation, slot)
    without_cupping = tmp_path / "lb02"
    shutil.copytree(SEED_DIRECTORY, without_cupping)
    text = (without_cupping / "offerings.yaml").read_text(encoding="utf-8")
    start = text.index("  - key: cupping")
    end = text.index("  - key: roasting-workshop")
    (without_cupping / "offerings.yaml").write_text(text[:start] + text[end:], encoding="utf-8")

    with pytest.raises(SeedError, match="refers to"):
        seed(without_cupping, TODAY)

    assert Offering.objects.filter(key="cupping").exists()


def test_the_seed_command_prints_what_it_did_and_can_reset() -> None:
    """The command seeds from the repository's data, and --reset clears the visitors' side first."""
    output = StringIO()
    call_command("seed_lb02", "--today", "2026-10-01", stdout=output)
    assert "Rooms: 2 created" in output.getvalue()
    assert f"Slots: {SLOTS} created" in output.getvalue()
    conversation = make_conversation(Offering.objects.get(key="tasting"))

    again = StringIO()
    call_command("seed_lb02", "--today", "2026-10-01", "--reset", stdout=again)

    assert "Conversations deleted by the reset: 1" in again.getvalue()
    assert not Conversation.objects.filter(pk=conversation.pk).exists()


def test_the_seed_command_stops_with_a_clear_message_for_a_bad_file(tmp_path: Path) -> None:
    """A file that doesn't follow its schema is reported by name, and nothing is written."""
    (tmp_path / "offerings.yaml").write_text("resources: []\nofferings: []\n", encoding="utf-8")

    with pytest.raises(CommandError, match="doesn't follow its schema"):
        call_command("seed_lb02", "--data", str(tmp_path), stdout=StringIO())

    assert not Resource.objects.exists()
