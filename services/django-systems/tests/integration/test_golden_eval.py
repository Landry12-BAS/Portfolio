"""Integration tests for the golden-set eval: it runs real cases through the pipeline and leaves no data behind."""

import json
from datetime import date
from io import StringIO

import pytest
from django.conf import settings
from django.core.management import CommandError, call_command

from lb01.golden import read_golden_set
from lb01.golden_eval import evaluate
from lb01.models import PolicyPassage, Ticket
from lb01.pipeline import TicketPipeline
from lb01.seed import seed
from lb_common.tracing import Tracer
from tests.support import FakeChat, FakeGateway, MemorySpanWriter

pytestmark = [pytest.mark.integration, pytest.mark.django_db(databases=["lb01"])]

TORN_BAG_CLASSIFICATION = json.dumps(
    {"category": "damaged", "order_number": "BB-1040", "senior_agent": None, "search_query": "bag arrived torn open"}
)
TORN_BAG_DRAFT = json.dumps(
    {
        "answerable": True,
        "sentences": [
            {"text": "Hello Sam,", "sources": []},
            {
                "text": "Send us a photo within 14 days and we send a replacement.",
                "sources": ["passage:damaged.torn-bags"],
            },
        ],
    }
)


@pytest.fixture(autouse=True)
def corpus() -> None:
    """Seed the synthetic data, searching by keywords."""
    seed(settings.SEED_DIR / "lb01", date(2026, 10, 1))
    PolicyPassage.objects.update(embedding=None)


def fake_pipeline() -> TicketPipeline:
    """Build a pipeline whose screen flags the admin-mode injection and whose models answer the torn-bag case."""
    gateway = FakeGateway(flag_when="Ignore all previous instructions")
    chat = FakeChat({"lb-fast": [TORN_BAG_CLASSIFICATION], "lb-tools": [TORN_BAG_DRAFT]})
    return TicketPipeline(models=gateway, chat=chat, tracer=Tracer(MemorySpanWriter()), today=lambda: date(2026, 10, 1))


def test_golden_cases_run_through_the_pipeline_and_pass() -> None:
    """A drafted case and an injection case both meet their expectations, and their tickets are rolled back."""
    report = evaluate(read_golden_set(), fake_pipeline(), case_ids=["torn-bag", "injection-admin-mode"])

    assert [(grade.case_id, grade.failures) for grade in report.grades] == [
        ("torn-bag", []),
        ("injection-admin-mode", []),
    ]
    assert report.pass_rate() == 1.0
    assert (report.drafts, report.supported_drafts) == (1, 1)
    assert not Ticket.objects.exists()


def run_eval_command(*args: str) -> str:
    """Run `eval_lb01` and return what it printed."""
    output = StringIO()
    call_command("eval_lb01", *args, stdout=output)
    return output.getvalue()


def test_the_command_refuses_an_unknown_case() -> None:
    """A mistyped case ID stops the command before any gateway call."""
    with pytest.raises(CommandError, match="No golden case has the ID torn-bags"):
        run_eval_command("--case", "torn-bags")


def test_the_command_prints_each_case_and_the_totals(monkeypatch: pytest.MonkeyPatch) -> None:
    """Each case is marked pass or FAIL, then the totals follow."""
    monkeypatch.setattr("lb01.management.commands.eval_lb01.connect_pipeline", fake_pipeline)

    printed = run_eval_command("--case", "torn-bag")

    assert "pass  torn-bag" in printed
    assert "1 of 1 cases passed (100.0%)." in printed
    assert "1 of 1 drafts passed the claim check." in printed
