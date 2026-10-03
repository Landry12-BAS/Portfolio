"""Starting a meeting: the daily limit, the stored audio, the run ID, and the worker's queue.

A visitor may start 5 meetings a day (the datasheet), their own recordings and the curated samples alike,
counted since midnight UTC under a per-visitor lock (core/locks.py) so that two uploads sent at once cannot
both take the last place. A new meeting gets the run ID every gateway call it makes will carry, and is queued
for the worker only once its row is committed.
"""

from collections.abc import Callable
from datetime import datetime
from functools import partial

from django.db import transaction
from django.utils import timezone

from core.locks import lock_visitor
from lb09.limits import RECORDINGS_PER_VISITOR_PER_DAY
from lb09.models import Meeting
from lb09.storage import AudioStore
from lb_common.run import new_run_id

DATABASE = "lb09"


class MeetingLimitError(Exception):
    """The visitor has started as many meetings today as they may."""


def midnight_before(now: datetime) -> datetime:
    """Return the start of the day a moment falls in, UTC."""
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def started_today(session_key: str, now: datetime) -> int:
    """Count the meetings a visitor started since midnight UTC."""
    return Meeting.objects.filter(session_key=session_key, created_at__gte=midnight_before(now)).count()


def start_meeting(
    session_key: str,
    audio: bytes,
    mode: str,
    language: str,
    store: AudioStore,
    sample_key: str = "",
    queue: Callable[[int], object] | None = None,
) -> Meeting:
    """Store the audio and make the meeting, or refuse when the visitor has started their five for the day.

    `queue` is what to call once the row is committed, with the meeting's primary key: the worker's task.
    The audio is written before the row, so a row never names a file that isn't there; if the limit refuses
    the meeting the file is removed again.
    """
    now = timezone.now()
    name = store.save(audio)
    try:
        with transaction.atomic(using=DATABASE):
            lock_visitor(DATABASE, "meetings", session_key)
            if started_today(session_key, now) >= RECORDINGS_PER_VISITOR_PER_DAY:
                raise MeetingLimitError(f"A visitor may record {RECORDINGS_PER_VISITOR_PER_DAY} meetings a day.")
            meeting = Meeting.objects.create(
                session_key=session_key,
                sample_key=sample_key,
                mode=mode,
                language=language,
                run_id=new_run_id(),
                audio_name=name,
                source_bytes=len(audio),
            )
            if queue is not None:
                transaction.on_commit(partial(queue, meeting.pk), using=DATABASE)
    except MeetingLimitError:
        store.delete(name)
        raise
    return meeting


def own_meeting(session_key: str, public_id: str) -> Meeting | None:
    """Find a visitor's own meeting by its public ID, if it hasn't expired. Anyone else's is simply not found."""
    return Meeting.objects.filter(session_key=session_key, public_id=public_id, expires_at__gt=timezone.now()).first()
