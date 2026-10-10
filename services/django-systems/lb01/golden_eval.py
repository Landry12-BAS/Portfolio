"""Grading LB-01's pipeline on the golden set, by rules alone.

Each golden case is filed as a ticket from its customer and run through the real
pipeline as synthetic data (the golden set is synthetic, so it may use the
synthetic-only providers). The result is graded on what evals/lb01/golden.yaml expects:
the route and its reason, the category, the order number and whether the lookup found
it, the passages the draft cites, the numbers it states, and the text it must never
contain. Every eval ticket is rolled back afterwards, so an eval leaves no data behind.

A live eval costs about five gateway calls a case (screen, classify, embed, rerank,
draft), so run it when prompts or routes change, not on every commit.
"""

from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass

from django.db import transaction

from lb01.golden import GoldenCase, GoldenSet
from lb01.models import Customer, Ticket
from lb01.numbers import numbers_and_codes, without_thousands_separators
from lb01.pipeline import PipelineResult, TicketPipeline

# The session eval tickets are filed under. Synthetic runs spend no visitor's quota.
EVAL_SESSION = "golden-set-eval"


@dataclass(frozen=True)
class CaseGrade:
    """One golden case's grade: every expectation it missed, and what the pipeline did instead."""

    case_id: str
    failures: list[str]

    @property
    def passed(self) -> bool:
        """Tell whether the case met every expectation."""
        return not self.failures


@dataclass(frozen=True)
class EvalReport:
    """The grades of one eval run, and how many drafts passed the claim check."""

    grades: list[CaseGrade]
    drafts: int
    supported_drafts: int

    def pass_rate(self) -> float:
        """Return the share of cases that met every expectation."""
        return sum(grade.passed for grade in self.grades) / len(self.grades) if self.grades else 0.0

    def failures_by_check(self) -> Counter[str]:
        """Count the failures by the check that failed, such as `route` or `cites`."""
        return Counter(failure.split(":", 1)[0] for grade in self.grades for failure in grade.failures)


def grade(case: GoldenCase, result: PipelineResult) -> CaseGrade:
    """Grade one pipeline result against its golden case's expectations."""
    failures = [
        *route_failures(case, result),
        *classification_failures(case, result),
        *draft_failures(case, result),
    ]
    return CaseGrade(case_id=case.id, failures=failures)


def route_failures(case: GoldenCase, result: PipelineResult) -> list[str]:
    """Check where the ticket went, and why."""
    expected = case.expect
    got_route = "escalated" if result.status == Ticket.Status.ESCALATED else str(result.status)
    if got_route != expected.route or (result.reason or None) != (expected.reason or None):
        wanted = f"{expected.route} ({expected.reason})" if expected.reason else expected.route
        return [f"route: expected {wanted}, got {got_route} ({result.reason or 'no reason'})"]
    return []


def classification_failures(case: GoldenCase, result: PipelineResult) -> list[str]:
    """Check the category, the order number, and whether the order tool found the order."""
    expected = case.expect
    failures: list[str] = []
    accepted = expected.accepted_categories()
    got_category = result.classification.category if result.classification else None
    if accepted and got_category not in accepted:
        failures.append(f"category: expected {' or '.join(accepted)}, got {got_category or 'none'}")
    if expected.reason != Ticket.EscalationReason.INJECTION and (result.order_number or "") != expected.order:
        failures.append(f"order: expected {expected.order or 'none'}, got {result.order_number or 'none'}")
    if expected.order_found is not None and result.status == Ticket.Status.AWAITING_APPROVAL:
        found = result.lookup.found if result.lookup else None
        if found != expected.order_found:
            failures.append(f"order_found: expected {expected.order_found}, got {found}")
    return failures


def draft_failures(case: GoldenCase, result: PipelineResult) -> list[str]:
    """Check the draft's citations, the numbers it states, and the text it must never contain."""
    expected = case.expect
    sentences = result.draft.sentences if result.draft else []
    reply = " ".join(sentence.text for sentence in sentences)
    cited = {source.removeprefix("passage:") for sentence in sentences for source in sentence.sources}
    failures: list[str] = []
    missing = sorted(set(expected.cites) - cited)
    if missing:
        failures.append(f"cites: missing {', '.join(missing)}")
    unstated = sorted(set(expected.mentions) - numbers_and_codes(reply))
    if unstated:
        failures.append(f"mentions: missing {', '.join(unstated)}")
    readable = without_thousands_separators(reply).casefold()
    leaked = [text for text in expected.never if without_thousands_separators(text).casefold() in readable]
    if leaked:
        failures.append(f"never: the reply contains {', '.join(leaked)}")
    return failures


def evaluate(golden: GoldenSet, pipeline: TicketPipeline, case_ids: Iterable[str] | None = None) -> EvalReport:
    """Run golden cases through the pipeline and grade them, rolling their tickets back afterwards.

    Runs every case, or only those in `case_ids`.
    """
    wanted = set(case_ids) if case_ids is not None else None
    cases = [case for case in golden.cases if wanted is None or case.id in wanted]
    grades: list[CaseGrade] = []
    drafts = supported = 0
    with transaction.atomic(using="lb01"):
        for case in cases:
            result = run_case(case, pipeline)
            grades.append(grade(case, result))
            if result.claims is not None:
                drafts += 1
                supported += result.claims.supported
        transaction.set_rollback(True, using="lb01")
    return EvalReport(grades=grades, drafts=drafts, supported_drafts=supported)


def run_case(case: GoldenCase, pipeline: TicketPipeline) -> PipelineResult:
    """File one golden case as a ticket from its customer, and run it as synthetic data."""
    ticket = Ticket.objects.create(
        session_key=EVAL_SESSION,
        customer=Customer.objects.get(key=case.customer),
        language=case.language,
        body=case.ticket,
    )
    return pipeline.run(ticket, data_class="synthetic")
