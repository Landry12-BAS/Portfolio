"""Integration tests for LB-02's background tasks: the hold sweep, the 24-hour sweep and the nightly reset.

The sweeps are housekeeping, and these tests keep them that way: what they do to the rows is
checked here, while the rules that don't wait for them are checked in test_booking.py.
"""

from collections.abc import Callable
from contextlib import AbstractContextManager
from datetime import timedelta

import pytest
from django.conf import settings
from django.utils import timezone

from lb02 import tasks
from lb02.models import Confirmation, Conversation, Handoff, Message, Offering, Reservation, Slot
from lb02.seed import seed
from tests.lb02_support import RecordingNotifier, make_conversation, raw_reservation

pytestmark = [pytest.mark.integration, pytest.mark.django_db(databases=["lb02"])]

type CaptureCommits = Callable[..., AbstractContextManager[list[Callable[[], None]]]]


@pytest.fixture(autouse=True)
def calendar() -> None:
    """Lay the calendar out from the real today, so slots are in the real future the tasks' clock sees."""
    seed(settings.SEED_DIR / "lb02", timezone.now().date())


@pytest.fixture
def notifier(monkeypatch: pytest.MonkeyPatch) -> RecordingNotifier:
    """Give the tasks a notifier the test can read, in place of the Redis channel layer."""
    recording = RecordingNotifier()
    monkeypatch.setattr(tasks, "ChannelLayerNotifier", lambda: recording)
    return recording


def a_slot(offering_key: str = "tasting", nth: int = 0) -> Slot:
    """Return one of the seeded slots of an offering."""
    return Slot.objects.select_related("offering").filter(offering__key=offering_key).order_by("during")[nth]


def test_the_hold_sweep_marks_the_holds_that_ran_out_and_leaves_the_rest(
    notifier: RecordingNotifier, django_capture_on_commit_callbacks: CaptureCommits
) -> None:
    """A hold past its five minutes is marked expired and announced; a live hold and a booking are left alone."""
    ran_out, live, booked = a_slot(nth=0), a_slot(nth=1), a_slot(nth=2)
    offering = ran_out.offering
    now = timezone.now()
    raw_reservation(
        make_conversation(offering, session="session-of-the-first-visitor"),
        ran_out,
        hold_expires_at=now - timedelta(minutes=1),
    )
    raw_reservation(
        make_conversation(offering, session="session-of-the-second-visitor"),
        live,
        hold_expires_at=now + timedelta(minutes=3),
    )
    raw_reservation(make_conversation(offering, session="session-of-the-third-visitor"), booked, status="booked")

    with django_capture_on_commit_callbacks(execute=True, using="lb02"):
        swept = tasks.sweep_expired_holds()

    assert swept == 1
    statuses = {r.slot_id: r.status for r in Reservation.objects.all()}
    assert statuses[ran_out.pk] == Reservation.Status.EXPIRED
    assert statuses[live.pk] == Reservation.Status.HELD
    assert statuses[booked.pk] == Reservation.Status.BOOKED
    assert notifier.changed_ids() == {ran_out.pk}


def test_the_24_hour_sweep_deletes_a_conversation_with_everything_it_holds(
    notifier: RecordingNotifier, django_capture_on_commit_callbacks: CaptureCommits
) -> None:
    """The conversation goes with its messages, booking, confirmation and handoff, and its slot is announced as free."""
    slot = a_slot()
    expired = make_conversation(slot.offering, session="session-of-the-first-visitor")
    Conversation.objects.filter(pk=expired.pk).update(expires_at=timezone.now() - timedelta(minutes=1))
    Message.objects.create(conversation=expired, position=1, role="visitor", text="Book me a tasting.")
    booking = raw_reservation(expired, slot, status="booked")
    Confirmation.objects.create(
        reservation=booking,
        to_address="jana@example.test",
        subject="Booked",
        body="You are booked.",
        language="en",
        recorded_at=timezone.now(),
    )
    Handoff.objects.create(
        conversation=expired, reason="out_of_scope", summary="x", transcript=[], created_at=timezone.now()
    )
    current = make_conversation(slot.offering, session="session-of-the-second-visitor")

    with django_capture_on_commit_callbacks(execute=True, using="lb02"):
        deleted = tasks.sweep_expired_conversations()

    assert deleted == 1
    assert list(Conversation.objects.values_list("pk", flat=True)) == [current.pk]
    assert not Message.objects.exists()
    assert not Reservation.objects.exists()
    assert not Confirmation.objects.exists()
    assert not Handoff.objects.exists()
    assert slot.pk in notifier.changed_ids()
    freed = [change for changes in notifier.announcements for change in changes if change.slot_id == slot.pk]
    assert freed[-1].state.status == "free"


def test_the_nightly_reset_starts_the_demo_afresh_and_tells_the_calendar(monkeypatch: pytest.MonkeyPatch) -> None:
    """Visitors' conversations go, the calendar is laid out from today, and open pages are told to reload."""
    told: list[str] = []
    monkeypatch.setattr(tasks, "announce_reset", lambda: told.append("reset"))
    make_conversation(a_slot().offering)

    tasks.reset_calendar()

    assert not Conversation.objects.exists()
    assert Slot.objects.count() == (4 + 2 + 2) * 14
    first = Slot.objects.order_by("during").first()
    assert first is not None
    assert first.starts_at.date() >= timezone.now().date()
    assert told == ["reset"]
    assert Offering.objects.count() == 3


def test_the_beat_schedule_runs_the_three_tasks() -> None:
    """Each scheduled entry names a task that exists, so the beat never queues one nobody can run."""
    schedule = settings.CELERY_BEAT_SCHEDULE

    assert schedule["lb02-sweep-expired-holds"]["task"] == tasks.sweep_expired_holds.name
    assert schedule["lb02-sweep-expired-conversations"]["task"] == tasks.sweep_expired_conversations.name
    assert schedule["lb02-reset-calendar"]["task"] == tasks.reset_calendar.name
    assert schedule["lb02-sweep-expired-holds"]["schedule"] == 60
