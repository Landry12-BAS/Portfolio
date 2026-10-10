"""LB-01's eval packs: the classifier's and the drafter's production prompts and golden set, for Eval Lab (LB-10).

Two packs come out of one golden set (evals/lb01/golden.yaml), because the pipeline makes two model
calls a ticket and each is a prompt of its own:

- `lb01-classifier`: `CLASSIFY_SYSTEM` and the ticket between its markers, on `lb-fast`. Every case
  but the injections (which the screen turns away before the classifier sees them) is in it. Graded
  on the fields the golden set names: the category (or either of two), the order number, and
  whether a senior agent is asked for.
- `lb01-drafter`: `DRAFT_SYSTEM` and the ticket with its sources, on `lb-tools`. Only the tickets a
  draft is written for are in it. The sources are materialised from the seed files: the passages the
  golden set says a careful draft cites, in the ticket's language, and the order's facts as the
  order tool reports them. Production also hands the drafter the other passages its search found,
  which the lab cannot reproduce without the search index, so a pack case shows the drafter fewer
  distractors than production does. Graded on the citations and the forbidden text; the numbers a
  draft must mention are left to production's eval, whose reading of numbers forgives formatting.

The ticket is redacted first, as the pipeline does, so no case carries an address or a number the
redactor would hide. Each exporter checks itself: the pack's templates, filled with a case's inputs,
must give exactly the messages `classify_messages` and `draft_messages` build, or it refuses.
"""

from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

from core.data_files import read_data_file
from core.packs import from_format_string, render, require_same
from lb01.golden import GoldenCase, GoldenSet, read_golden_set
from lb01.models import Order, Policy, PolicyPassage, Ticket
from lb01.orders import describe_order, not_found_facts
from lb01.pipeline import CLASSIFY_ALIAS, CLASSIFY_MAX_TOKENS, DRAFT_ALIAS, DRAFT_MAX_TOKENS, passage_text
from lb01.prompts import (
    CLASSIFY_SYSTEM,
    DRAFT_SYSTEM,
    LANGUAGE_NAMES,
    TICKET_MARKER,
    Classification,
    DraftAnswer,
    Source,
    classify_messages,
    draft_messages,
)
from lb01.redaction import redact
from lb01.seed import CustomerFile, OrderFile, PolicyFile, day_from

# The day the pack's tickets are read on: the orders' relative dates count from it. Fixed, so the
# pack (and so the lab's cached baselines) changes only when a prompt, the golden set or the seed does.
PACK_TODAY = date(2026, 10, 1)
CLASSIFIER_PACK = "lb01-classifier"
DRAFTER_PACK = "lb01-drafter"
MADE_BY = "just export-packs-lb01"
SOURCE = "services/django-systems/lb01/prompts.py, evals/lb01/golden.yaml and data/seed/lb01"
# The matters a senior agent takes, as the classifier names them.
SENIOR_MATTERS = ["legal", "allergy", "fraud", "personal_data"]
# The user message of each prompt, as a template. The ticket's own marker-like text is already removed
# from the input (`quote_ticket` does that before quoting), so the template only wraps it.
CLASSIFY_USER_TEMPLATE = "<ticket>\n{{ticket}}\n</ticket>"
DRAFT_USER_TEMPLATE = (
    "Today is {{today}}.\nCustomer: {{customer_name}}\n\n<ticket>\n{{ticket}}\n</ticket>\n\nSources:\n{{sources}}"
)


class SeedFacts:
    """The seed files a pack needs: customers by key, orders by number, and passages by key with their policy."""

    def __init__(self, seed_directory: Path) -> None:
        """Read the three seed files of LB-01."""
        customers = read_data_file(seed_directory / "customers.yaml", CustomerFile)
        orders = read_data_file(seed_directory / "orders.yaml", OrderFile)
        policies = read_data_file(seed_directory / "policies.yaml", PolicyFile)
        self.customer_names = {customer.key: customer.name for customer in customers.customers}
        self.order_customers = {order.number: order.customer for order in orders.orders}
        self.orders = {order.number: order for order in orders.orders}
        self.passages: dict[str, PolicyPassage] = {}
        for policy_entry in policies.policies:
            policy = Policy(key=policy_entry.key, title_en=policy_entry.title.en, title_cs=policy_entry.title.cs)
            for passage in policy_entry.passages:
                self.passages[passage.key] = PolicyPassage(
                    key=passage.key,
                    policy=policy,
                    title_en=passage.title.en,
                    title_cs=passage.title.cs,
                    text_en=passage.text.en,
                    text_cs=passage.text.cs,
                )

    def order_facts(self, number: str, customer_key: str) -> str:
        """Report an order as the order tool would: its facts when it is the customer's, else that it isn't."""
        entry = self.orders.get(number)
        if entry is None or entry.customer != customer_key:
            return not_found_facts(number)
        order = Order(
            number=entry.number,
            status=entry.status,
            country=entry.country,
            placed_on=PACK_TODAY + timedelta(days=entry.placed),
            roasted_on=day_from(PACK_TODAY, entry.roasted),
            shipped_on=day_from(PACK_TODAY, entry.shipped),
            delivered_on=day_from(PACK_TODAY, entry.delivered),
            carrier=entry.carrier,
            tracking_number=entry.tracking_number,
            items=[line.model_dump() for line in entry.items],
            shipping_czk=Decimal(entry.shipping_czk),
            total_czk=Decimal(entry.total_czk),
        )
        return describe_order(order)


