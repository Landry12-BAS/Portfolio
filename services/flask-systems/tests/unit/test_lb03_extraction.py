"""The call budget and the two questions put to the models: five calls at most, never beyond the deadline."""

import json
from decimal import Decimal

import pytest

from core.structured import ChatMessage, StructuredOutputError
from lb03 import limits
from lb03.checks import CheckId, CheckResult
from lb03.extraction import CallBudget, LimitError, extract, repair
from lb03.golden import printed_as_reply, read_golden_set
from lb03.prompts import EXTRACT_ALIAS, EXTRACT_MAX_TOKENS, VISION_ALIAS, VISION_MAX_TOKENS
from lb03.states import FailureCode
from tests.lb03_support import FakeGuard, verdict
from tests.support import FakeChat, unavailable

MESSAGES = [ChatMessage("system", "Read invoices."), ChatMessage("user", "The document.")]
REPLY = json.dumps(printed_as_reply(read_golden_set().case("bohemia-packaging-2026-0412").printed))  # type: ignore[arg-type]


class Clock:
    """A clock a test moves by hand, in seconds."""

    def __init__(self) -> None:
        """Start at zero."""
        self.now = 0.0

    def __call__(self) -> float:
        """Return the time."""
        return self.now


def budget_for(chat: FakeChat, guard: FakeGuard | None = None, clock: Clock | None = None) -> CallBudget:
    """Make a call budget over a fake chat and guard, with a clock the test can move."""
    return CallBudget(chat, guard, clock or Clock())


def failed_check() -> list[CheckResult]:
    """Make the one failed check a repair names."""
    return [CheckResult(CheckId.TOTAL_RECONCILES, "failed", message="Total mismatch.", fields=("total",))]


def test_a_good_reply_is_one_call_and_comes_back_as_an_invoice() -> None:
    """The reply is validated against the invoice schema, with the amounts as exact decimals."""
    chat = FakeChat({EXTRACT_ALIAS: [REPLY]})
    answer = extract(budget_for(chat), EXTRACT_ALIAS, MESSAGES)
    assert answer.attempts == 1
    assert answer.value.total == Decimal("10406.00")
    assert answer.value.vendor == "Bohemia Packaging s.r.o."
    assert chat.calls() == 1


def test_a_reply_that_is_not_json_gets_one_repair() -> None:
    """A malformed reply costs a second call, which quotes the first and says what was wrong."""
    chat = FakeChat({EXTRACT_ALIAS: ["Sure! Here you go: {oops", REPLY]})
    answer = extract(budget_for(chat), EXTRACT_ALIAS, MESSAGES)
    assert answer.attempts == 2
    assert chat.calls() == 2
    assert chat.asked(EXTRACT_ALIAS)[1][-2].role == "assistant"


def test_two_malformed_replies_are_an_error_for_the_pipeline_to_route() -> None:
    """After the one repair the model's output is given up on."""
    chat = FakeChat({EXTRACT_ALIAS: ["no", "still no"]})
    with pytest.raises(StructuredOutputError):
        extract(budget_for(chat), EXTRACT_ALIAS, MESSAGES)


def test_the_targeted_repair_is_one_call_and_is_never_repaired() -> None:
    """A malformed answer to the repair is an error at once: the repair would be a call the document has no room for."""
    chat = FakeChat({EXTRACT_ALIAS: ["not json"]})
    with pytest.raises(StructuredOutputError):
        repair(budget_for(chat), EXTRACT_ALIAS, MESSAGES, REPLY, failed_check())
    assert chat.calls() == 1


def test_the_repair_request_names_the_failed_checks() -> None:
    """The messages of the repair end with the model's own answer and the failed check's name and fields."""
    chat = FakeChat({EXTRACT_ALIAS: [REPLY]})
    repair(budget_for(chat), EXTRACT_ALIAS, MESSAGES, REPLY, failed_check())
    sent = chat.asked(EXTRACT_ALIAS)[0]
    assert sent[:2] == MESSAGES
    assert sent[2].role == "assistant"
    assert "total_reconciles" in sent[3].content
    assert "Total mismatch." in sent[3].content


