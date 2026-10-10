"""LB-01's data, all in the lb01 schema.

Policies to cite, synthetic customers and orders, and the tickets visitors file with
the drafts and decisions that answer them.

Everything here is synthetic except what a visitor types into a ticket, which is kept
for 24 hours (`Ticket.expires_at`) and then swept away.
"""

import secrets
from datetime import datetime, timedelta
from typing import Final

from django.contrib.postgres.indexes import GinIndex
from django.contrib.postgres.search import SearchVector, SearchVectorField
from django.core.validators import RegexValidator
from django.db import models
from django.db.models.functions import Length
from django.db.models.lookups import GreaterThanOrEqual, LessThanOrEqual
from django.utils import timezone
from pgvector.django import VectorField

# bge-m3, the model behind lb-embed, returns vectors of this many dimensions.
EMBEDDING_DIMENSIONS: Final = 1024
# How long a visitor's ticket, draft and decision are kept (the LB-01 datasheet).
VISITOR_DATA_LIFETIME = timedelta(hours=24)
# The longest ticket a visitor may file, in characters.
MAX_TICKET_LENGTH = 2_000

# Stable names such as `returns.withdrawal` or `cus-0001`.
key_validator = RegexValidator(
    r"^[a-z0-9]+(?:[.-][a-z0-9]+)*$", "Use lowercase letters and digits, joined by dots or hyphens."
)
# Order numbers such as BB-1042.
order_number_validator = RegexValidator(r"^BB-\d{4}$", "Order numbers look like BB-1042.")
# Two-letter country codes such as CZ, for where an order ships.
country_validator = RegexValidator(r"^[A-Z]{2}$", "Use a two-letter country code such as CZ.")


class Language(models.TextChoices):
    """The languages the site, the policies and the replies come in."""

    ENGLISH = "en", "English"
    CZECH = "cs", "Czech"


class Policy(models.Model):
    """One of Basalt & Bean's customer policies, such as Shipping and delivery."""

    key = models.CharField(max_length=40, unique=True, validators=[key_validator])
    title_en = models.CharField(max_length=80)
    title_cs = models.CharField(max_length=80)
    # Where the policy comes in the list of policies, from 1.
    position = models.PositiveSmallIntegerField()

    class Meta:
        """Policies in the order the seed file lists them."""

        ordering = ("position",)
        verbose_name_plural = "policies"

    def __str__(self) -> str:
        """Name the policy by its key."""
        return self.key


class PolicyPassage(models.Model):
    """One citable passage of a policy, in English and in Czech.

    Drafts cite a passage by its `key`, so a citation keeps pointing at the same rule
    across reseeds. Search runs on the English text, which the generated `search`
    column indexes; the Czech text is what a Czech visitor reads.
    """

    key = models.CharField(max_length=80, unique=True, validators=[key_validator])
    policy = models.ForeignKey(Policy, on_delete=models.CASCADE, related_name="passages")
    # The passage's number within its policy, from 1, shown as §1, §2 and so on.
    position = models.PositiveSmallIntegerField()
    title_en = models.CharField(max_length=120)
    title_cs = models.CharField(max_length=120)
    text_en = models.TextField(max_length=1_200)
    text_cs = models.TextField(max_length=1_200)
    search = models.GeneratedField(
        expression=SearchVector("title_en", weight="A", config="english")
        + SearchVector("text_en", weight="B", config="english"),
        output_field=SearchVectorField(),
        db_persist=True,
    )
    # Empty until the corpus is embedded; search then runs on keywords alone. No index:
    # the corpus is a few dozen passages, which an exact scan ranks in well under a
    # millisecond. An approximate index (HNSW) hands back a fixed number of candidates
    # before Postgres drops the row versions a reseed or `just embed` left behind, so it
    # loses passages that are there.
    embedding = VectorField(dimensions=EMBEDDING_DIMENSIONS, null=True, blank=True)

    class Meta:
        """Passages in policy order, with the full-text index keyword search reads."""

        ordering = ("policy__position", "position")
        indexes = (GinIndex(fields=["search"], name="lb01_passage_search"),)

    def __str__(self) -> str:
        """Name the passage by its key."""
        return self.key


