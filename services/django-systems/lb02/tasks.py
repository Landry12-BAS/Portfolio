"""LB-02's background work, run by the Celery worker: the hold sweep, the 24-hour sweep and the nightly reset.

None of it makes the booking rules correct. A hold that ran out is already free in every
check (lb02/booking.py), so the minute-by-minute sweep only tidies rows and tells the live
calendar, and a worker that is down for an hour changes nothing a visitor can see except
how fast the calendar updates.
"""

import logging

from celery import shared_task
from django.conf import settings
from django.db import transaction
from django.utils import timezone

from lb02 import seed as calendar_seed
from lb02.booking import DATABASE, BookingService, local_day
from lb02.live import ChannelLayerNotifier, announce_reset
from lb02.models import ACTIVE_STATUSES, Conversation, Reservation

logger = logging.getLogger(__name__)


@shared_task(name="lb02.sweep_expired_holds", ignore_result=True)
def sweep_expired_holds() -> int:
    """Mark the holds that ran out as expired, tell the live calendar, and return how many there were."""
    return BookingService(notifier=ChannelLayerNotifier()).expire_stale_holds()


@shared_task(name="lb02.sweep_expired_conversations", ignore_result=True)
def sweep_expired_conversations() -> int:
    """Delete the conversations past their 24 hours, with everything they hold, and return how many went.

    A conversation takes its messages, holds, booking, confirmation and handoff with it.
    The slots its holds and booking kept become free, and the live calendar hears of it.
    """
    service = BookingService(notifier=ChannelLayerNotifier())
    with transaction.atomic(using=DATABASE):
        expired = Conversation.objects.filter(expires_at__lte=timezone.now())
        keeping_a_room = list(Reservation.objects.filter(conversation__in=expired, status__in=ACTIVE_STATUSES))
        count = expired.count()
        expired.delete()
        if keeping_a_room:
            service.announce(keeping_a_room)
    return count


@shared_task(name="lb02.reset_calendar", ignore_result=True)
def reset_calendar() -> None:
    """Start the demo calendar afresh: clear what visitors made and lay out the next 14 days from today."""
    calendar_seed.reset_calendar(settings.SEED_DIR / "lb02", local_day(timezone.now()))
    announce_reset()
