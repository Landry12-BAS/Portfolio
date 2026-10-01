"""Tests for LB-02's state machine: the step follows from the facts, and each step offers only the tools it should."""

import itertools

import pytest

from lb02.states import ACCEPTED, OFFERED, Step, Tool, derive_step, tool_accepted, tools_offered


def step_of(details: bool = False, hold: bool = False, booking: bool = False, handoff: bool = False) -> str:
    """Derive the step for a set of facts."""
    return derive_step(details_complete=details, has_live_hold=hold, has_booking=booking, handed_off=handoff)


def test_a_conversation_collects_details_until_they_are_complete() -> None:
    """Without all the details it is in the details step; with them it is ready to search."""
    assert step_of() == Step.DETAILS
    assert step_of(details=True) == Step.AVAILABILITY


def test_a_live_hold_waits_for_the_visitors_yes() -> None:
    """Holding a slot is the hold step, whatever else is true of the details."""
    assert step_of(details=True, hold=True) == Step.HOLD


def test_a_booking_finishes_the_conversation_and_a_handoff_ends_it() -> None:
    """A booking is done, and a handoff beats everything else, including a hold the conversation still had."""
    assert step_of(details=True, booking=True) == Step.DONE
    assert step_of(details=True, hold=True, booking=True, handoff=True) == Step.HANDOFF
    assert step_of(handoff=True) == Step.HANDOFF


@pytest.mark.parametrize(("details", "hold", "booking", "handoff"), list(itertools.product([False, True], repeat=4)))
def test_every_combination_of_facts_gives_a_step_with_a_tool_list(
    details: bool, hold: bool, booking: bool, handoff: bool
) -> None:
    """No combination of facts leaves a conversation in a state the machine doesn't know."""
    assert step_of(details, hold, booking, handoff) in OFFERED


def test_confirm_is_offered_only_while_a_slot_is_held() -> None:
    """The model can only be told about confirm_booking when the conversation holds a live slot."""
    offering_confirm = {step for step, tools in OFFERED.items() if Tool.CONFIRM_BOOKING in tools}

    assert offering_confirm == {Step.HOLD}
    assert Tool.RELEASE_HOLD in OFFERED[Step.HOLD]
    assert all(Tool.RELEASE_HOLD not in OFFERED[step] for step in OFFERED if step != Step.HOLD)


def test_confirm_is_accepted_after_the_booking_only_as_a_replay() -> None:
    """A second confirm in one reply returns the same booking; it is never offered, only tolerated."""
    assert tool_accepted(Step.DONE, Tool.CONFIRM_BOOKING)
    assert Tool.CONFIRM_BOOKING not in tools_offered(Step.DONE)
    refused_elsewhere = [
        step for step in (Step.DETAILS, Step.AVAILABILITY, Step.HANDOFF) if tool_accepted(step, Tool.CONFIRM_BOOKING)
    ]
    assert refused_elsewhere == []


def test_no_slot_is_held_before_the_details_are_in() -> None:
    """The details step offers neither a hold nor a search, so the model can't skip ahead."""
    assert OFFERED[Step.DETAILS] == (Tool.UPDATE_DETAILS, Tool.HANDOFF_TO_PERSON)


def test_once_the_conversation_is_with_a_person_no_tool_runs() -> None:
    """Nothing is offered or accepted in the handoff step, and a booking can't be made again after it is made."""
    assert OFFERED[Step.HANDOFF] == ()
    assert ACCEPTED[Step.HANDOFF] == ()
    assert not any(
        tool_accepted(Step.DONE, tool) for tool in (Tool.HOLD_SLOT, Tool.UPDATE_DETAILS, Tool.CHECK_AVAILABILITY)
    )


def test_a_person_can_be_asked_for_at_every_step_but_the_last() -> None:
    """Every step that has a conversation left offers the handoff."""
    for step in (Step.DETAILS, Step.AVAILABILITY, Step.HOLD, Step.DONE):
        assert tool_accepted(step, Tool.HANDOFF_TO_PERSON)


def test_every_tool_is_offered_somewhere_and_every_accepted_tool_is_a_known_one() -> None:
    """The tool list has no dead entry, and the tables use only the tools there are."""
    offered = {tool for tools in OFFERED.values() for tool in tools}

    assert offered == set(Tool)
    assert {tool for tools in ACCEPTED.values() for tool in tools} <= set(Tool)
    assert all(set(OFFERED[step]) <= set(ACCEPTED[step]) for step in OFFERED)
