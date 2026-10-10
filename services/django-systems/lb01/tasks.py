"""LB-01's background work, run by the Celery worker: tickets, the 24-hour sweep and the nightly reseed.

The API files a ticket and queues it here, so a visitor never waits on the gateway
inside a request. A ticket runs once: the task claims it by moving it from received to
processing, so a redelivered message finds nothing left to do. A crash marks the ticket
failed instead of leaving it stuck in processing.
"""

import functools
import logging

from celery import shared_task
from django.conf import settings
from django.db import transaction
from django.utils import timezone

from lb01.models import Ticket
from lb01.pipeline import TicketPipeline, connect_pipeline
from lb01.seed import seed

logger = logging.getLogger(__name__)


@functools.cache
def worker_pipeline() -> TicketPipeline:
    """Connect the pipeline once per worker process, and reuse it for every ticket."""
    return connect_pipeline()


@shared_task(name="lb01.run_ticket", ignore_result=True)
def run_ticket(ticket_id: int) -> None:
    """Run a filed ticket through the pipeline, once."""
    ticket = claim_ticket(ticket_id)
    if ticket is None:
        return
    try:
        worker_pipeline().run(ticket)
    except Exception:
        logger.exception("The pipeline crashed on ticket %s.", ticket.public_id)
        Ticket.objects.filter(pk=ticket.pk).update(status=Ticket.Status.FAILED, updated_at=timezone.now())


def claim_ticket(ticket_id: int) -> Ticket | None:
    """Move a received ticket to processing and return it, or return None if it was already claimed or is gone."""
    with transaction.atomic(using="lb01"):
        ticket = (
            Ticket.objects.select_for_update()
            .select_related("customer")
            .filter(pk=ticket_id, status=Ticket.Status.RECEIVED)
            .first()
        )
        if ticket is None:
            return None
        ticket.status = Ticket.Status.PROCESSING
        ticket.save(update_fields=["status", "updated_at"])
    return ticket


@shared_task(name="lb01.sweep_expired_tickets", ignore_result=True)
def sweep_expired_tickets() -> int:
    """Delete the tickets past their 24 hours, with their drafts and decisions, and return how many went."""
    expired = Ticket.objects.filter(expires_at__lte=timezone.now())
    count = expired.count()
    expired.delete()
    return count


@shared_task(name="lb01.reseed", ignore_result=True)
def reseed() -> None:
    """Reload the synthetic data, so the orders' relative dates count from the new day."""
    seed(settings.SEED_DIR / "lb01", timezone.localdate())
