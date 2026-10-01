"""LB-02's data, all in the lb02 schema.

What the roastery offers: rooms (resources), the offerings that run in them, and a
calendar of slots. What visitors make of it: conversations with the concierge and their
messages, the reservations those conversations hold and book, the mock confirmation each
booking records, and the handoffs to a person.

One table holds both holds and bookings. A hold is a reservation that expires after five
minutes, and confirming it turns it into a booking in place, so a single exclusion
constraint (`lb02_no_double_booking`) covers both: no two active reservations of one room
may overlap in time, whoever makes them and however often a tool is called.

Everything here is synthetic except what a visitor types into the chat, which is kept for
24 hours (`Conversation.expires_at`) and then swept away. The confirmation email is a
recorded mock and is never sent.
"""

import secrets
from datetime import datetime
from typing import Final
from zoneinfo import ZoneInfo

from django.contrib.postgres.constraints import ExclusionConstraint
from django.contrib.postgres.fields import ArrayField, DateTimeRangeField, RangeOperators
from django.core.validators import RegexValidator
from django.db import models
from django.db.models.functions import Length
from django.db.models.lookups import GreaterThanOrEqual, LessThanOrEqual
from django.utils import timezone

from lb02.limits import MAX_OPTIONS, MAX_PARTY_SIZE, MESSAGES_PER_SESSION, VISITOR_DATA_LIFETIME

# The roastery is in Prague: slot times, "tomorrow" and "this afternoon" all mean its clock.
ROASTERY_TIME_ZONE: Final = ZoneInfo("Europe/Prague")
# Letters and digits that can't be mistaken for each other when read out: booking codes.
CODE_ALPHABET: Final = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
# The longest a transcript line may be, in characters: a concierge reply is longer than a visitor message.
MAX_LINE_LENGTH: Final = 2_000

# Stable names such as `tasting` or `roastery-floor`.
key_validator = RegexValidator(
    r"^[a-z0-9]+(?:[.-][a-z0-9]+)*$", "Use lowercase letters and digits, joined by dots or hyphens."
)
# A language as the concierge records it: its two or three letter ISO 639 code, or none yet.
language_validator = RegexValidator(r"^(?:[a-z]{2,3})?$", "Use a two or three letter language code such as cs.")


class Resource(models.Model):
    """A room or station that hosts one session at a time, such as the Tasting Room.

    Bookings are scoped to a resource: two offerings in the same room can't overlap,
    while offerings in different rooms can.
    """

    key = models.CharField(max_length=40, unique=True, validators=[key_validator])
    name_en = models.CharField(max_length=80)
    name_cs = models.CharField(max_length=80)

    def __str__(self) -> str:
        """Name the resource by its key."""
        return self.key


class Offering(models.Model):
    """Something a visitor can book: a tasting, a cupping session, a roasting workshop."""

    key = models.CharField(max_length=40, unique=True, validators=[key_validator])
    resource = models.ForeignKey(Resource, on_delete=models.PROTECT, related_name="offerings")
    # Where the offering comes in the list the concierge reads out, from 1.
    position = models.PositiveSmallIntegerField()
    title_en = models.CharField(max_length=80)
    title_cs = models.CharField(max_length=80)
    summary_en = models.CharField(max_length=300)
    summary_cs = models.CharField(max_length=300)
    duration_minutes = models.PositiveSmallIntegerField()
    # The most guests one session takes, which is also the most one booking may have.
    capacity = models.PositiveSmallIntegerField()
    price_czk = models.PositiveIntegerField(help_text="Per guest, in whole crowns.")

    class Meta:
        """Offerings in the order the seed lists them, and no offering the room or the clock can't hold."""

        ordering = ("position",)
        constraints = (
            models.CheckConstraint(
                condition=models.Q(duration_minutes__gte=15, duration_minutes__lte=480),
                name="lb02_offering_duration",
            ),
            models.CheckConstraint(
                condition=models.Q(capacity__gte=1, capacity__lte=MAX_PARTY_SIZE),
                name="lb02_offering_capacity",
            ),
        )

    def __str__(self) -> str:
        """Name the offering by its key."""
        return self.key

    def title(self, language: str) -> str:
        """Return the title in Czech for a Czech visitor, and in English for everyone else."""
        return self.title_cs if language == "cs" else self.title_en

    def summary(self, language: str) -> str:
        """Return the one-line description in Czech for a Czech visitor, and in English for everyone else."""
        return self.summary_cs if language == "cs" else self.summary_en


