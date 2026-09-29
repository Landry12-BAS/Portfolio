"""LB-01's ticket pipeline: from a customer's ticket to a cited draft for a person to approve.

    redact PII -> screen for injection -> classify -> hybrid search -> rerank
    -> look up order -> draft with citations -> check claims -> route

One ticket is one run of LB-01. Each step is a span of the run's trace, and every model
call goes through the gateway labelled with the run, so the run's quotas apply and the
Scope shows the whole story. A run makes an injection check, a query embedding, a rerank
and at most three chat calls: classify, draft, and one repair of a malformed answer.

The pipeline hands a ticket to a person whenever it can't stand behind a draft: an
injection attempt, a ticket it couldn't screen, a senior agent's matter, a question no
policy answers, or a step that failed. Otherwise the draft waits for a person's
approval, with the sentences its sources don't support marked. Nothing is sent
automatically.
"""

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Protocol, Self

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from openai import OpenAIError
from redis import Redis

from core.structured import ChatModels, GatewayChat, StructuredAnswer, StructuredOutputError, ask_for_json
from lb01.claims import ClaimCheck, check_claims
from lb01.models import Customer, Draft, PolicyPassage, Ticket
from lb01.orders import OrderLookup, look_up_order
from lb01.prompts import Classification, DraftAnswer, Source, classify_messages, draft_messages
from lb01.redaction import Redaction, redact
from lb01.search import (
    RERANK_CANDIDATES,
    SearchModels,
    SearchResult,
    embed_query,
    finalists,
    hybrid_search,
    rerank_hits,
)
from lb_common.gateway import Gateway
from lb_common.run import DataClass, Run, new_run_id, run_scope
from lb_common.tracing import RedisSpanWriter, Tracer

# The virtual models each step asks: a fast one to classify, the strongest to draft.
CLASSIFY_ALIAS = "lb-fast"
DRAFT_ALIAS = "lb-tools"
# Output caps, which the gateway counts against its token budgets.
CLASSIFY_MAX_TOKENS = 300
DRAFT_MAX_TOKENS = 1_000
# An order number as a customer may write it: BB-1042, BB 1042 or bb1042.
ORDER_NUMBER_IN_TEXT = re.compile(r"\bBB[\s-]?(\d{4})\b", re.IGNORECASE)


class GuardVerdictLike(Protocol):
    """The parts of lb_common.gateway.GuardVerdict the pipeline reads."""

    @property
    def flagged(self) -> bool:
        """Whether the text looks like an injection attempt."""
        ...

    @property
    def score(self) -> float:
        """The classifier's highest injection probability across the text."""
        ...


class PipelineModels(SearchModels, Protocol):
    """The gateway calls the pipeline makes besides chat. lb_common.gateway.Gateway provides them all."""

    def guard(self, text: str) -> GuardVerdictLike:
        """Check a text for a prompt injection."""
        ...


@dataclass
class PipelineResult:
    """What one run of the pipeline found and decided, filled in step by step."""

    redaction: Redaction
    status: str = Ticket.Status.PROCESSING
    reason: str | None = None
    classification: Classification | None = None
    # The order number the classifier found, kept only when the ticket really names it.
    order_number: str | None = None
    search: SearchResult | None = None
    lookup: OrderLookup | None = None
    draft: DraftAnswer | None = None
    draft_model: str = ""
    claims: ClaimCheck | None = None

    def escalate(self, reason: str) -> Self:
        """Hand the ticket to a person, for `reason`."""
        self.status = Ticket.Status.ESCALATED
        self.reason = reason
        return self

    def await_approval(self) -> Self:
        """Leave the draft for a person to approve, edit or escalate."""
        self.status = Ticket.Status.AWAITING_APPROVAL
        return self