class Customer(models.Model):
    """A synthetic Basalt & Bean customer. No real person is ever stored here."""

    key = models.CharField(max_length=40, unique=True, validators=[key_validator])
    name = models.CharField(max_length=120)
    email = models.EmailField()
    language = models.CharField(max_length=2, choices=Language.choices)

    def __str__(self) -> str:
        """Name the customer by their key."""
        return self.key


class Order(models.Model):
    """A synthetic order, as the order-lookup tool reports it to a draft."""

    class Status(models.TextChoices):
        """Where an order is between the roaster and the customer."""

        PROCESSING = "processing", "Processing"
        ROASTED = "roasted", "Roasted, waiting for the carrier"
        SHIPPED = "shipped", "Shipped"
        DELIVERED = "delivered", "Delivered"
        LOST = "lost", "Lost by the carrier"
        CANCELLED = "cancelled", "Cancelled"

    number = models.CharField(max_length=7, unique=True, validators=[order_number_validator])
    customer = models.ForeignKey(Customer, on_delete=models.PROTECT, related_name="orders")
    status = models.CharField(max_length=12, choices=Status.choices)
    # Where the order ships, which sets its delivery time and cost.
    country = models.CharField(max_length=2, default="CZ", validators=[country_validator])
    placed_on = models.DateField()
    roasted_on = models.DateField(null=True, blank=True)
    shipped_on = models.DateField(null=True, blank=True)
    delivered_on = models.DateField(null=True, blank=True)
    carrier = models.CharField(max_length=40, blank=True)
    tracking_number = models.CharField(max_length=40, blank=True)
    # The order lines, in the shape lb01.seed checks: coffee with its grind and bag size,
    # or equipment, each with a quantity and a unit price.
    items = models.JSONField()
    shipping_czk = models.DecimalField(max_digits=9, decimal_places=2)
    total_czk = models.DecimalField(max_digits=9, decimal_places=2)

    def __str__(self) -> str:
        """Name the order by its number."""
        return self.number


def new_public_id() -> str:
    """Make the random ID a ticket is known by outside the service, so IDs can't be guessed."""
    return secrets.token_urlsafe(12)


def visitor_data_expiry() -> datetime:
    """Return when a ticket filed now must be deleted."""
    return timezone.now() + VISITOR_DATA_LIFETIME