class Slot(models.Model):
    """One session the roastery runs: an offering at a time, which a visitor can book.

    `during` is a half-open range, [start, end), so a session ending at 11:00 and the
    next one starting at 11:00 don't overlap. A slot has no status of its own: whether it
    is free, held or booked follows from the active reservations overlapping it.
    """

    offering = models.ForeignKey(Offering, on_delete=models.CASCADE, related_name="slots")
    during = DateTimeRangeField()

    class Meta:
        """Slots in time order, each offering once at a time, and every range bounded."""

        ordering = ("during",)
        constraints = (
            models.UniqueConstraint(fields=["offering", "during"], name="lb02_slot_once"),
            models.CheckConstraint(
                condition=models.Q(during__isempty=False, during__lower_inf=False, during__upper_inf=False),
                name="lb02_slot_range_is_bounded",
            ),
        )

    def __str__(self) -> str:
        """Name the slot by its offering and start."""
        return f"{self.offering.key} {self.starts_at:%Y-%m-%d %H:%M}"

    @property
    def starts_at(self) -> datetime:
        """When the session starts."""
        start: datetime = self.during.lower
        return start

    @property
    def ends_at(self) -> datetime:
        """When the session ends."""
        end: datetime = self.during.upper
        return end


def new_public_id() -> str:
    """Make the random ID a conversation is known by outside the service, so IDs can't be guessed."""
    return secrets.token_urlsafe(12)


def new_booking_code() -> str:
    """Make a booking code a visitor can read out, such as K7QW-39XD."""
    letters = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
    return f"{letters[:4]}-{letters[4:]}"


def visitor_data_expiry() -> datetime:
    """Return when a conversation started now must be deleted."""
    return timezone.now() + VISITOR_DATA_LIFETIME


class Conversation(models.Model):
    """A visitor's chat with the concierge, and everything it has collected so far.

    It belongs to the visitor's session, kept as a keyed hash, and nobody else can open
    it. Its `step` is where the booking stands, and it only ever follows from the facts
    here (lb02/states.py): the details collected, the live hold, the booking, the
    handoff. One conversation is one run of LB-02: every gateway call it makes carries
    its `run_id`, so the gateway's quotas and the Scope count the whole booking.
    """

    class Step(models.TextChoices):
        """Where the booking stands, in the order of the datasheet's chain."""

        DETAILS = "details", "Collecting details"
        AVAILABILITY = "availability", "Checking availability"
        HOLD = "hold", "A slot is held"
        DONE = "done", "Booked, with its confirmation recorded"
        HANDOFF = "handoff", "Handed to a person"

    class PartOfDay(models.TextChoices):
        """When in the day the visitor would like their session."""

        MORNING = "morning", "Morning, before 12:00"
        AFTERNOON = "afternoon", "Afternoon, 12:00 to 17:00"
        EVENING = "evening", "Evening, from 17:00"
        ANY = "any", "Any time"

    public_id = models.CharField(max_length=24, unique=True, default=new_public_id, editable=False)
    # A keyed hash of the visitor's signed session, never the session token itself.
    session_key = models.CharField(max_length=128, db_index=True)
    # The language the visitor writes in: a two or three letter code, empty until the first message.
    language = models.CharField(max_length=3, blank=True, validators=[language_validator])
    step = models.CharField(max_length=14, choices=Step.choices, default=Step.DETAILS)

    # What the visitor wants, collected by the concierge's update_details tool.
    offering = models.ForeignKey(Offering, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    party_size = models.PositiveSmallIntegerField(null=True, blank=True)
    guest_name = models.CharField(max_length=60, blank=True)
    # Read from the visitor's own words by the service, never by the model, and only an
    # example address is accepted (lb02/privacy.py): no real mailbox is ever stored.
    guest_email = models.EmailField(blank=True)

    # The last search, and the slots it put on offer, in the order they were numbered.
    search_from = models.DateField(null=True, blank=True)
    search_to = models.DateField(null=True, blank=True)
    search_part_of_day = models.CharField(max_length=10, choices=PartOfDay.choices, blank=True)
    offered_slots = ArrayField(models.BigIntegerField(), default=list, blank=True, size=MAX_OPTIONS)

    # Limits, counted as they are used.
    message_count = models.PositiveSmallIntegerField(default=0)
    model_calls = models.PositiveSmallIntegerField(default=0)
    injection_strikes = models.PositiveSmallIntegerField(default=0)
    failed_turns = models.PositiveSmallIntegerField(default=0)

    run_id = models.CharField(max_length=64, blank=True)
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)
    expires_at = models.DateTimeField(default=visitor_data_expiry, db_index=True)

    class Meta:
        """Newest conversations first, and no conversation past its message limit, whatever writes it."""

        ordering = ("-created_at",)
        constraints = (
            models.CheckConstraint(
                condition=models.Q(message_count__lte=MESSAGES_PER_SESSION),
                name="lb02_conversation_message_limit",
            ),
        )

    def __str__(self) -> str:
        """Name the conversation by its public ID."""
        return self.public_id

    def missing_details(self) -> list[str]:
        """List what the concierge still has to collect before it can look for a slot, in the order to ask."""
        missing: list[str] = []
        if self.offering_id is None:
            missing.append("offering")
        if self.party_size is None:
            missing.append("party_size")
        if not self.guest_name:
            missing.append("name")
        if not self.guest_email:
            missing.append("email")
        return missing


