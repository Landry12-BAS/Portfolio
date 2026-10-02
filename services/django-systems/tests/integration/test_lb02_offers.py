"""Integration tests for slot numbers: a number means one slot for the whole conversation, whatever the calendar does.

The model holds a slot by the number it was shown with. These tests move the calendar between two
messages, the way a visitor's second tab or another visitor does, and check that a number never
turns into a different slot.
"""

from importlib import import_module
from types import SimpleNamespace

import pytest
from django.apps import apps
from django.db import connections

from lb02 import offers
from lb02.limits import MAX_SHOWN_SLOTS
from lb02.messages import Receipt
from lb02.models import Conversation, Offering, Reservation, Slot
from lb02.offers import put_on_offer
from lb02.snapshot import options_of
from lb02.states import Step
from tests.lb02_support import (
    DETAILS,
    Rig,
    build_rig,
    call,
    calling,
    make_conversation,
    race,
    reload,
    say,
)

pytestmark = [pytest.mark.integration, pytest.mark.django_db(databases=["lb02"])]

# A tasting has four slots on a day (10:00, 12:00, 16:00 and 18:00), which makes four numbered options.
TASTING_DETAILS = DETAILS | {"offering": "tasting", "part_of_day": "any"}
TASTING_REQUEST = "A tasting for two tomorrow, please. I'm Jana Novak, jana@example.test."


def shown_with_numbers(conversation: Conversation) -> dict[int, int]:
    """Map each number to the slot that holds it, for the slots on offer now."""
    return {option.number: option.slot_id for option in options_of(conversation)}


def tasting_conversation(rig: Rig) -> Conversation:
    """Start a conversation whose details are in and whose first search put the four tasting slots on offer."""
    conversation = rig.conversation()
    rig.give_details(conversation, offering="tasting", part_of_day="any")
    return conversation


def another_visitor_holds(rig: Rig, slot_id: int) -> None:
    """Have a different visitor hold a slot, as their tab would while this visitor reads the list."""
    slot = Slot.objects.select_related("offering").get(pk=slot_id)
    other = make_conversation(slot.offering, session="session-of-the-other-visitor")
    rig.concierge.bookings.place_hold(other, slot)


# Numbering


def test_the_first_search_numbers_the_slots_from_one_in_the_order_it_found_them() -> None:
    """A conversation's first list is 1, 2, 3, 4, as it always was."""
    rig = build_rig()

    conversation = tasting_conversation(rig)

    options = options_of(conversation)
    assert [option.number for option in options] == [1, 2, 3, 4]
    assert [option.starts_at for option in options] == sorted(option.starts_at for option in options)
    assert reload(conversation).shown_slots == [option.slot_id for option in options]


def test_a_slot_that_stays_on_offer_keeps_its_number_when_the_slots_before_it_go() -> None:
    """Another visitor takes number 1: the others do not move up a place, and the new slot gets a new number."""
    rig = build_rig()
    conversation = tasting_conversation(rig)
    before = shown_with_numbers(conversation)

    another_visitor_holds(rig, before[1])
    rig.run_tool(conversation, "check_availability", date_from="2026-10-02", date_to="2026-10-03")

    after = shown_with_numbers(conversation)
    assert 1 not in after
    assert {number: slot for number, slot in after.items() if number in before} == {
        number: slot for number, slot in before.items() if number in after
    }
    assert set(after) >= {2, 3, 4}
    assert min(set(after) - set(before)) == 5


def test_a_number_is_never_given_to_a_second_slot() -> None:
    """Searching again and again over a moving calendar never reuses a number, and keeps what was given."""
    rig = build_rig()
    conversation = tasting_conversation(rig)
    seen = shown_with_numbers(conversation)

    windows = [("2026-10-02", "2026-10-02"), ("2026-10-05", "2026-10-06"), ("2026-10-02", "2026-10-04")]
    for first_day, last_day in windows:
        rig.run_tool(conversation, "check_availability", date_from=first_day, date_to=last_day)
        for number, slot_id in shown_with_numbers(conversation).items():
            assert seen.setdefault(number, slot_id) == slot_id

    assert len(set(seen.values())) == len(seen)
    assert reload(conversation).shown_slots == [seen[number] for number in sorted(seen)]


# Holding by number


def test_a_number_whose_slot_was_taken_holds_nothing_else_and_says_it_was_taken() -> None:
    """The visitor chose number 1, and by the time they said yes, another visitor had it."""
    rig = build_rig()
    conversation = tasting_conversation(rig)
    number_one = shown_with_numbers(conversation)[1]
    another_visitor_holds(rig, number_one)

    outcome = rig.run_tool(conversation, "hold_slot", option=1)

    assert outcome.receipt == Receipt.SLOT_TAKEN
    assert not outcome.ok
    assert not Reservation.objects.filter(conversation=conversation).exists()


def test_a_number_whose_slot_is_free_but_no_longer_on_offer_holds_nothing() -> None:
    """The search moved to another day, so a number from the old list is not the visitor's choice any more."""
    rig = build_rig()
    conversation = tasting_conversation(rig)
    rig.run_tool(conversation, "check_availability", date_from="2026-10-05", date_to="2026-10-05")

    outcome = rig.run_tool(conversation, "hold_slot", option=1)

    assert outcome.error == "option_gone"
    assert outcome.receipt is None
    assert [option["option"] for option in outcome.result["options"]] == sorted(shown_with_numbers(conversation))
    assert not Reservation.objects.filter(conversation=conversation).exists()


def test_a_number_that_was_never_given_holds_nothing() -> None:
    """Number 9 of a conversation that has been shown four slots is not a slot."""
    rig = build_rig()
    conversation = tasting_conversation(rig)

    outcome = rig.run_tool(conversation, "hold_slot", option=9)

    assert outcome.error == "no_such_option"
    assert not Reservation.objects.filter(conversation=conversation).exists()


