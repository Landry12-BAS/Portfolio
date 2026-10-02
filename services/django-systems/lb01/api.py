"""LB-01's API, which the site calls on a visitor's behalf: file tickets, read cited drafts, decide.

Every route needs a visitor token for lb-01 (core/visitors.py), and a visitor sees only
the tickets of their own session: anyone else's ticket is simply not found. Filing a
ticket queues it for the worker and answers at once, and the site polls the ticket
until its draft is ready. A visitor may file 20 tickets a day, and their tickets are
deleted 24 hours after they were filed (the LB-01 datasheet).
"""

from datetime import datetime
from functools import partial
from typing import Annotated, Literal, Self

from django.db import transaction
from django.db.models import QuerySet
from django.http import HttpRequest
from django.utils import timezone
from ninja import Router, Schema, Status
from ninja.errors import AuthenticationError
from pydantic import StringConstraints, model_validator

from core.data_files import Key
from core.locks import lock_visitor
from core.visitors import Visitor, VisitorBearer
from lb01.claims import ClaimProblem, ProblemCode, describe_problem
from lb01.models import MAX_TICKET_LENGTH, Customer, Decision, Draft, PolicyPassage, Ticket
from lb01.orders import look_up_order
from lb01.tasks import run_ticket
from lb_common.run import new_run_id

# How many tickets one visitor may file in a day (the LB-01 datasheet).
TICKETS_PER_DAY = 20
# How many of a visitor's tickets the queue shows, newest first.
QUEUE_LENGTH = 50

router = Router(auth=VisitorBearer("lb-01"), tags=["LB-01 Support Desk"])

# A ticket or reply as a visitor writes it: trimmed, never empty, never longer than a ticket.
VisitorText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_TICKET_LENGTH)]


class ErrorDetail(Schema):
    """What went wrong, as a stable code and a sentence for people."""

    code: str
    message: str


class ErrorOut(Schema):
    """The error shape the whole platform answers with."""

    error: ErrorDetail


class CustomerOut(Schema):
    """A synthetic customer a visitor can file a ticket as."""

    key: str
    name: str
    language: str


class TicketIn(Schema):
    """A new ticket: who files it, in which language the reply should be, and what it says."""

    customer: Key
    language: Literal["en", "cs"]
    body: VisitorText


class DecisionIn(Schema):
    """What the person at the agent console does with a draft. Only an edit carries its own text."""

    action: Literal["approve", "edit", "escalate"]
    text: VisitorText | None = None

    @model_validator(mode="after")
    def _check_text(self) -> Self:
        """Require the new text for an edit, and refuse text for anything else."""
        if self.action == "edit" and self.text is None:
            raise ValueError("an edit needs the reply's new text")
        if self.action != "edit" and self.text is not None:
            raise ValueError("only an edit carries text")
        return self


class SourceOut(Schema):
    """A source a draft cites: a policy passage, or what the order tool reported, in the ticket's language."""

    id: str
    title: str
    text: str


class SentenceOut(Schema):
    """One sentence of a draft, its citations, and why the claim check failed it, if it did."""

    text: str
    citations: list[str]
    supported: bool
    problem: str | None


class DraftOut(Schema):
    """A cited draft waiting for, or past, a person's decision."""

    sentences: list[SentenceOut]
    claims_supported: bool
    model: str
    sources: list[SourceOut]


class DecisionOut(Schema):
    """What the person decided, and the reply that was sent, if any."""

    action: str
    final_text: str
    decided_at: datetime


class TicketSummary(Schema):
    """A ticket as the agent console's queue lists it."""

    id: str
    customer: CustomerOut
    language: str
    status: str
    category: str
    created_at: datetime


class TicketOut(TicketSummary):
    """A ticket in full: what the customer wrote, what the pipeline decided, the draft and the decision."""

    body: str
    order_number: str
    escalation_reason: str
    run_id: str
    expires_at: datetime
    draft: DraftOut | None
    decision: DecisionOut | None


class StatsOut(Schema):
    """The counters the demo shows as the visitor works.

    `deflection` is the share of decided tickets answered by the draft (approved or
    edited) rather than escalated; `accuracy` is the share of sent replies approved
    without an edit. Both are null until there is something to count.
    """

    tickets: int
    awaiting_approval: int
    sent: int
    sent_unedited: int
    escalated: int
    deflection: float | None
    accuracy: float | None


def error(code: str, message: str) -> ErrorOut:
    """Build an error answer in the platform's shape."""
    return ErrorOut(error=ErrorDetail(code=code, message=message))