def ticket_input(case: GoldenCase) -> str:
    """Return the ticket as the prompt receives it: redacted, with marker-like text removed."""
    return TICKET_MARKER.sub(" ", redact(case.ticket).text)


def classifier_difficulty(case: GoldenCase) -> str:
    """Rate a classifier case: Czech tickets and escalations are hard, two acceptable categories medium."""
    if case.language == "cs" or case.expect.route == "escalated":
        return "hard"
    if isinstance(case.expect.category, list):
        return "medium"
    return "easy"


def classifier_graders(case: GoldenCase) -> list[dict[str, Any]]:
    """Write the rules for one classifier case from what the golden set expects of the classification."""
    graders: list[dict[str, Any]] = []
    accepted = [str(category) for category in case.expect.accepted_categories()]
    if len(accepted) == 1:
        graders.append({"kind": "json_field_equals", "path": "category", "expected": accepted[0]})
    elif accepted:
        graders.append({"kind": "json_field_one_of", "path": "category", "options": accepted})
    graders.append({"kind": "json_field_equals", "path": "order_number", "expected": case.expect.order or None})
    if case.expect.reason == Ticket.EscalationReason.SENIOR_AGENT:
        graders.append({"kind": "json_field_one_of", "path": "senior_agent", "options": SENIOR_MATTERS})
    else:
        graders.append({"kind": "json_field_equals", "path": "senior_agent", "expected": None})
    return graders


def classifier_case(case: GoldenCase) -> dict[str, Any]:
    """Write one golden ticket as a classifier case."""
    return {
        "id": case.id,
        "difficulty": classifier_difficulty(case),
        "inputs": {"ticket": ticket_input(case)},
        "expected": {
            "category": [str(category) for category in case.expect.accepted_categories()],
            "order_number": case.expect.order or None,
            "reason": str(case.expect.reason) if case.expect.reason else None,
        },
        "graders": classifier_graders(case),
    }


def classifier_cases(golden: GoldenSet) -> list[GoldenCase]:
    """Return the cases the classifier sees: every ticket the injection screen lets through."""
    return [case for case in golden.cases if case.expect.reason != Ticket.EscalationReason.INJECTION]


def build_classifier_pack(golden: GoldenSet) -> dict[str, Any]:
    """Build the classifier's pack."""
    return {
        "pack": CLASSIFIER_PACK,
        "system": "lb-01",
        "target": {
            "name": "LB-01 ticket classifier",
            "description": (
                "Names a support ticket's category, its order number, whether a senior agent must take it, "
                "and an English search query for the policies."
            ),
            "source": "services/django-systems/lb01/prompts.py",
            "alias": CLASSIFY_ALIAS,
            "model_class": "fast",
            "max_output_tokens": CLASSIFY_MAX_TOKENS,
            "output": "json",
        },
        "prompt": {"system": CLASSIFY_SYSTEM, "user": CLASSIFY_USER_TEMPLATE},
        "variables": [],
        "common_graders": [{"kind": "json_schema", "schema": Classification.model_json_schema()}],
        "cases": [classifier_case(case) for case in classifier_cases(golden)],
    }


def draft_sources(case: GoldenCase, facts: SeedFacts) -> list[Source]:
    """Materialise the sources a draft may cite: the passages the golden set expects, then the order's facts."""
    sources = [Source(f"passage:{key}", passage_text(facts.passages[key], case.language)) for key in case.expect.cites]
    if case.expect.order:
        sources.append(Source(f"order:{case.expect.order}", facts.order_facts(case.expect.order, case.customer)))
    return sources


def listed_sources(sources: list[Source]) -> str:
    """Write the sources as the drafter's message lists them, one `[id] text` line each."""
    return "\n".join(f"[{source.id}] {source.text}" for source in sources) or "(no sources were found)"