def test_each_alias_is_asked_for_no_more_than_its_cap() -> None:
    """lb-fast may write 1,024 tokens and lb-vision 2,048, which are the caps in routing.yaml."""
    chat = FakeChat({EXTRACT_ALIAS: [REPLY], VISION_ALIAS: [REPLY]})
    budget = budget_for(chat)
    extract(budget, EXTRACT_ALIAS, MESSAGES)
    extract(budget, VISION_ALIAS, MESSAGES)
    assert chat.output_caps == {EXTRACT_ALIAS: EXTRACT_MAX_TOKENS, VISION_ALIAS: VISION_MAX_TOKENS}


def test_the_most_a_document_can_spend_is_five_calls_and_the_sixth_is_refused() -> None:
    """Two guard calls, an extraction with its repair, and the targeted repair make five; nothing makes a sixth."""
    chat = FakeChat({EXTRACT_ALIAS: ["bad", REPLY, REPLY]})
    guard = FakeGuard()
    budget = budget_for(chat, guard)
    budget.check_injection("first segment")
    budget.check_injection("second segment")
    extraction = extract(budget, EXTRACT_ALIAS, MESSAGES)
    repair(budget, EXTRACT_ALIAS, MESSAGES, extraction.reply, failed_check())
    assert budget.calls == limits.MAX_MODEL_CALLS == 5
    with pytest.raises(LimitError) as caught:
        budget.complete(EXTRACT_ALIAS, MESSAGES, 100)
    assert caught.value.code is FailureCode.CALL_LIMIT
    assert chat.calls() == 3
    assert guard.texts == ["first segment", "second segment"]


def test_a_call_waits_no_longer_than_the_documents_time_left_or_a_calls_own_limit() -> None:
    """Each call is given the smaller of its own 50 seconds and what is left of the document's 150."""
    clock = Clock()
    chat = FakeChat({EXTRACT_ALIAS: [REPLY, REPLY]})
    budget = budget_for(chat, clock=clock)
    budget.complete(EXTRACT_ALIAS, MESSAGES, 100)
    clock.now = 140.0
    budget.complete(EXTRACT_ALIAS, MESSAGES, 100)
    assert chat.timeouts == [limits.MODEL_CALL_TIMEOUT_SECONDS, pytest.approx(10.0)]


def test_no_call_is_started_when_less_than_the_least_worthwhile_time_is_left() -> None:
    """With under two seconds left a call is refused, as running out of time and not of calls."""
    clock = Clock()
    chat = FakeChat({EXTRACT_ALIAS: [REPLY]})
    budget = budget_for(chat, clock=clock)
    clock.now = limits.DOCUMENT_DEADLINE_SECONDS - 1.0
    with pytest.raises(LimitError) as caught:
        budget.complete(EXTRACT_ALIAS, MESSAGES, 100)
    assert caught.value.code is FailureCode.TIME_LIMIT
    assert chat.calls() == 0
    assert budget.calls == 0


def test_the_injection_check_is_a_call_like_the_others() -> None:
    """A guard check counts against the five, and is refused when the time is gone."""
    clock = Clock()
    guard = FakeGuard([verdict(flagged=True, score=0.99)])
    budget = budget_for(FakeChat({}), guard, clock)
    assert budget.check_injection("text").flagged is True
    assert budget.calls == 1
    clock.now = 149.5
    with pytest.raises(LimitError):
        budget.check_injection("more")


def test_without_a_guard_the_text_counts_as_unchecked() -> None:
    """A service with no injection check cannot show a document to a model: it says so, and spends nothing."""
    budget = budget_for(FakeChat({}), None)
    with pytest.raises(LimitError) as caught:
        budget.check_injection("text")
    assert caught.value.code is FailureCode.UNCHECKED
    assert budget.calls == 0


def test_a_failed_gateway_call_still_counts_as_a_call() -> None:
    """A call that raised was made, so the budget has spent it, which is what keeps retries bounded."""
    chat = FakeChat({EXTRACT_ALIAS: [unavailable()]})
    budget = budget_for(chat)
    with pytest.raises(Exception, match="unavailable"):
        budget.complete(EXTRACT_ALIAS, MESSAGES, 100)
    assert budget.calls == 1
