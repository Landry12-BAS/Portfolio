"""LB-09's background work, run by the Celery worker: the meetings, and the sweeps that keep the promises.

The API stores a recording and queues it here, so a visitor never waits on a transcriber inside a request. A
meeting runs once: the task claims it by moving it from received to processing, so a redelivered message finds
nothing left to do; a queued message that waits longer than its expiry is dropped rather than run late; a task
past its time limit, or one that crashes, marks the meeting failed and removes its audio instead of leaving
either behind. The sweep deletes meetings past their 24 hours, gives up on ones the worker lost, and removes
any audio file older than an hour, whatever left it.
"""

import functools
import logging

from celery import shared_task
from celery.exceptions import SoftTimeLimitExceeded
from django.db import transaction
from django.utils import timezone

from lb09.limits import STALE_MEETING_AFTER, TASK_EXPIRES_SECONDS, TASK_SOFT_TIME_LIMIT_SECONDS, TASK_TIME_LIMIT_SECONDS
from lb09.models import Meeting
from lb09.pipeline import MeetingPipeline, connect_pipeline, mark_failed
from lb09.storage import AudioStore

logger = logging.getLogger(__name__)


@functools.cache
def worker_pipeline() -> MeetingPipeline:
    """Connect the pipeline once per worker process, and reuse it for every meeting."""
    return connect_pipeline()


def queue_meeting(meeting_id: int) -> None:
    """Queue a meeting for the worker, to be dropped unrun if it waits longer than the expiry."""
    run_meeting.apply_async(args=(meeting_id,), expires=TASK_EXPIRES_SECONDS)


@shared_task(
    name="lb09.run_meeting",
    ignore_result=True,
    soft_time_limit=TASK_SOFT_TIME_LIMIT_SECONDS,
    time_limit=TASK_TIME_LIMIT_SECONDS,
)
def run_meeting(meeting_id: int) -> None:
    """Run a received meeting through the pipeline, once."""
    meeting = claim_meeting(meeting_id)
    if meeting is None:
        return
    try:
        worker_pipeline().run(meeting)
    except SoftTimeLimitExceeded:
        logger.warning("Meeting %s ran out of time.", meeting.public_id)
        give_up(meeting, Meeting.Failure.STALE)
    except Exception:
        logger.exception("The pipeline crashed on meeting %s.", meeting.public_id)
        give_up(meeting, Meeting.Failure.PIPELINE_ERROR)


def claim_meeting(meeting_id: int) -> Meeting | None:
    """Move a received meeting to processing and return it, or None if it was already claimed or is gone."""
    with transaction.atomic(using="lb09"):
        meeting = Meeting.objects.select_for_update().filter(pk=meeting_id, status=Meeting.Status.RECEIVED).first()
        if meeting is None:
            return None
        meeting.status = Meeting.Status.PROCESSING
        meeting.save(update_fields=["status", "updated_at"])
    return meeting


def give_up(meeting: Meeting, reason: str) -> None:
    """Mark a meeting failed for a reason, and make sure its audio is gone."""
    store = worker_pipeline().store
    if meeting.audio_name:
        store.delete(meeting.audio_name)
    mark_failed(meeting, reason)


@shared_task(name="lb09.sweep", ignore_result=True)
def sweep() -> dict[str, int]:
    """Delete expired meetings, fail the ones the worker lost, remove old audio files; return the counts."""
    now = timezone.now()
    expired = Meeting.objects.filter(expires_at__lte=now)
    expired_count = expired.count()
    expired.delete()
    stale = Meeting.objects.filter(
        status__in=(Meeting.Status.RECEIVED, Meeting.Status.PROCESSING), updated_at__lte=now - STALE_MEETING_AFTER
    )
    store = AudioStore()
    stale_count = 0
    for meeting in stale:
        if meeting.audio_name:
            store.delete(meeting.audio_name)
        mark_failed(meeting, Meeting.Failure.STALE)
        stale_count += 1
    return {"expired": expired_count, "stale": stale_count, "audio": store.sweep()}
