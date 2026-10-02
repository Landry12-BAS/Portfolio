"""The mechanics of a conversation: starting one, its transcript, its limits and its step.

None of it is conversation logic; that is the concierge's (lb02/concierge.py). These are the
database operations the concierge and the consumer both lean on, each small enough to test on
its own:

- A visitor may start 10 conversations a day, and a new one gets the run ID every gateway
  call it makes will carry.
- Limits are counted by the database, in one statement each, so two messages racing can't
  both take the last place: `spend_message` adds a message only while fewer than 30 have been
  counted, `spend_call` adds a gateway call only while the conversation is under its budget.
  The table also refuses a message count above 30 on its own.
- The transcript is a numbered list of lines, and a visitor's lines are stored masked
  (lb02/privacy.py): what a person who takes over reads is what the model read.
- The step follows from the facts (lb02/states.py), and `sync_step` brings the stored one in
  line after anything that could change it.
"""

from datetime import datetime
from typing import Any

from django.db import transaction
from django.db.models import F, Max

from core.locks import lock_visitor
from lb02.booking import DATABASE, BookingService
from lb02.limits import (
    CONVERSATIONS_PER_VISITOR_PER_DAY,
    MAX_MODEL_CALLS_PER_CONVERSATION,
    MESSAGES_PER_SESSION,
    VISITOR_DATA_LIFETIME,
)
from lb02.models import MAX_LINE_LENGTH, Conversation, Handoff, Message
from lb02.states import derive_step
from lb_common.run import new_run_id


class ConversationLimitError(Exception):
    """The visitor has started as many conversations today as they may."""


def start_conversation(session_key: str, now: datetime) -> Conversation:
    """Start a conversation for a visitor, or refuse when they have started their ten for the day.

    The count is of the conversations the visitor started since midnight UTC, and the new
    one carries its own run ID, so everything it makes the gateway do is one run. One visitor's
    starts take turns, so a visitor who opens many connections at once cannot count past the limit.
    """
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    with transaction.atomic(using=DATABASE):
        lock_visitor(DATABASE, "conversations", session_key)
        if Conversation.objects.filter(session_key=session_key, created_at__gte=midnight).count() >= (
            CONVERSATIONS_PER_VISITOR_PER_DAY
        ):
            raise ConversationLimitError(
                f"A visitor may start {CONVERSATIONS_PER_VISITOR_PER_DAY} conversations a day."
            )
        return Conversation.objects.create(
            session_key=session_key, run_id=new_run_id(), created_at=now, expires_at=now + VISITOR_DATA_LIFETIME
        )


def own_conversation(session_key: str, public_id: str) -> Conversation | None:
    """Find a visitor's own conversation by its public ID. Anyone else's is simply not found."""
    return Conversation.objects.select_related("offering").filter(session_key=session_key, public_id=public_id).first()


def record(conversation: Conversation, role: str, text: str, now: datetime) -> Message:
    """Add a line to the transcript, in the next place.

    The conversation's row is locked while the place is chosen, so two writers (a visitor with
    two tabs open) take turns instead of choosing the same one. The table's unique place is the
    backstop behind it.
    """
    with transaction.atomic(using=DATABASE):
        Conversation.objects.select_for_update().get(pk=conversation.pk)
        last = last_position(conversation)
        return Message.objects.create(
            conversation=conversation, position=last + 1, role=role, text=text[:MAX_LINE_LENGTH], created_at=now
        )


def last_position(conversation: Conversation) -> int:
    """Return the place of the transcript's last line, or 0 when nothing has been said."""
    return Message.objects.filter(conversation=conversation).aggregate(top=Max("position"))["top"] or 0


def transcript_pairs(conversation: Conversation) -> list[tuple[str, str]]:
    """Return the transcript as (role, text) pairs, oldest first."""
    return list(Message.objects.filter(conversation=conversation).values_list("role", "text"))


def transcript_json(conversation: Conversation) -> list[dict[str, Any]]:
    """Return the whole transcript as plain items, which is the form a handoff carries it in."""
    return [
        {"position": message.position, "role": message.role, "text": message.text, "at": message.created_at.isoformat()}
        for message in Message.objects.filter(conversation=conversation)
    ]


def spend_message(conversation: Conversation) -> bool:
    """Count one more visitor message, unless the conversation has used its 30; say whether it was counted.

    One statement does the checking and the counting, so two messages can't both take the last place.
    """
    counted = Conversation.objects.filter(pk=conversation.pk, message_count__lt=MESSAGES_PER_SESSION).update(
        message_count=F("message_count") + 1
    )
    if counted:
        conversation.message_count += 1
    return bool(counted)


def spend_call(conversation: Conversation) -> bool:
    """Count one more gateway call, unless the conversation has used its budget; say whether it was counted."""
    counted = Conversation.objects.filter(pk=conversation.pk, model_calls__lt=MAX_MODEL_CALLS_PER_CONVERSATION).update(
        model_calls=F("model_calls") + 1
    )
    if counted:
        conversation.model_calls += 1
    return bool(counted)


def language_of(conversation: Conversation) -> str:
    """Return the language to answer in: the conversation's own, or English before it has one."""
    return conversation.language or "en"


def messages_left(conversation: Conversation) -> int:
    """Return how many more visitor messages the conversation will take."""
    return max(0, MESSAGES_PER_SESSION - conversation.message_count)


def current_step(conversation: Conversation, bookings: BookingService) -> str:
    """Work the step out from the facts, without storing it."""
    return derive_step(
        details_complete=not conversation.missing_details(),
        has_live_hold=bookings.current_hold(conversation) is not None,
        has_booking=bookings.current_booking(conversation) is not None,
        handed_off=Handoff.objects.filter(conversation=conversation).exists(),
    )


def sync_step(conversation: Conversation, bookings: BookingService) -> str:
    """Work the step out from the facts, store it if it changed, and return it."""
    step = current_step(conversation, bookings)
    if conversation.step != step:
        conversation.step = step
        conversation.save(update_fields=["step", "updated_at"])
    return step


def details_summary(conversation: Conversation) -> str:
    """Say in a line or two what the concierge has collected, so a person who takes over needn't ask again."""
    parts = [
        f"offering: {conversation.offering.key if conversation.offering else 'not chosen'}",
        f"guests: {conversation.party_size if conversation.party_size is not None else 'not given'}",
        f"name: {conversation.guest_name or 'not given'}",
        f"contact: {conversation.guest_email or 'not given'}",
    ]
    if conversation.search_from:
        last = conversation.search_to or conversation.search_from
        window = f"{conversation.search_from.isoformat()} to {last.isoformat()}"
        parts.append(f"last search: {window}, {conversation.search_part_of_day or 'any time'}")
    parts.append(f"language: {conversation.language or 'unknown'}")
    return "; ".join(parts)
