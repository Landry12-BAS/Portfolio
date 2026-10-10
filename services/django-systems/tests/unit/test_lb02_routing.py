"""Tests that LB-02's limits in the code and its quotas in the gateway's routing.yaml agree with each other.

The gateway refuses what routing.yaml doesn't allow, and the service refuses what limits.py doesn't allow.
If they drift apart, a visitor is refused halfway through a turn instead of being handed to a person, or the
datasheet's numbers stop being what the system enforces. These tests keep them in step.
"""

from typing import Any

import pytest
import yaml
from django.conf import settings

from lb02.golden import read_golden_set
from lb02.limits import MAX_MODEL_CALLS_PER_CONVERSATION, MESSAGES_PER_SESSION
from lb02.prompts import CHAT_MAX_TOKENS, LANGUAGE_MAX_TOKENS, PROMPT_TOKEN_BUDGET

# A booking in the happy path: three injection checks and four chat calls.
CALLS_PER_BOOKING = 7
# Bookings a day the quota is sized for.
BOOKINGS_PER_DAY = 25


@pytest.fixture(scope="module")
def routing() -> dict[str, Any]:
    """Read the gateway's routing table the way its own checker does: as plain YAML."""
    path = settings.EVALS_DIR.parent / "services" / "gateway" / "routing.yaml"
    document: dict[str, Any] = yaml.safe_load(path.read_text(encoding="utf-8"))
    return document


@pytest.fixture(scope="module")
def system(routing: dict[str, Any]) -> dict[str, Any]:
    """Return LB-02's entry under `systems:`."""
    entry: dict[str, Any] = routing["systems"]["lb-02"]
    return entry


def test_lb_02_is_a_system_of_the_django_service_with_the_aliases_it_calls(
    routing: dict[str, Any], system: dict[str, Any]
) -> None:
    """The service may ask for the fast model, the tools model and the guard, and nothing else."""
    assert system["service"] == "django-systems"
    assert set(system["aliases"]) == {"lb-fast", "lb-tools", "lb-guard"}
    assert set(system["aliases"]) <= set(routing["aliases"])


def test_a_conversation_of_thirty_messages_fits_the_services_call_budget() -> None:
    """Thirty messages at a check and a reply each is 60 calls, and the service's own budget covers them."""
    assert MESSAGES_PER_SESSION * 2 <= MAX_MODEL_CALLS_PER_CONVERSATION


def test_the_gateway_never_refuses_before_the_service_hands_over(system: dict[str, Any]) -> None:
    """The cap in routing.yaml is above the conversation's budget: a visitor gets a handoff, not a quota error."""
    assert system["maxCallsPerRun"] > MAX_MODEL_CALLS_PER_CONVERSATION


def test_a_visitor_can_have_two_full_conversations_a_day(system: dict[str, Any]) -> None:
    """The per-visitor quota covers two conversations at the service's budget."""
    assert system["sessionDailyCalls"] >= 2 * MAX_MODEL_CALLS_PER_CONVERSATION


def test_the_daily_quota_covers_the_bookings_it_is_sized_for_and_a_full_golden_run(system: dict[str, Any]) -> None:
    """Twenty-five bookings a day, and the owner's golden-set run on top, at the cases' own ceilings."""
    golden_run = sum(case.end.calls_at_most for case in read_golden_set().cases)

    assert system["dailyCalls"] >= BOOKINGS_PER_DAY * CALLS_PER_BOOKING + golden_run


def test_every_prompt_the_service_sends_fits_its_aliass_limits(routing: dict[str, Any]) -> None:
    """The prompt budget and the output caps sit inside what lb-tools and lb-fast accept."""
    tools, fast = routing["aliases"]["lb-tools"], routing["aliases"]["lb-fast"]

    assert tools["maxInputTokens"] > PROMPT_TOKEN_BUDGET
    assert tools["maxOutputTokens"] >= CHAT_MAX_TOKENS
    assert fast["maxOutputTokens"] >= LANGUAGE_MAX_TOKENS
    assert routing["aliases"]["lb-guard"]["maxInputTokens"] > 500 / 3.5


def test_the_golden_ceilings_for_a_plain_booking_keep_to_the_datasheets_6_to_10_calls() -> None:
    """English and Czech get receipts the code writes, so a booking stays within 10; German and Slovak have none."""
    cases = {case.id: case for case in read_golden_set().cases}

    assert cases["book-cupping-en"].end.calls_at_most <= 10
    assert cases["book-tasting-cs"].end.calls_at_most <= 10
    # The model writes the answers to the hold and the confirmation in the other languages: one call each more.
    assert cases["book-workshop-de"].end.calls_at_most <= 12
    assert cases["book-evening-tasting-sk"].end.calls_at_most <= 12
