"""LB-01's golden set: tickets with the outcome a careful support agent would reach.

The set lives in evals/lb01/golden.yaml and was written before any prompt
(docs/PLAYBOOK.md, step 3). Everything in it is graded by rules, never by a model:

- category, order and route: exact match, which grades the classifier and the router
  (a ticket that honestly fits two categories lists both, and either is right);
- cites: every listed passage must be among the draft's citations, and retrieval recall
  is measured on the same labels, searching with the case's English `query`;
- mentions: numbers and codes any correct reply states, in either language;
- never: text the reply must not contain, such as another customer's order details,
  compared without regard to case and with numbers written without separators.

The schema checks that each case is complete for its route. An injection is stopped
before the classifier runs, so it expects nothing but its route; an escalation has no
draft, so it expects no citations.
"""

from pathlib import Path
from typing import Annotated, Literal, Self

from django.conf import settings
from pydantic import Field, StringConstraints, model_validator

from core.data_files import Key, StrictEntry, read_data_file
from lb01.models import MAX_TICKET_LENGTH, Ticket

# An order number as a ticket names it, or empty when it names none.
OrderNumber = Annotated[str, StringConstraints(pattern=r"^(?:BB-\d{4})?$")]
# The English search query a good classifier would write for the ticket.
Query = Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=200)]
# A number or a code a correct reply must state, such as 159 or BB-1041.
Mention = Annotated[str, StringConstraints(pattern=r"^(?:\d+|BB-\d{4}|VP\d{9}CZ|KC-\d{5})$")]
# Text a reply must never contain.
Forbidden = Annotated[str, StringConstraints(min_length=2, max_length=80)]
# Several categories, for a ticket that honestly fits more than one.
SeveralCategories = Annotated[list[Ticket.Category], Field(min_length=2)]
# The ticket as the customer wrote it.
TicketText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_TICKET_LENGTH)]

# The only escalations a case may expect. The others (an unchecked ticket, a failed
# step) are failures to measure, never the right answer.
EXPECTED_REASONS = frozenset(
    {Ticket.EscalationReason.INJECTION, Ticket.EscalationReason.SENIOR_AGENT, Ticket.EscalationReason.NO_POLICY}
)


class Expectation(StrictEntry):
    """What a careful agent reaches for one ticket. Which fields apply depends on the route."""

    route: Literal["awaiting_approval", "escalated"]
    reason: Ticket.EscalationReason | None = None
    category: Ticket.Category | SeveralCategories | None = None
    order: OrderNumber = ""
    # Whether the order-lookup tool, which sees only the customer's own orders, finds it.
    order_found: bool | None = None
    cites: list[Key] = Field(default_factory=list)
    query: Query | None = None
    mentions: list[Mention] = Field(default_factory=list)
    never: list[Forbidden] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_complete_for_route(self) -> Self:
        """Require what the route implies, and refuse what it rules out."""
        check_route(self)
        check_order_expectation(self)
        check_draft_expectations(self)
        return self

    def accepted_categories(self) -> list[Ticket.Category]:
        """Return every category a correct classifier may choose, none for an injection."""
        if self.category is None:
            return []
        return self.category if isinstance(self.category, list) else [self.category]


class GoldenCase(StrictEntry):
    """One ticket, who files it and in which language, and the outcome it should get."""

    id: Key
    customer: Key
    language: Literal["en", "cs"]
    # Curated samples open the live demo, and their recorded runs are replayed.
    sample: bool = False
    ticket: TicketText
    expect: Expectation


class GoldenSet(StrictEntry):
    """The whole of golden.yaml: between 20 and 50 cases, as the playbook asks."""

    cases: list[GoldenCase] = Field(min_length=20, max_length=50)

    @model_validator(mode="after")
    def _check_cases(self) -> Self:
        """Refuse a repeated case ID, and require curated samples in both languages."""
        seen: set[str] = set()
        for case in self.cases:
            if case.id in seen:
                raise ValueError(f"case {case.id!r} appears more than once")
            seen.add(case.id)
        sample_languages = {case.language for case in self.cases if case.sample}
        if sample_languages != {"en", "cs"}:
            raise ValueError("the curated samples must include tickets in English and in Czech")
        return self

    def samples(self) -> list[GoldenCase]:
        """Return the curated samples the live demo opens on."""
        return [case for case in self.cases if case.sample]


def check_route(expected: Expectation) -> None:
    """Pair every escalation with an expected reason, and an injection with nothing else."""
    if expected.route == "escalated" and expected.reason not in EXPECTED_REASONS:
        raise ValueError("an escalation needs a reason: injection, senior_agent or no_policy")
    if expected.route == "awaiting_approval" and expected.reason is not None:
        raise ValueError("a ticket awaiting approval has no escalation reason")
    stopped_by_guard = expected.reason == Ticket.EscalationReason.INJECTION
    if stopped_by_guard and (expected.category or expected.order or expected.query):
        raise ValueError("an injection never reaches the classifier, so expect no category, order or query")
    if not stopped_by_guard and expected.category is None:
        raise ValueError("every ticket the classifier reads needs a category")


def check_order_expectation(expected: Expectation) -> None:
    """Say whether the order is found exactly when the ticket names one."""
    if expected.order and expected.order_found is None:
        raise ValueError(f"say whether the order tool finds {expected.order} (order_found)")
    if not expected.order and expected.order_found is not None:
        raise ValueError("order_found needs an order number")


def check_draft_expectations(expected: Expectation) -> None:
    """Expect citations and facts only from a draft, and a query wherever retrieval is graded."""
    if expected.route == "escalated" and (expected.cites or expected.mentions):
        raise ValueError("an escalated ticket has no draft, so it can't cite or mention anything")
    if len(set(expected.cites)) != len(expected.cites):
        raise ValueError("a passage is listed twice in cites")
    graded_retrieval = bool(expected.cites) or expected.reason == Ticket.EscalationReason.NO_POLICY
    if graded_retrieval and expected.query is None:
        raise ValueError("a case that grades retrieval needs the English query to search with")


def read_golden_set(path: Path | None = None) -> GoldenSet:
    """Read and check the golden set, by default evals/lb01/golden.yaml."""
    return read_data_file(path or settings.EVALS_DIR / "lb01" / "golden.yaml", GoldenSet)