def visitor_of(request: HttpRequest) -> Visitor:
    """Return the visitor the request's token vouched for."""
    visitor = getattr(request, "auth", None)
    if not isinstance(visitor, Visitor):
        raise AuthenticationError
    return visitor


def own_tickets(visitor: Visitor) -> QuerySet[Ticket]:
    """Return the visitor's own tickets, newest first; no other ticket is ever reachable."""
    return Ticket.objects.filter(session_key=visitor.session_key).select_related("customer")


@router.get("/customers", response=list[CustomerOut])
def list_customers(request: HttpRequest) -> list[CustomerOut]:
    """List the synthetic customers a visitor can file a ticket as."""
    visitor_of(request)
    return [customer_out(customer) for customer in Customer.objects.order_by("key")]


@router.post("/tickets", response={202: TicketOut, 404: ErrorOut, 429: ErrorOut})
def file_ticket(request: HttpRequest, payload: TicketIn) -> Status[TicketOut] | Status[ErrorOut]:
    """File a ticket as one of the synthetic customers, and queue it for the pipeline."""
    visitor = visitor_of(request)
    customer = Customer.objects.filter(key=payload.customer).first()
    if customer is None:
        return Status(404, error("unknown_customer", "There is no customer with that key."))
    with transaction.atomic(using="lb01"):
        # One visitor's tickets take turns, so the count below can't be raced past the limit.
        lock_visitor("lb01", "tickets", visitor.session_key)
        if filed_today(visitor) >= TICKETS_PER_DAY:
            return Status(429, error("daily_limit", f"A visitor may file {TICKETS_PER_DAY} tickets a day."))
        # The run's ID is known from the start, so the Scope can follow the run while it works.
        ticket = Ticket.objects.create(
            session_key=visitor.session_key,
            customer=customer,
            language=payload.language,
            body=payload.body,
            run_id=new_run_id(),
        )
        # The worker must never look for a ticket this transaction hasn't committed yet.
        transaction.on_commit(partial(run_ticket.delay, ticket.pk), using="lb01")
    return Status(202, ticket_out(ticket))


@router.get("/tickets", response=list[TicketSummary])
def list_tickets(request: HttpRequest) -> list[TicketSummary]:
    """List the visitor's own tickets, newest first, for the agent console's queue."""
    visitor = visitor_of(request)
    return [ticket_summary(ticket) for ticket in own_tickets(visitor)[:QUEUE_LENGTH]]


@router.get("/tickets/{ticket_id}", response={200: TicketOut, 404: ErrorOut})
def get_ticket(request: HttpRequest, ticket_id: str) -> Status[TicketOut] | Status[ErrorOut]:
    """Show one of the visitor's tickets in full, with its cited draft and the decision."""
    ticket = own_tickets(visitor_of(request)).filter(public_id=ticket_id).first()
    if ticket is None:
        return Status(404, error("not_found", "There is no such ticket."))
    return Status(200, ticket_out(ticket))


@router.post("/tickets/{ticket_id}/decision", response={200: TicketOut, 404: ErrorOut, 409: ErrorOut})
def decide(request: HttpRequest, ticket_id: str, payload: DecisionIn) -> Status[TicketOut] | Status[ErrorOut]:
    """Approve, edit or escalate a draft that waits for a person, once."""
    visitor = visitor_of(request)
    with transaction.atomic(using="lb01"):
        ticket = own_tickets(visitor).select_for_update(of=("self",)).filter(public_id=ticket_id).first()
        if ticket is None:
            return Status(404, error("not_found", "There is no such ticket."))
        draft = Draft.objects.filter(ticket=ticket).first()
        if ticket.status != Ticket.Status.AWAITING_APPROVAL or draft is None:
            return Status(409, error("not_waiting", "Only a draft waiting for approval can be decided."))
        Decision.objects.create(ticket=ticket, action=payload.action, final_text=reply_text(payload, draft))
        ticket.status = Ticket.Status.ESCALATED if payload.action == "escalate" else Ticket.Status.SENT
        ticket.save(update_fields=["status", "updated_at"])
    return Status(200, ticket_out(ticket))