class TicketPipeline:
    """Runs tickets through every step, each ticket as one run of LB-01, and records the outcome."""

    def __init__(
        self,
        models: PipelineModels,
        chat: ChatModels,
        tracer: Tracer,
        today: Callable[[], date] = timezone.localdate,
    ) -> None:
        """Call the gateway through `models` and `chat`, record spans with `tracer`, and date drafts by `today`."""
        self.models = models
        self.chat = chat
        self.tracer = tracer
        self.today = today

    def run(self, ticket: Ticket, data_class: DataClass = "visitor") -> PipelineResult:
        """Run the pipeline on a ticket as one run of LB-01, then save the outcome on the ticket.

        A visitor's ticket runs on their session's quota; a curated sample or a golden
        case runs as synthetic data, which may use the synthetic-only providers.
        """
        ticket.run_id = ticket.run_id or new_run_id()
        session = ticket.session_key if data_class == "visitor" else None
        run = Run(system="lb-01", run_id=ticket.run_id, data_class=data_class, session=session)
        with run_scope(run), self.tracer.span("support ticket", kind="system.run", language=ticket.language) as span:
            result = self.work_through(ticket)
            span.set("status", result.status)
            if result.reason:
                span.set("reason", result.reason)
        save_result(ticket, result)
        return result

    def work_through(self, ticket: Ticket) -> PipelineResult:
        """Take the ticket through each step, stopping at the first one that hands it to a person."""
        result = PipelineResult(redaction=self.redact(ticket.body))
        try:
            screening = self.screen(result.redaction.text)
            if screening is not None:
                return self.route(result.escalate(screening))
            classification = self.classify(result.redaction.text)
            result.classification = classification
            result.order_number = order_in_ticket(classification.order_number, ticket.body)
            if classification.senior_agent is not None:
                return self.route(result.escalate(Ticket.EscalationReason.SENIOR_AGENT))
            result.search = self.search(classification.search_query)
            result.lookup = self.look_up(result.order_number, ticket.customer)
            sources = draft_sources(result.search, result.lookup, ticket.language)
            answer = self.draft(ticket, result.redaction.text, sources)
            result.draft, result.draft_model = answer.value, answer.model
            if not answer.value.answerable:
                return self.route(result.escalate(Ticket.EscalationReason.NO_POLICY))
            result.claims = self.check(answer.value, sources)
            return self.route(result.await_approval())
        except (OpenAIError, StructuredOutputError):
            return self.route(result.escalate(Ticket.EscalationReason.PIPELINE_ERROR))

    def redact(self, text: str) -> Redaction:
        """Replace the personal data in the ticket before any model reads it."""
        with self.tracer.span("redact PII") as span:
            redaction = redact(text)
            for label, count in redaction.found.items():
                span.set(f"found.{label}", count)
        return redaction

    def screen(self, text: str) -> str | None:
        """Check the ticket for a prompt injection, and return why it must go to a person, or None when clean.

        The screen fails closed: a ticket it couldn't check never reaches a model.
        """
        try:
            with self.tracer.span("screen for injection") as span:
                verdict = self.models.guard(text)
                span.set("flagged", verdict.flagged)
                span.set("score", round(verdict.score, 4))
        except OpenAIError:
            return Ticket.EscalationReason.UNCHECKED
        return Ticket.EscalationReason.INJECTION if verdict.flagged else None

    def classify(self, text: str) -> Classification:
        """Ask the classifier for the ticket's category, order number, senior-agent matter and search query."""
        with self.tracer.span("classify") as span:
            answer = ask_for_json(
                self.chat, CLASSIFY_ALIAS, classify_messages(text), Classification, CLASSIFY_MAX_TOKENS
            )
            span.set("category", str(answer.value.category))
            span.set("senior_agent", answer.value.senior_agent or "none")
            span.set("attempts", answer.attempts)
        return answer.value

    def search(self, query: str) -> SearchResult:
        """Search the policies by keywords and meaning, then let the reranker order the finalists."""
        with self.tracer.span("hybrid search") as span:
            found = hybrid_search(query, embed_query(query, self.models), limit=RERANK_CANDIDATES)
            span.set("candidates", len(found.hits))
            span.set("used_vectors", found.used_vectors)
        with self.tracer.span("rerank") as span:
            reranked = rerank_hits(query, found.hits, self.models)
            result = finalists(found, reranked)
            span.set("reranked", result.reranked)
            if result.hits and result.hits[0].relevance is not None:
                span.set("top_relevance", round(result.hits[0].relevance, 4))
        return result

    def look_up(self, number: str | None, customer: Customer) -> OrderLookup | None:
        """Look the ticket's order up on its own customer's account, when the ticket names one."""
        with self.tracer.span("look up order", kind="system.tool") as span:
            if number is None:
                span.skip("no order number")
                return None
            lookup = look_up_order(number, customer)
            span.set("found", lookup.found)
        return lookup

    def draft(self, ticket: Ticket, text: str, sources: Sequence[Source]) -> StructuredAnswer[DraftAnswer]:
        """Ask the drafter for a reply in the ticket's language, each sentence citing its sources."""
        with self.tracer.span("draft with citations") as span:
            messages = draft_messages(text, ticket.customer.name, ticket.language, self.today(), sources)
            answer = ask_for_json(self.chat, DRAFT_ALIAS, messages, DraftAnswer, DRAFT_MAX_TOKENS)
            span.set("answerable", answer.value.answerable)
            span.set("sentences", len(answer.value.sentences))
            span.set("attempts", answer.attempts)
        return answer

    def check(self, draft: DraftAnswer, sources: Sequence[Source]) -> ClaimCheck:
        """Hold every sentence of the draft to the sources it cites."""
        with self.tracer.span("check claims") as span:
            check = check_claims(draft.sentences, {source.id: source.text for source in sources})
            span.set("supported", check.supported)
            span.set("unsupported", len(check.unsupported))
        return check

    def route(self, result: PipelineResult) -> PipelineResult:
        """Record where the ticket goes: to a person with a draft, or to a person without one."""
        with self.tracer.span("route") as span:
            span.set("status", result.status)
            if result.reason:
                span.set("reason", result.reason)
        return result


