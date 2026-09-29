"""Integration tests for LB-01's background tasks: each ticket runs once, and visitor data goes after 24 hours."""

from datetime import date, timedelta

import pytest
from django.conf import settings
from django.utils import timezone

from lb01.models import Customer, Draft, Order, Ticket
from lb01.pipeline import PipelineResult
from lb01.redaction import Redaction
from lb01.seed import seed
from lb01.tasks import reseed, run_ticket, sweep_expired_tickets

pytestmark = [pytest.mark.integration, pytest.mark.django_db(databases=["lb01"])]


class RecordingPipeline:
    """Stands in for the pipeline: records each ticket it runs, or crashes when told to."""

    def __init__(self, crash: bool = False) -> None:
        """Start with no runs."""
        self.ran: list[int] = []
        self.crash = crash

    def run(self, ticket: Ticket) -> PipelineResult:
        """Record the run, and escalate the ticket as a real run could."""
        self.ran.append(ticket.pk)
        if self.crash:
            raise RuntimeError("an unexpected bug")
        Ticket.objects.filter(pk=ticket.pk).update(status=Ticket.Status.ESCALATED, escalation_reason="no_policy")
        return PipelineResult(redaction=Redaction(text=ticket.body, found={}))


@pytest.fixture(autouse=True)
def seeded() -> None:
    """Load the synthetic data."""
    seed(settings.SEED_DIR / "lb01", date(2026, 10, 1))


def file_ticket(**fields: object) -> Ticket:
    """File a ticket as Sam."""
    return Ticket.objects.create(
        session_key="session-of-sam-visitor-0001",
        customer=Customer.objects.get(key="cus-0001"),
        language="en",
        body="Where is my order?",
        **fields,
    )


def test_a_ticket_runs_once_however_often_its_task_arrives(monkeypatch: pytest.MonkeyPatch) -> None:
    """The first delivery claims and runs the ticket; a redelivered message finds nothing to do."""
    pipeline = RecordingPipeline()
    monkeypatch.setattr("lb01.tasks.worker_pipeline", lambda: pipeline)
    ticket = file_ticket()

    run_ticket(ticket.pk)
    run_ticket(ticket.pk)

    assert pipeline.ran == [ticket.pk]
    assert Ticket.objects.get(pk=ticket.pk).status == Ticket.Status.ESCALATED


def test_a_crash_marks_the_ticket_failed(monkeypatch: pytest.MonkeyPatch) -> None:
    """A bug in the pipeline never leaves a ticket stuck in processing."""
    monkeypatch.setattr("lb01.tasks.worker_pipeline", lambda: RecordingPipeline(crash=True))
    ticket = file_ticket()

    run_ticket(ticket.pk)

    assert Ticket.objects.get(pk=ticket.pk).status == Ticket.Status.FAILED


def test_a_deleted_ticket_is_skipped(monkeypatch: pytest.MonkeyPatch) -> None:
    """A ticket swept before its task ran is simply gone."""
    pipeline = RecordingPipeline()
    monkeypatch.setattr("lb01.tasks.worker_pipeline", lambda: pipeline)

    run_ticket(123_456)

    assert pipeline.ran == []


def test_the_sweep_deletes_visitor_data_after_24_hours() -> None:
    """Expired tickets go with their drafts; tickets still within their day stay."""
    expired = file_ticket(expires_at=timezone.now() - timedelta(minutes=1))
    Draft.objects.create(ticket=expired, sentences=[], claims_supported=True, model="test")
    current = file_ticket()

    deleted = sweep_expired_tickets()

    assert deleted == 1
    assert list(Ticket.objects.values_list("pk", flat=True)) == [current.pk]
    assert not Draft.objects.exists()


def test_the_nightly_reseed_moves_order_dates_to_the_new_day() -> None:
    """After the reseed, an order placed "today" in the seed file was placed today."""
    reseed()

    assert Order.objects.get(number="BB-1042").placed_on == timezone.localdate()