def test_changing_the_offering_retires_the_numbers_and_never_reuses_them() -> None:
    """A tasting slot's number cannot hold a slot for the cupping the visitor moved on to."""
    rig = build_rig()
    conversation = tasting_conversation(rig)
    tasting_numbers = set(shown_with_numbers(conversation))

    rig.run_tool(conversation, "update_details", offering="cupping")

    cupping_numbers = set(shown_with_numbers(conversation))
    assert cupping_numbers
    assert not cupping_numbers & tasting_numbers
    stale = rig.run_tool(conversation, "hold_slot", option=1)
    assert stale.error == "option_gone"
    fresh = rig.run_tool(conversation, "hold_slot", option=min(cupping_numbers))
    assert fresh.ok
    held = Reservation.objects.get(conversation=conversation, status=Reservation.Status.HELD)
    assert held.slot.offering.key == "cupping"


# The same visitor, two messages apart


def test_a_yes_holds_the_slot_the_visitor_was_shown_even_though_availability_changed_between_the_messages() -> None:
    """The visitor reads four times and another tab takes the first before they answer "the 16:00 one"."""
    rig = build_rig(
        [
            calling(call("update_details", **TASTING_DETAILS)),
            say("A tasting is free tomorrow at 10:00, 12:00, 16:00 and 18:00. Which one would you like?"),
            calling(call("hold_slot", option=3)),
            calling(call("hold_slot", option=1)),
        ]
    )
    conversation = rig.conversation()
    first = rig.concierge.take_turn(conversation, TASTING_REQUEST)
    shown = {option.number: option for option in first.options}
    another_visitor_holds(rig, shown[1].slot_id)

    second = rig.concierge.take_turn(conversation, "The 16:00 one, please.")

    assert second.step == Step.HOLD
    assert second.hold is not None
    assert second.hold.slot_id == shown[3].slot_id
    state = rig.models.requests[2].system()
    assert "are not any more: 1) tasting" in state
    assert "the only slots hold_slot accepts: 2) tasting" in state
    third = rig.concierge.take_turn(conversation, "Actually, the 10:00 one.")
    assert third.receipt == Receipt.SLOT_TAKEN
    assert third.hold is not None
    assert third.hold.slot_id == shown[3].slot_id


def test_a_number_picks_the_slot_it_was_shown_with_not_the_slot_now_in_that_place_of_the_list() -> None:
    """The case the fix is for: counting the new list from 1 would have put 18:00 under number 3, not 16:00."""
    rig = build_rig()
    conversation = tasting_conversation(rig)
    shown = shown_with_numbers(conversation)
    another_visitor_holds(rig, shown[1])
    rig.run_tool(conversation, "check_availability", date_from="2026-10-02", date_to="2026-10-02")

    in_the_new_lists_third_place = options_of(conversation)[2].slot_id
    outcome = rig.run_tool(conversation, "hold_slot", option=3)

    assert in_the_new_lists_third_place != shown[3]
    assert outcome.ok
    assert Reservation.objects.get(conversation=conversation, status=Reservation.Status.HELD).slot_id == shown[3]


# Conversations that were open before numbers were kept


def test_the_migration_gives_a_conversation_already_open_the_numbers_it_was_showing() -> None:
    """A conversation with slots on offer numbered them 1, 2, 3 by place, so its registry starts as that list."""
    build_rig()
    migration = import_module("lb02.migrations.0002_conversation_shown_slots")
    conversation = make_conversation(Offering.objects.get(key="tasting"))
    Conversation.objects.filter(pk=conversation.pk).update(offered_slots=[40, 7, 22], shown_slots=[])

    migration.number_the_slots_on_offer(apps, SimpleNamespace(connection=connections["lb02"]))

    assert reload(conversation).shown_slots == [40, 7, 22]


# The limit


def test_a_conversation_is_not_offered_a_slot_it_cannot_number(monkeypatch: pytest.MonkeyPatch) -> None:
    """With the registry full, new slots are left out of the offer rather than offered without a number."""
    monkeypatch.setattr(offers, "MAX_SHOWN_SLOTS", 3)
    rig = build_rig()

    conversation = tasting_conversation(rig)

    assert sorted(shown_with_numbers(conversation)) == [1, 2, 3]
    assert len(reload(conversation).shown_slots) == 3
    assert len(conversation.offered_slots) == 3


def test_the_whole_seeded_calendar_fits_in_the_numbers_a_conversation_has() -> None:
    """If the calendar ever grows past the limit, a long conversation could run out of numbers, so this says so."""
    build_rig()

    assert Slot.objects.count() <= MAX_SHOWN_SLOTS
    assert Offering.objects.exists()


# Two tabs numbering at once


@pytest.mark.django_db(databases=["lb02"], transaction=True)
def test_two_tabs_numbering_at_the_same_moment_take_different_numbers() -> None:
    """Two turns of one conversation (two tabs, or two servers) take the next numbers one after the other."""
    build_rig()
    tasting = Offering.objects.get(key="tasting")
    conversation = make_conversation(tasting)
    slots = list(Slot.objects.select_related("offering").filter(offering=tasting).order_by("during")[:4])
    first_tab, second_tab = (Conversation.objects.get(pk=conversation.pk) for _ in range(2))

    outcomes = race([lambda: put_on_offer(first_tab, slots[:2]), lambda: put_on_offer(second_tab, slots[2:])])

    assert not [outcome for outcome in outcomes if isinstance(outcome, Exception)]
    stored = reload(conversation).shown_slots
    assert sorted(stored) == sorted(slot.pk for slot in slots)
    assert len(set(stored)) == 4