def order_in_ticket(number: str | None, ticket_text: str) -> str | None:
    """Keep the classifier's order number only when the ticket names it, so a guessed number is never looked up."""
    named = {f"BB-{digits}" for digits in ORDER_NUMBER_IN_TEXT.findall(ticket_text)}
    return number if number in named else None


def draft_sources(search: SearchResult, lookup: OrderLookup | None, language: str) -> list[Source]:
    """Collect what the drafter may cite: the passages found, in the reply's language, and the order's facts."""
    passages = PolicyPassage.objects.select_related("policy").in_bulk(search.passage_keys(), field_name="key")
    sources = [
        Source(f"passage:{key}", passage_text(passages[key], language))
        for key in search.passage_keys()
        if key in passages
    ]
    if lookup is not None:
        sources.append(Source(lookup.source_id, lookup.facts))
    return sources


def passage_text(passage: PolicyPassage, language: str) -> str:
    """Write a passage as the drafter reads it: its policy, its title and its text, in one language."""
    if language == "cs":
        return f"{passage.policy.title_cs}, {passage.title_cs}: {passage.text_cs}"
    return f"{passage.policy.title_en}, {passage.title_en}: {passage.text_en}"


def save_result(ticket: Ticket, result: PipelineResult) -> None:
    """Record the run's outcome on the ticket, with its draft when it waits for approval, in one transaction."""
    ticket.redacted_body = result.redaction.text
    ticket.category = result.classification.category if result.classification else ""
    ticket.order_number = result.order_number or ""
    ticket.status = result.status
    ticket.escalation_reason = result.reason or ""
    with transaction.atomic(using="lb01"):
        ticket.save(
            update_fields=[
                "redacted_body",
                "category",
                "order_number",
                "status",
                "escalation_reason",
                "run_id",
                "updated_at",
            ]
        )
        if result.draft is not None and result.claims is not None and result.status == Ticket.Status.AWAITING_APPROVAL:
            Draft.objects.update_or_create(
                ticket=ticket,
                defaults={
                    "sentences": [
                        {"text": sentence.text, "citations": list(sentence.sources)}
                        for sentence in result.draft.sentences
                    ],
                    "claims_supported": result.claims.supported,
                    "unsupported": [
                        {"sentence": index, "reason": reason} for index, reason in result.claims.reasons.items()
                    ],
                    "model": result.draft_model[:120],
                },
            )


def connect_pipeline() -> TicketPipeline:
    """Build the pipeline the service runs: the gateway from the environment, and spans to Redis."""
    gateway = Gateway.from_env()
    writer = RedisSpanWriter(Redis.from_url(settings.REDIS_URL), prefix=settings.REDIS_PREFIX)
    return TicketPipeline(models=gateway, chat=GatewayChat(gateway), tracer=Tracer(writer))
