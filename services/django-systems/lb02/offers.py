"""The slots on offer to a conversation, and the numbers they are held by.

A number is something the visitor and the model both lean on: "the second one", "option 3".
So a number must mean the same slot for the whole conversation, in every tab, however the
calendar moves between two messages. Numbering the current list from 1 on every search did
not: when another visitor took the first slot, every other slot moved up a place and a
"yes, that one" held a different slot from the one on the screen.

The rules are short:

- A slot gets its number the first time the conversation is shown it: the next one after the
  highest given so far. The numbers live on the conversation (`shown_slots`, where a slot's
  number is its place in the list), and they are never moved and never reused.
- What is on offer now (`offered_slots`) is what the latest search found. A slot that is no
  longer on offer keeps its number, retired: nothing can hold it, and the number never comes
  to mean anything else.
- Only a slot that is on offer can be held, whatever number is asked for.
"""

from collections.abc import Sequence

from django.db import transaction

from lb02.booking import DATABASE
from lb02.limits import MAX_SHOWN_SLOTS
from lb02.models import Conversation, Slot


def put_on_offer(conversation: Conversation, slots: Sequence[Slot]) -> list[Slot]:
    """Put these slots on offer, numbering the ones the conversation hasn't been shown, and return those on offer.

    The conversation's row is locked while the numbers are given, so two turns racing (a
    visitor's two tabs, or two servers) take the next number one after the other instead of
    both taking the same one. Every slot is on offer unless the conversation has already been
    shown as many as it ever may (`MAX_SHOWN_SLOTS`): a slot that would need a number past
    that is left out, because a slot without a number could not be held anyway.
    """
    with transaction.atomic(using=DATABASE):
        stored = Conversation.objects.select_for_update().only("shown_slots").get(pk=conversation.pk)
        shown = list(stored.shown_slots)
        on_offer: list[Slot] = []
        for slot in slots:
            if slot.pk not in shown:
                if len(shown) >= MAX_SHOWN_SLOTS:
                    continue
                shown.append(slot.pk)
            on_offer.append(slot)
        conversation.shown_slots = shown
        conversation.offered_slots = [slot.pk for slot in on_offer]
        conversation.save(update_fields=["shown_slots", "offered_slots", "updated_at"])
    return on_offer


def number_of(conversation: Conversation, slot_id: int) -> int | None:
    """Return the number the conversation gave a slot, or None if it has never been shown that slot."""
    if slot_id not in conversation.shown_slots:
        return None
    return conversation.shown_slots.index(slot_id) + 1


def slot_numbered(conversation: Conversation, number: int) -> int | None:
    """Return the ID of the slot that has this number in the conversation, or None if the number was never given."""
    if not 1 <= number <= len(conversation.shown_slots):
        return None
    return conversation.shown_slots[number - 1]


def is_on_offer(conversation: Conversation, slot_id: int) -> bool:
    """Tell whether the slot is among those the latest search put on offer."""
    return slot_id in conversation.offered_slots