def drafter_difficulty(case: GoldenCase) -> str:
    """Rate a drafter case: Czech and forbidden text are hard, an order that isn't the customer's medium."""
    if case.language == "cs" or case.expect.never:
        return "hard"
    if case.expect.order_found is False:
        return "medium"
    return "easy"


def drafter_graders(case: GoldenCase) -> list[dict[str, Any]]:
    """Write the rules for one drafter case: every expected passage cited, and no forbidden text."""
    graders: list[dict[str, Any]] = []
    if case.expect.cites:
        ids = [f"passage:{key}" for key in case.expect.cites]
        graders.append({"kind": "citation_present", "path": "sentences.*.sources", "ids": ids})
    if case.expect.never:
        graders.append({"kind": "contains_none", "values": list(case.expect.never)})
    return graders


def drafter_case(case: GoldenCase, facts: SeedFacts) -> dict[str, Any]:
    """Write one golden ticket as a drafter case, with its sources materialised."""
    sources = draft_sources(case, facts)
    return {
        "id": case.id,
        "difficulty": drafter_difficulty(case),
        "inputs": {
            "ticket": ticket_input(case),
            "customer_name": facts.customer_names[case.customer],
            "language": LANGUAGE_NAMES[case.language],
            "today": PACK_TODAY.isoformat(),
            "sources": listed_sources(sources),
        },
        "expected": {"cites": list(case.expect.cites), "never": list(case.expect.never)},
        "graders": drafter_graders(case),
    }


def drafter_cases(golden: GoldenSet) -> list[GoldenCase]:
    """Return the cases a draft is written for: the tickets that wait for a person's approval."""
    return [case for case in golden.cases if case.expect.route == "awaiting_approval"]


def build_drafter_pack(golden: GoldenSet, facts: SeedFacts) -> dict[str, Any]:
    """Build the drafter's pack."""
    return {
        "pack": DRAFTER_PACK,
        "system": "lb-01",
        "target": {
            "name": "LB-01 reply drafter",
            "description": (
                "Drafts the reply to a support ticket sentence by sentence, each citing a policy passage or "
                "the order's facts, in the customer's language, for a person to approve."
            ),
            "source": "services/django-systems/lb01/prompts.py",
            "alias": DRAFT_ALIAS,
            "model_class": "tools",
            "max_output_tokens": DRAFT_MAX_TOKENS,
            "output": "json",
        },
        "prompt": {"system": from_format_string(DRAFT_SYSTEM), "user": DRAFT_USER_TEMPLATE},
        "variables": ["language"],
        "common_graders": [
            {"kind": "json_schema", "schema": DraftAnswer.model_json_schema()},
            {"kind": "json_field_equals", "path": "answerable", "expected": True},
        ],
        "cases": [drafter_case(case, facts) for case in drafter_cases(golden)],
    }


def check_classifier_matches_production(pack: dict[str, Any], golden: GoldenSet) -> None:
    """Refuse a classifier pack whose filled-in templates differ from `classify_messages` for any case."""
    cases_by_id = {case["id"]: case for case in pack["cases"]}
    for case in classifier_cases(golden):
        inputs = cases_by_id[case.id]["inputs"]
        rendered = [render(pack["prompt"]["system"], inputs), render(pack["prompt"]["user"], inputs)]
        expected = [message.content for message in classify_messages(redact(case.ticket).text)]
        require_same(rendered, expected, case.id)


def check_drafter_matches_production(pack: dict[str, Any], golden: GoldenSet, facts: SeedFacts) -> None:
    """Refuse a drafter pack whose filled-in templates differ from `draft_messages` for any case."""
    cases_by_id = {case["id"]: case for case in pack["cases"]}
    for case in drafter_cases(golden):
        inputs = cases_by_id[case.id]["inputs"]
        rendered = [render(pack["prompt"]["system"], inputs), render(pack["prompt"]["user"], inputs)]
        messages = draft_messages(
            redact(case.ticket).text,
            facts.customer_names[case.customer],
            case.language,
            PACK_TODAY,
            draft_sources(case, facts),
        )
        require_same(rendered, [message.content for message in messages], case.id)


def export_packs(seed_directory: Path, golden_path: Path | None = None) -> dict[str, dict[str, Any]]:
    """Build both packs from the golden set and the seed files, each proven to match production, by pack name."""
    golden = read_golden_set(golden_path)
    facts = SeedFacts(seed_directory)
    classifier = build_classifier_pack(golden)
    check_classifier_matches_production(classifier, golden)
    drafter = build_drafter_pack(golden, facts)
    check_drafter_matches_production(drafter, golden, facts)
    return {CLASSIFIER_PACK: classifier, DRAFTER_PACK: drafter}
