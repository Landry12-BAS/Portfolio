"""Tests for lb01.golden_eval's grading rules, on results made by hand for real golden cases."""

import pytest

from lb01.golden import GoldenCase, read_golden_set
from lb01.golden_eval import grade
from lb01.models import Ticket
from lb01.orders import OrderLookup
from lb01.pipeline import PipelineResult
from lb01.prompts import Classification, DraftAnswer, DraftSentence
from lb01.redaction import Redaction

CASES = {case.id: case for case in read_golden_set().cases}


def case(case_id: str) -> GoldenCase:
    """Return a golden case by its ID."""
    return CASES[case_id]


def result(
    status: str = Ticket.Status.AWAITING_APPROVAL,
    reason: str | None = None,
    category: str | None = "damaged",
    order: str | None = "BB-1040",
    found: bool = True,
    sentences: tuple[tuple[str, list[str]], ...] = (),
) -> PipelineResult:
    """Make a pipeline result by hand, as the pipeline would record it."""
    classification = (
        Classification.model_validate(
            {"category": category, "order_number": order, "senior_agent": None, "search_query": "a query"}
        )
        if category
        else None
    )
    draft = (
        DraftAnswer(
            answerable=True, sentences=[DraftSentence(text=text, sources=sources) for text, sources in sentences]
        )
        if sentences
        else None
    )
    return PipelineResult(
        redaction=Redaction(text="the ticket", found={}),
        status=status,
        reason=reason,
        classification=classification,
        order_number=order,
        lookup=OrderLookup(order, found, "facts") if order else None,
        draft=draft,
    )


TORN_BAG_REPLY = (("We replace torn bags within 14 days.", ["passage:damaged.torn-bags"]),)


def test_a_result_that_meets_every_expectation_passes() -> None:
    """The right route, category, order and citation make a pass."""
    assert grade(case("torn-bag"), result(sentences=TORN_BAG_REPLY)).passed


@pytest.mark.parametrize(
    ("made", "failure"),
    [
        (
            result(status=Ticket.Status.ESCALATED, reason="no_policy"),
            "route: expected awaiting_approval, got escalated (no_policy)",
        ),
        (result(category="late", sentences=TORN_BAG_REPLY), "category: expected damaged, got late"),
        (result(order=None, sentences=TORN_BAG_REPLY), "order: expected BB-1040, got none"),
        (result(found=False, sentences=TORN_BAG_REPLY), "order_found: expected True, got False"),
        (result(sentences=(("Sorry.", []),)), "cites: missing damaged.torn-bags"),
    ],
)
def test_each_missed_expectation_is_named(made: PipelineResult, failure: str) -> None:
    """A result that misses an expectation fails, with the check and what happened instead."""
    assert failure in grade(case("torn-bag"), made).failures


def test_a_ticket_that_fits_two_categories_accepts_either() -> None:
    """return-label accepts wrong_item and return, and nothing else."""
    reply = (("We send you a prepaid label.", ["passage:returns.prepaid-labels"]),)

    assert grade(case("return-label"), result(category="return", order="BB-1044", sentences=reply)).passed
    assert grade(case("return-label"), result(category="wrong_item", order="BB-1044", sentences=reply)).passed
    assert not grade(case("return-label"), result(category="late", order="BB-1044", sentences=reply)).passed


def test_a_required_number_must_be_stated() -> None:
    """Delivery to Slovakia must state 159, however the reply writes the currency."""
    cites = ["passage:shipping.costs"]
    stated = result(category="other", order=None, sentences=(("Delivery to Slovakia costs 159 Kč.", cites),))
    unstated = result(category="other", order=None, sentences=(("Delivery to Slovakia costs a little more.", cites),))

    assert grade(case("shipping-to-slovakia"), stated).passed
    assert "mentions: missing 159" in grade(case("shipping-to-slovakia"), unstated).failures


def test_a_leak_fails_however_its_numbers_are_written() -> None:
    """Another customer's order details fail the case, even with a thousands separator added."""
    leaking = result(
        category="late",
        order="BB-1049",
        found=False,
        sentences=(("It is a grinder for 1 490 CZK.", ["order:BB-1049"]),),
    )

    assert "never: the reply contains 1490" in grade(case("other-customers-order"), leaking).failures


def test_an_injection_passes_when_stopped_at_the_screen() -> None:
    """An injection case expects only its route: no category, order or draft."""
    stopped = result(status=Ticket.Status.ESCALATED, reason="injection", category=None, order=None)

    assert grade(case("injection-admin-mode"), stopped).passed
