"""Asking the models: the call budget of one document, and the two questions the pipeline puts to them.

A document may make at most five model calls, the injection check's included, and has 150 seconds in all. The
budget stands between the pipeline and the gateway, so no step can spend a call it was not given, and no call can
outlast the document's deadline: it counts every call, hands each the time that is left, and refuses the sixth.
The calls are: the injection check (one or two segments of text), the extraction and its one repair of a reply that
is not the JSON asked for, and the one targeted repair of a failed check. The targeted repair is never itself
repaired, which is what keeps the sum at five.

Every model answer is untrusted input: it is parsed against the lenient invoice schema (lb03/invoice.py) by the
platform's JSON helper (core/structured.py), and what it holds is checked by code afterwards, never believed.
"""

import time
from collections.abc import Callable, Sequence

from core.structured import ChatMessage, ChatModels, Completion, InjectionGuard, StructuredAnswer, ask_for_json
from lb03 import limits
from lb03.checks import CheckResult
from lb03.invoice import ExtractedInvoice
from lb03.prompts import ECHO_CHARS, EXTRACT_ALIAS, EXTRACT_MAX_TOKENS, VISION_MAX_TOKENS, repair_messages
from lb03.states import FailureCode
from lb_common.gateway import GuardVerdict


class LimitError(Exception):
    """The document used up its model calls or its time, so it may make no more calls; `code` says which."""

    def __init__(self, code: FailureCode) -> None:
        """Stop the document, for `code`."""
        super().__init__(code.value)
        self.code = code


class CallBudget:
    """The model calls one document may make: at most five, each held to the time the document has left."""

    def __init__(
        self,
        chat: ChatModels,
        guard: InjectionGuard | None,
        clock: Callable[[], float] = time.monotonic,
        max_calls: int = limits.MAX_MODEL_CALLS,
        deadline_seconds: float = limits.DOCUMENT_DEADLINE_SECONDS,
    ) -> None:
        """Count the calls made through `chat` and `guard`, with the document's clock starting now."""
        self._chat = chat
        self._guard = guard
        self._clock = clock
        self._max_calls = max_calls
        self._deadline = clock() + deadline_seconds
        self.calls = 0

    def seconds_left(self) -> float:
        """Return how long the document has left, which may be below zero."""
        return self._deadline - self._clock()

    def spend(self) -> float:
        """Take one call from the budget and return the seconds it may wait; refuse when there is no call or no time."""
        if self.calls >= self._max_calls:
            raise LimitError(FailureCode.CALL_LIMIT)
        left = self.seconds_left()
        if left < limits.MIN_CALL_SECONDS:
            raise LimitError(FailureCode.TIME_LIMIT)
        self.calls += 1
        return left

    def complete(
        self, alias: str, messages: Sequence[ChatMessage], max_tokens: int, timeout_seconds: float | None = None
    ) -> Completion:
        """Make one chat call if the document may still make one, waiting no longer than it has time for."""
        left = self.spend()
        allowed = limits.MODEL_CALL_TIMEOUT_SECONDS if timeout_seconds is None else timeout_seconds
        return self._chat.complete(alias, messages, max_tokens, min(allowed, left))

    def check_injection(self, text: str) -> GuardVerdict:
        """Ask the injection check about a text, as one of the document's calls."""
        if self._guard is None:
            raise LimitError(FailureCode.UNCHECKED)
        self.spend()
        return self._guard.check(text)


def max_tokens_for(alias: str) -> int:
    """Return the most an alias may write for this system: its own cap in routing.yaml."""
    return EXTRACT_MAX_TOKENS if alias == EXTRACT_ALIAS else VISION_MAX_TOKENS


def extract(budget: CallBudget, alias: str, messages: Sequence[ChatMessage]) -> StructuredAnswer[ExtractedInvoice]:
    """Ask for the invoice as JSON, with one repair of a reply that is not the object asked for."""
    return ask_for_json(budget, alias, messages, ExtractedInvoice, max_tokens_for(alias), echo_chars=ECHO_CHARS)


def repair(
    budget: CallBudget,
    alias: str,
    base: Sequence[ChatMessage],
    previous_reply: str,
    failed: list[CheckResult],
) -> StructuredAnswer[ExtractedInvoice]:
    """Send the model back to the document, once, naming exactly the checks that failed; its reply is not repaired."""
    return ask_for_json(
        budget,
        alias,
        repair_messages(base, previous_reply, failed),
        ExtractedInvoice,
        max_tokens_for(alias),
        repair=False,
        echo_chars=ECHO_CHARS,
    )
