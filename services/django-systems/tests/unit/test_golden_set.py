"""Tests for LB-01's golden set: it follows its rules, and agrees with the seed data it refers to.

The golden set grades the pipeline, so a mistake in it would pass a wrong answer or fail
a right one. These checks keep every reference real: customers, orders and who owns
them, the passages a reply should cite, and the numbers a reply should state.
"""

import re
from typing import Any

import pytest
from django.conf import settings
from pydantic import ValidationError

from core.data_files import read_data_file
from lb01.golden import Expectation, GoldenSet, read_golden_set
from lb01.models import Ticket
from lb01.numbers import numbers_and_codes
from lb01.seed import CustomerFile, OrderEntry, OrderFile, PolicyFile

# Passages that decide a route rather than appear in a reply, so no draft cites them.
ROUTING_PASSAGES = frozenset({"support.senior-agents", "support.personal-data"})


@pytest.fixture(scope="module")
def golden() -> GoldenSet:
    """Read the golden set once for the module."""
    return read_golden_set()


@pytest.fixture(scope="module")
def passages() -> dict[str, str]:
    """Return every seeded passage's text, in both languages, by key."""
    policies = read_data_file(settings.SEED_DIR / "lb01" / "policies.yaml", PolicyFile).policies
    return {passage.key: f"{passage.text.en} {passage.text.cs}" for policy in policies for passage in policy.passages}


@pytest.fixture(scope="module")
def orders() -> dict[str, OrderEntry]:
    """Return every seeded order by number."""
    return {
        order.number: order for order in read_data_file(settings.SEED_DIR / "lb01" / "orders.yaml", OrderFile).orders
    }


def order_facts(order: OrderEntry) -> str:
    """Write out the numbers and codes the order-lookup tool can report for an order."""
    lines = " ".join(f"{line.quantity} {line.price_czk}" for line in order.items)
    return f"{order.number} {order.tracking_number} {order.shipping_czk} {order.total_czk} {lines}"


def test_every_case_is_filed_by_a_seeded_customer(golden: GoldenSet) -> None:
    """Each case's customer is one of the synthetic customers."""
    customers = {
        customer.key
        for customer in read_data_file(settings.SEED_DIR / "lb01" / "customers.yaml", CustomerFile).customers
    }

    assert {case.customer for case in golden.cases} <= customers


def test_order_found_matches_who_owns_the_order(golden: GoldenSet, orders: dict[str, OrderEntry]) -> None:
    """The order tool finds an order exactly when it exists and belongs to the case's customer."""
    for case in golden.cases:
        expected = case.expect
        if expected.order:
            owner = orders[expected.order].customer if expected.order in orders else None
            assert expected.order_found == (owner == case.customer), case.id


def test_every_cited_passage_exists(golden: GoldenSet, passages: dict[str, str]) -> None:
    """A case can only expect citations of passages that are policy."""
    for case in golden.cases:
        assert set(case.expect.cites) <= passages.keys(), case.id


def test_every_passage_a_reply_can_cite_is_tested(golden: GoldenSet, passages: dict[str, str]) -> None:
    """Each citable passage is expected by at least one case, so retrieval recall covers the whole corpus."""
    cited = {key for case in golden.cases for key in case.expect.cites}

    assert passages.keys() - ROUTING_PASSAGES - cited == set()


def test_every_required_fact_is_in_a_source(
    golden: GoldenSet, passages: dict[str, str], orders: dict[str, OrderEntry]
) -> None:
    """A case never demands a number the reply's sources don't hold."""
    for case in golden.cases:
        expected = case.expect
        sources = " ".join(passages[key] for key in expected.cites)
        if expected.order_found:
            sources += " " + order_facts(orders[expected.order])
        for mention in expected.mentions:
            assert mention in numbers_and_codes(sources), f"{case.id}: {mention}"


