"""Handing a conversation to a person, with the whole transcript and what the concierge had collected.

A handoff ends the concierge's part. The conversation's hold, if it has one, is released, so no
slot stays locked behind a conversation nobody is in. The person receives a case file in one
piece: why it was handed over, what the visitor had said they wanted, and every line of the
transcript, which is the masked text the model read (lb02/privacy.py), with the concierge's
own lines and a line for each thing it did.

A conversation is handed over once. Handing it over again changes nothing.
"""

from datetime import datetime

from django.db import transaction

from lb02.booking import DATABASE, BookingService
from lb02.conversations import details_summary, transcript_json
from lb02.models import Conversation, Handoff


def hand_over(conversation: Conversation, reason: str, bookings: BookingService, now: datetime) -> Handoff:
    """Pass the conversation to a person: release its hold, write the case file and move it to the handoff step."""
    with transaction.atomic(using=DATABASE):
        bookings.release_hold(conversation)
        handoff, _ = Handoff.objects.get_or_create(
            conversation=conversation,
            defaults={
                "reason": reason,
                "summary": details_summary(conversation),
                "transcript": transcript_json(conversation),
                "created_at": now,
            },
        )
        conversation.step = Conversation.Step.HANDOFF
        conversation.save(update_fields=["step", "updated_at"])
    return handoff


def refresh_transcript(conversation: Conversation) -> None:
    """Bring a handoff's transcript up to date, so it includes the concierge's last words about the handoff."""
    Handoff.objects.filter(conversation=conversation).update(transcript=transcript_json(conversation))