@router.get("/stats", response=StatsOut)
def stats(request: HttpRequest) -> StatsOut:
    """Count the visitor's tickets and decisions, for the demo's deflection and accuracy counters."""
    tickets = own_tickets(visitor_of(request))
    decisions = Decision.objects.filter(ticket__in=tickets)
    approved = decisions.filter(action=Decision.Action.APPROVE).count()
    edited = decisions.filter(action=Decision.Action.EDIT).count()
    escalated_by_person = decisions.filter(action=Decision.Action.ESCALATE).count()
    sent = approved + edited
    decided = sent + escalated_by_person
    return StatsOut(
        tickets=tickets.count(),
        awaiting_approval=tickets.filter(status=Ticket.Status.AWAITING_APPROVAL).count(),
        sent=sent,
        sent_unedited=approved,
        escalated=tickets.filter(status=Ticket.Status.ESCALATED).count(),
        deflection=sent / decided if decided else None,
        accuracy=approved / sent if sent else None,
    )


def filed_today(visitor: Visitor) -> int:
    """Count the tickets the visitor filed since midnight, UTC."""
    midnight = timezone.now().replace(hour=0, minute=0, second=0, microsecond=0)
    return Ticket.objects.filter(session_key=visitor.session_key, created_at__gte=midnight).count()


def reply_text(decision: DecisionIn, draft: Draft) -> str:
    """Return the reply a decision sends: the draft for an approval, the person's text for an edit, none otherwise."""
    if decision.action == "approve":
        return draft.text()
    if decision.action == "edit" and decision.text is not None:
        return decision.text
    return ""


def customer_out(customer: Customer) -> CustomerOut:
    """Describe a synthetic customer."""
    return CustomerOut(key=customer.key, name=customer.name, language=customer.language)


def ticket_summary(ticket: Ticket) -> TicketSummary:
    """Describe a ticket for the queue."""
    return TicketSummary(
        id=ticket.public_id,
        customer=customer_out(ticket.customer),
        language=ticket.language,
        status=ticket.status,
        category=ticket.category,
        created_at=ticket.created_at,
    )


def ticket_out(ticket: Ticket) -> TicketOut:
    """Describe a ticket in full, with its draft and decision when it has them."""
    draft = Draft.objects.filter(ticket=ticket).first()
    decision = Decision.objects.filter(ticket=ticket).first()
    summary = ticket_summary(ticket)
    return TicketOut(
        **summary.model_dump(exclude={"customer"}),
        customer=summary.customer,
        body=ticket.body,
        order_number=ticket.order_number,
        escalation_reason=ticket.escalation_reason,
        run_id=ticket.run_id,
        expires_at=ticket.expires_at,
        draft=draft_out(draft, ticket) if draft is not None else None,
        decision=DecisionOut(action=decision.action, final_text=decision.final_text, decided_at=decision.decided_at)
        if decision is not None
        else None,
    )


def draft_out(draft: Draft, ticket: Ticket) -> DraftOut:
    """Describe a draft sentence by sentence, with every source it cites, in the ticket's language."""
    problems = {int(item["sentence"]): problem_text(item, ticket.language) for item in draft.unsupported}
    sentences = [
        SentenceOut(
            text=str(sentence["text"]),
            citations=[str(citation) for citation in sentence["citations"]],
            supported=index not in problems,
            problem=problems.get(index),
        )
        for index, sentence in enumerate(draft.sentences)
    ]
    cited = list(dict.fromkeys(citation for sentence in sentences for citation in sentence.citations))
    return DraftOut(
        sentences=sentences,
        claims_supported=draft.claims_supported,
        model=draft.model,
        sources=[source for citation in cited if (source := source_out(citation, ticket)) is not None],
    )


def problem_text(stored: dict[str, object], language: str) -> str:
    """Word a stored claim problem in the ticket's language; a row without a code keeps its English reason."""
    try:
        code = ProblemCode(str(stored["code"]))
    except (KeyError, ValueError):
        return str(stored.get("reason", ""))
    raw_items = stored.get("items", [])
    items = tuple(str(item) for item in raw_items) if isinstance(raw_items, list) else ()
    return describe_problem(ClaimProblem(code, items), language)


def source_out(citation: str, ticket: Ticket) -> SourceOut | None:
    """Describe one cited source: a passage in the ticket's language, or the order tool's report for its customer."""
    kind, _, key = citation.partition(":")
    if kind == "order":
        return SourceOut(id=citation, title=f"Order {key}", text=look_up_order(key, ticket.customer).facts)
    passage = PolicyPassage.objects.select_related("policy").filter(key=key).first()
    if kind != "passage" or passage is None:
        return None
    if ticket.language == "cs":
        title, text = f"{passage.policy.title_cs} §{passage.position}: {passage.title_cs}", passage.text_cs
    else:
        title, text = f"{passage.policy.title_en} §{passage.position}: {passage.title_en}", passage.text_en
    return SourceOut(id=citation, title=title, text=text)
