"""Unit tests for slot numbers: how a number is looked up in a conversation's registry, with no database."""

import pytest

from lb02.models import Conversation
from lb02.offers import is_on_offer, number_of, slot_numbered
from lb02.prompts import OptionFacts, gone_options_note

# Slot IDs are database keys, so they are nothing like 1, 2, 3: the numbers must not be mistaken for them.
REGISTRY = [412, 87, 9_001, 55]


def conversation_shown(shown: list[int], on_offer: list[int] | None = None) -> Conversation:
    """Make a conversation, unsaved, that was shown these slots in this order and has these on offer now."""
    return Conversation(shown_slots=shown, offered_slots=on_offer if on_offer is not None else [])


def test_a_slots_number_is_its_place_in_the_registry_counting_from_one() -> None:
    """The first slot ever shown is number 1, whatever its ID, and numbers follow the order of showing."""
    conversation = conversation_shown(REGISTRY)

    assert [number_of(conversation, slot_id) for slot_id in REGISTRY] == [1, 2, 3, 4]


def test_a_slot_that_was_never_shown_has_no_number() -> None:
    """Nothing outside the registry can be given a number by looking."""
    assert number_of(conversation_shown(REGISTRY), 7) is None
    assert number_of(conversation_shown([]), 412) is None


def test_a_number_finds_the_slot_it_was_given_to() -> None:
    """The lookup is the reverse of numbering, for every number that was given."""
    conversation = conversation_shown(REGISTRY)

    assert [slot_numbered(conversation, number) for number in (1, 2, 3, 4)] == REGISTRY


@pytest.mark.parametrize("number", [0, -1, 5, 129])
def test_a_number_that_was_never_given_finds_no_slot(number: int) -> None:
    """Zero, a negative number, and a number past the last one given do not wrap around or reach a neighbour."""
    assert slot_numbered(conversation_shown(REGISTRY), number) is None


def test_only_the_slots_the_latest_search_found_are_on_offer() -> None:
    """A retired number keeps its place in the registry but is not on offer."""
    conversation = conversation_shown(REGISTRY, on_offer=[87, 55])

    assert [is_on_offer(conversation, slot_id) for slot_id in REGISTRY] == [False, True, False, True]
    assert number_of(conversation, 412) == 1


def test_the_model_is_told_which_numbers_have_gone_and_that_they_cannot_be_held() -> None:
    """The note names each gone option by the number the model knew it by."""
    gone = [OptionFacts(1, "tasting", "Fri 2 Oct 10:00"), OptionFacts(3, "tasting", "Fri 2 Oct 16:00")]

    note = gone_options_note(gone)

    assert "1) tasting, Fri 2 Oct 10:00; 3) tasting, Fri 2 Oct 16:00" in note
    assert "can't be held" in note