class Message(models.Model):
    """One line of a conversation's transcript: what the visitor wrote, what the concierge answered, what it did."""

    class Role(models.TextChoices):
        """Who a transcript line comes from. `action` is what a tool did, in words, for the person who takes over."""

        VISITOR = "visitor", "Visitor"
        CONCIERGE = "concierge", "Concierge"
        ACTION = "action", "Action"

    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name="messages")
    # The line's place in the transcript, from 1.
    position = models.PositiveIntegerField()
    role = models.CharField(max_length=10, choices=Role.choices)
    text = models.TextField(max_length=MAX_LINE_LENGTH)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        """Transcript order, each place used once, and no empty or oversized line."""

        ordering = ("position",)
        constraints = (
            models.UniqueConstraint(fields=["conversation", "position"], name="lb02_message_position_once"),
            models.CheckConstraint(
                condition=models.Q(
                    GreaterThanOrEqual(Length("text"), 1),
                    LessThanOrEqual(Length("text"), MAX_LINE_LENGTH),
                ),
                name="lb02_message_text_length",
            ),
        )

    def __str__(self) -> str:
        """Name the line by its conversation and place."""
        return f"{self.conversation_id}:{self.position}"


# The statuses in which a reservation keeps its room: the exclusion constraint's condition.
ACTIVE_STATUSES: Final = ("held", "booked")