class Ticket(models.Model):
    """A customer's message to support, and how far the pipeline has got with it.

    The visitor files it as one of the synthetic customers, and the order-lookup tool
    sees only that customer's orders. A ticket belongs to the visitor's session, kept
    as a keyed hash, and expires after 24 hours. A ticket filed from a curated sample
    carries the sample's key, and its recorded result is replayed instead of run.
    """

    class Status(models.TextChoices):
        """The ticket's place in the pipeline, then at the agent console."""

        RECEIVED = "received", "Received"
        PROCESSING = "processing", "Processing"
        AWAITING_APPROVAL = "awaiting_approval", "Waiting for a person to approve the draft"
        ESCALATED = "escalated", "Escalated to a senior agent"
        SENT = "sent", "Reply sent"
        FAILED = "failed", "The pipeline couldn't finish"

    class Category(models.TextChoices):
        """What the ticket is about, as the classifier reads it. How it is handled is the route's business."""

        DAMAGED = "damaged", "Damaged, stale or faulty item"
        LATE = "late", "Late or lost delivery"
        WRONG_ITEM = "wrong_item", "Wrong or missing item"
        RETURN = "return", "Return or refund"
        SUBSCRIPTION = "subscription", "Subscription question or change"
        ORDER_CHANGE = "order_change", "Change or cancel an order"
        PRODUCT = "product", "Product question"
        OTHER = "other", "Something else"

    class EscalationReason(models.TextChoices):
        """Why the pipeline handed a ticket to a person without drafting a reply."""

        INJECTION = "injection", "The injection screen flagged the ticket"
        UNCHECKED = "unchecked", "The injection screen couldn't check the ticket"
        SENIOR_AGENT = "senior_agent", "A senior agent's matter: a legal claim, an allergy, fraud or personal data"
        NO_POLICY = "no_policy", "No policy passage covers the question"
        PIPELINE_ERROR = "pipeline_error", "A step failed, so a person takes over"

    public_id = models.CharField(max_length=24, unique=True, default=new_public_id, editable=False)
    # A keyed hash of the visitor's signed session, never the session token itself.
    session_key = models.CharField(max_length=64, db_index=True)
    customer = models.ForeignKey(Customer, on_delete=models.PROTECT, related_name="tickets")
    sample_key = models.CharField(max_length=40, blank=True, validators=[key_validator])
    # The language the visitor uses the site in, which the reply is written in.
    language = models.CharField(max_length=2, choices=Language.choices)
    body = models.TextField(max_length=MAX_TICKET_LENGTH)
    redacted_body = models.TextField(blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.RECEIVED)
    category = models.CharField(max_length=20, choices=Category.choices, blank=True)
    order_number = models.CharField(max_length=7, blank=True, validators=[order_number_validator])
    escalation_reason = models.CharField(max_length=20, choices=EscalationReason.choices, blank=True)
    run_id = models.CharField(max_length=64, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    expires_at = models.DateTimeField(default=visitor_data_expiry, db_index=True)

    class Meta:
        """Newest tickets first, and never an empty or oversized ticket, whatever writes it."""

        ordering = ("-created_at",)
        constraints = (
            models.CheckConstraint(
                condition=models.Q(
                    GreaterThanOrEqual(Length("body"), 1),
                    LessThanOrEqual(Length("body"), MAX_TICKET_LENGTH),
                ),
                name="lb01_ticket_body_length",
            ),
        )

    def __str__(self) -> str:
        """Name the ticket by its public ID."""
        return self.public_id


class Draft(models.Model):
    """The reply the pipeline drafted for a ticket, sentence by sentence, with each sentence's sources.

    `sentences` holds `{"text": ..., "citations": ["passage:<key>", "order:BB-1042"]}` items.
    A draft could go out on its own only when every sentence passes the claim check
    (`claims_supported`); for visitors, a person approves every draft anyway.
    """

    ticket = models.OneToOneField(Ticket, on_delete=models.CASCADE, related_name="draft")
    sentences = models.JSONField()
    claims_supported = models.BooleanField()
    # The sentences the claim check failed, as {"sentence": index, "reason": ...} items.
    unsupported = models.JSONField(default=list)
    model = models.CharField(max_length=120, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def text(self) -> str:
        """Return the reply as one paragraph, without its citation marks."""
        return " ".join(str(sentence["text"]) for sentence in self.sentences)


class Decision(models.Model):
    """What the person at the agent console did with a draft: approve, edit or escalate it."""

    class Action(models.TextChoices):
        """The three things a person can do with a draft."""

        APPROVE = "approve", "Approve"
        EDIT = "edit", "Edit, then send"
        ESCALATE = "escalate", "Escalate"

    ticket = models.OneToOneField(Ticket, on_delete=models.CASCADE, related_name="decision")
    action = models.CharField(max_length=10, choices=Action.choices)
    # The reply as sent: the draft for an approval, the person's text for an edit.
    final_text = models.TextField(blank=True, max_length=MAX_TICKET_LENGTH)
    decided_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        """A sent reply always has text; an escalation sends nothing."""

        constraints = (
            models.CheckConstraint(
                condition=models.Q(action="escalate", final_text="")
                | (~models.Q(action="escalate") & ~models.Q(final_text="")),
                name="lb01_decision_text_when_sent",
            ),
        )