def test_the_set_covers_every_category_route_and_reason(golden: GoldenSet) -> None:
    """Every category, both routes and every expected escalation reason appear at least once."""
    categories = {category for case in golden.cases for category in case.expect.accepted_categories()}
    reasons = {case.expect.reason for case in golden.cases if case.expect.reason}

    assert categories == set(Ticket.Category)
    assert {case.expect.route for case in golden.cases} == {"awaiting_approval", "escalated"}
    assert reasons == {"injection", "senior_agent", "no_policy"}


def test_the_samples_show_both_languages_and_both_defences(golden: GoldenSet) -> None:
    """The demo opens on tickets in both languages, including an injection and another customer's order."""
    samples = golden.samples()

    assert {case.language for case in samples} == {"en", "cs"}
    assert any(case.expect.reason == "injection" for case in samples)
    assert any(case.expect.order_found is False for case in samples)


# A complete expectation for a drafted reply, to vary in the rule tests below.
DRAFTED: dict[str, Any] = {
    "route": "awaiting_approval",
    "category": "damaged",
    "order": "BB-1040",
    "order_found": True,
    "cites": ["damaged.torn-bags"],
    "query": "bag arrived torn",
}


@pytest.mark.parametrize(
    ("changes", "problem"),
    [
        ({"route": "escalated"}, "an escalation needs a reason"),
        ({"route": "escalated", "reason": "unchecked", "cites": []}, "an escalation needs a reason"),
        ({"reason": "no_policy"}, "a ticket awaiting approval has no escalation reason"),
        ({"route": "escalated", "reason": "injection", "cites": []}, "an injection never reaches the classifier"),
        ({"category": None}, "every ticket the classifier reads needs a category"),
        ({"category": ["damaged"]}, "at least 2 items"),
        ({"order_found": None}, "say whether the order tool finds BB-1040"),
        ({"order": "", "order_found": False}, "order_found needs an order number"),
        ({"route": "escalated", "reason": "senior_agent"}, "an escalated ticket has no draft"),
        ({"cites": ["damaged.torn-bags", "damaged.torn-bags"]}, "a passage is listed twice"),
        ({"query": None}, "needs the English query"),
        ({"mentions": ["fourteen"]}, "String should match pattern"),
    ],
)
def test_an_expectation_must_be_complete_for_its_route(changes: dict[str, Any], problem: str) -> None:
    """Each route needs its own fields, and rules out the others."""
    with pytest.raises(ValidationError, match=re.escape(problem)):
        Expectation.model_validate({**DRAFTED, **changes})


def test_a_no_policy_escalation_needs_its_query() -> None:
    """Retrieval is graded on no_policy cases too, as the ones where nothing should match."""
    with pytest.raises(ValidationError, match="needs the English query"):
        Expectation.model_validate({"route": "escalated", "reason": "no_policy", "category": "product"})


def test_accepted_categories_lists_every_right_answer() -> None:
    """One category, several for an ambiguous ticket, and none for an injection."""
    single = Expectation.model_validate(DRAFTED)
    several = Expectation.model_validate({**DRAFTED, "category": ["wrong_item", "return"]})
    injection = Expectation.model_validate({"route": "escalated", "reason": "injection"})

    assert single.accepted_categories() == ["damaged"]
    assert several.accepted_categories() == ["wrong_item", "return"]
    assert injection.accepted_categories() == []


def test_the_set_refuses_repeated_ids_and_one_language_samples(golden: GoldenSet) -> None:
    """Case IDs are unique, and the samples must speak both languages."""
    cases = [case.model_dump() for case in golden.cases]

    with pytest.raises(ValidationError, match="appears more than once"):
        GoldenSet.model_validate({"cases": [*cases[:-1], cases[0]]})
    english_samples_only = [{**case, "sample": case["sample"] and case["language"] == "en"} for case in cases]
    with pytest.raises(ValidationError, match="in English and in Czech"):
        GoldenSet.model_validate({"cases": english_samples_only})