class Reservation(models.Model):
    """A claim on a room for a time range: a hold for five minutes, then a booking once confirmed.

    The exclusion constraint makes two active reservations of one room overlapping in time
    impossible, so a double booking can't happen even if two visitors, or one model, ask
    for the same slot at the same moment. A hold past `hold_expires_at` no longer counts
    as active in any check (lb02/booking.py), whether or not the sweep has marked it
    expired yet. `during` and `resource` are copies of the slot's, kept here because a
    constraint can only see its own table.
    """

    class Status(models.TextChoices):
        """Where a reservation stands. Only `held` and `booked` keep the room."""

        HELD = "held", "Held for five minutes"
        BOOKED = "booked", "Booked"
        RELEASED = "released", "Released, or replaced by another hold"
        EXPIRED = "expired", "The hold ran out"

    code = models.CharField(max_length=9, unique=True, default=new_booking_code, editable=False)
    slot = models.ForeignKey(Slot, on_delete=models.PROTECT, related_name="reservations")
    resource = models.ForeignKey(Resource, on_delete=models.PROTECT, related_name="reservations")
    during = DateTimeRangeField()
    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name="reservations")
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.HELD)
    party_size = models.PositiveSmallIntegerField()
    guest_name = models.CharField(max_length=60)
    hold_expires_at = models.DateTimeField()
    # Names one confirm request, so repeating it returns the same booking instead of a second one.
    idempotency_key = models.CharField(max_length=64, blank=True)
    confirmed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField()

    class Meta:
        """Newest first. The constraints are the database's own word on what may be booked."""

        ordering = ("-created_at",)
        constraints = (
            ExclusionConstraint(
                name="lb02_no_double_booking",
                expressions=[("resource", RangeOperators.EQUAL), ("during", RangeOperators.OVERLAPS)],
                condition=models.Q(status__in=ACTIVE_STATUSES),
            ),
            models.UniqueConstraint(
                fields=["conversation"], condition=models.Q(status="held"), name="lb02_one_hold_per_conversation"
            ),
            models.UniqueConstraint(
                fields=["conversation"], condition=models.Q(status="booked"), name="lb02_one_booking_per_conversation"
            ),
            models.UniqueConstraint(
                fields=["conversation", "idempotency_key"],
                condition=~models.Q(idempotency_key=""),
                name="lb02_one_confirm_per_key",
            ),
            models.CheckConstraint(
                condition=models.Q(during__isempty=False, during__lower_inf=False, during__upper_inf=False),
                name="lb02_reservation_range_is_bounded",
            ),
            models.CheckConstraint(
                condition=models.Q(party_size__gte=1, party_size__lte=MAX_PARTY_SIZE),
                name="lb02_reservation_party_size",
            ),
            models.CheckConstraint(
                condition=~models.Q(status="booked")
                | (models.Q(confirmed_at__isnull=False) & ~models.Q(idempotency_key="")),
                name="lb02_booked_is_confirmed",
            ),
        )

    def __str__(self) -> str:
        """Name the reservation by its booking code."""
        return self.code


class Confirmation(models.Model):
    """The confirmation email of a booking, recorded and never sent.

    The page shows it as what would have been sent. `delivery` can only ever be `mock`:
    the database refuses anything else, so no bug can mark a message as delivered.
    """

    class Delivery(models.TextChoices):
        """How the message was delivered: it never is."""

        MOCK = "mock", "Recorded, never sent"

    reservation = models.OneToOneField(Reservation, on_delete=models.CASCADE, related_name="confirmation")
    to_address = models.EmailField()
    subject = models.CharField(max_length=200)
    body = models.TextField(max_length=2_000)
    language = models.CharField(max_length=3, validators=[language_validator])
    delivery = models.CharField(max_length=4, choices=Delivery.choices, default=Delivery.MOCK)
    recorded_at = models.DateTimeField()

    class Meta:
        """Only a mock confirmation can be stored."""

        constraints = (models.CheckConstraint(condition=models.Q(delivery="mock"), name="lb02_confirmation_is_a_mock"),)

    def __str__(self) -> str:
        """Name the confirmation by its booking code."""
        return f"confirmation for {self.reservation_id}"


class Handoff(models.Model):
    """A conversation handed to a person, with the whole transcript and what was collected.

    The transcript is copied here when the handoff happens, so the person gets the case
    exactly as it stood, in one piece.
    """

    class Reason(models.TextChoices):
        """Why the concierge stopped and handed the conversation over."""

        ASKED_FOR_PERSON = "asked_for_person", "The visitor asked for a person"
        OUT_OF_SCOPE = "out_of_scope", "The request isn't a booking the concierge can make"
        CANNOT_HELP = "cannot_help", "The concierge couldn't help, for example with a group above capacity"
        MESSAGE_LIMIT = "message_limit", "The conversation reached its message limit"
        BUDGET = "budget", "The conversation used its model-call budget"
        UNAVAILABLE = "unavailable", "The models or their quota weren't available"
        UNCHECKED = "unchecked", "The injection screen couldn't check the visitor's messages"
        ABUSE = "abuse", "The injection screen flagged the visitor's messages again and again"

    conversation = models.OneToOneField(Conversation, on_delete=models.CASCADE, related_name="handoff")
    reason = models.CharField(max_length=20, choices=Reason.choices)
    # What the concierge had collected, in a line or two, so the person needn't ask again.
    summary = models.TextField(max_length=1_000)
    # Every line of the conversation, as {"position", "role", "text", "at"} items.
    transcript = models.JSONField()
    created_at = models.DateTimeField()

    def __str__(self) -> str:
        """Name the handoff by its conversation."""
        return f"handoff of {self.conversation_id}"
