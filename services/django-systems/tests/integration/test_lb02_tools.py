# ruff: noqa: RUF001 - the times are typeset text, so the tests hold their en dashes
"""Integration tests for LB-02's tool executor: each tool on a real database, with the model's calls written by hand.

The concierge tests (test_lb02_concierge.py) run whole conversations. These go tool by tool: what
a call changes, what it refuses, and what the model is told afterwards, so each rule has a test
that fails for that rule alone.
"""

import json
from datetime import date, timedelta

import pytest

from core.tool_chat import ToolCall
from lb02.messages import Receipt
from lb02.models import Confirmation, Conversation, Handoff, Offering, Reservation
from lb02.states import Step
from lb02.tools import CheckAvailabilityArguments, NoArguments, ToolOutcome, TurnContext
from tests.lb02_support import Rig, build_rig, make_conversation, reload

pytestmark = [pytest.mark.integration, pytest.mark.django_db(databases=["lb02"])]

OTHER_VISITOR = "session-of-the-other-visitor"


def conversation_with_details(rig: Rig) -> Conversation:
    """Start a conversation that has given every detail of a cupping for two, and so has slots on offer."""
    conversation = rig.conversation()
    rig.give_details(conversation)
    return reload(conversation)


def hold_first_option(rig: Rig, conversation: Conversation) -> Reservation:
    """Hold the first slot on offer, the way a model's hold_slot call does, and return the reservation."""
    outcome = rig.run_tool(conversation, "hold_slot", option=1)
    assert outcome.ok, outcome.result
    return Reservation.objects.get(conversation=conversation, status=Reservation.Status.HELD)


# Collecting details


def test_valid_fields_are_saved_and_a_bad_one_is_reported_without_losing_the_rest() -> None:
    """One field the calendar doesn't know doesn't throw away the name and the party that came with it."""
    rig = build_rig()
    conversation = rig.conversation()

    outcome = rig.run_tool(conversation, "update_details", offering="espresso-flight", party_size=2, name="Jana Novak")

    saved = reload(conversation)
    assert outcome.ok
    assert outcome.result["saved"] == ["party_size", "name"]
    assert outcome.result["errors"] == {"offering": "unknown_offering"}
    assert outcome.result["missing"] == ["offering", "email"]
    assert (saved.offering, saved.party_size, saved.guest_name) == (None, 2, "Jana Novak")


def test_a_call_that_saves_nothing_is_an_error_the_model_can_read() -> None:
    """When every field was refused the call fails, with the reasons, so the model asks the visitor again."""
    rig = build_rig()
    conversation = rig.conversation()

    outcome = rig.run_tool(conversation, "update_details", offering="espresso-flight")

    assert not outcome.ok
    assert outcome.error == "invalid_fields"
    assert outcome.result["errors"] == {"offering": "unknown_offering"}
    assert reload(conversation).offering is None


def test_a_party_larger_than_the_room_takes_is_refused_and_not_kept() -> None:
    """The tasting takes six: a party of seven is told so, and the cupping, which takes eight, accepts it."""
    rig = build_rig()
    conversation = rig.conversation()

    refused = rig.run_tool(conversation, "update_details", offering="tasting", party_size=7)
    accepted = rig.run_tool(conversation, "update_details", offering="cupping", party_size=7)

    assert refused.result["errors"] == {"party_size": "party_too_large: tasting takes at most 6 guests"}
    assert accepted.result["errors"] == {}
    assert reload(conversation).party_size == 7


def test_moving_to_a_smaller_offering_drops_a_party_that_no_longer_fits() -> None:
    """Eight guests suit the cupping and not the tasting, so the party is forgotten and asked for again."""
    rig = build_rig()
    conversation = rig.conversation()
    rig.run_tool(conversation, "update_details", offering="cupping", party_size=8)

    outcome = rig.run_tool(conversation, "update_details", offering="tasting")

    assert "party_size" in outcome.result["errors"]
    assert "party_size" in outcome.result["missing"]
    assert reload(conversation).party_size is None
    assert reload(conversation).offering == Offering.objects.get(key="tasting")


def test_complete_details_search_at_once_and_put_the_slots_on_offer() -> None:
    """The search is part of the same call, so the model reads the options in the result and needs no second call."""
    rig = build_rig()
    conversation = rig.conversation()

    outcome = rig.give_details(conversation)

    stored = reload(conversation)
    assert outcome.result["missing"] == []
    assert outcome.result["options"] == [{"option": 1, "offering": "cupping", "when": "Fri 2 Oct, 14:30–15:30"}]
    assert outcome.result["searched"] == "2026-10-02 to 2026-10-02, afternoon"
    assert len(stored.offered_slots) == 1
    assert (stored.search_from, stored.search_to, stored.search_part_of_day) == (
        date(2026, 10, 2),
        date(2026, 10, 2),
        "afternoon",
    )
    automatic = [span for span in rig.spans.spans if span.name == "check availability"]
    assert [span.attrs["automatic"] for span in automatic] == [True]


def test_details_without_an_email_are_not_searched_yet() -> None:
    """The address comes from the visitor's message, and until it is kept the conversation is still collecting."""
    rig = build_rig()
    conversation = rig.conversation()

    outcome = rig.give_details(conversation, email="")

    assert outcome.result["missing"] == ["email"]
    assert "options" not in outcome.result
    assert reload(conversation).step == Step.DETAILS


def test_an_empty_window_offers_the_nearest_slots_and_says_so() -> None:
    """Days that are over, or have nothing free, get the nearest slots instead, so a visitor still has a choice."""
    rig = build_rig()
    conversation = rig.conversation()

    outcome = rig.give_details(conversation, date_from="2026-09-01", date_to="2026-09-05")

    assert outcome.result["window_empty"] == "nothing is free then; these are the nearest slots"
    assert [option["option"] for option in outcome.result["options"]] == [1, 2, 3]
    assert len(reload(conversation).offered_slots) == 3


def test_the_search_never_looks_past_the_days_the_calendar_covers() -> None:
    """A visitor who asks for next year gets the nearest slots of the days that exist."""
    rig = build_rig()
    conversation = rig.conversation()

    outcome = rig.give_details(conversation, date_from="2027-03-01", date_to="2027-03-05")

    assert outcome.result["window_empty"]
    assert outcome.result["options"]


def test_changing_the_party_gives_up_the_hold_that_was_for_the_old_one() -> None:
    """A hold made for two guests is released when the party changes, and the slots are searched again."""
    rig = build_rig()
    conversation = conversation_with_details(rig)
    held = hold_first_option(rig, conversation)

    outcome = rig.run_tool(conversation, "update_details", party_size=3)

    held.refresh_from_db()
    assert held.status == Reservation.Status.RELEASED
    assert reload(conversation).step == Step.AVAILABILITY
    assert outcome.result["options"]


def test_changing_only_the_name_keeps_the_hold_and_renames_it() -> None:
    """The name is a detail of the booking, not of the slot, so the hold stays and carries the corrected name."""
    rig = build_rig()
    conversation = conversation_with_details(rig)
    held = hold_first_option(rig, conversation)

    rig.run_tool(conversation, "update_details", name="Jana Nováková")

    held.refresh_from_db()
    assert held.status == Reservation.Status.HELD
    assert held.guest_name == "Jana Nováková"
    assert reload(conversation).step == Step.HOLD


# Searching again


def test_a_search_is_refused_until_the_details_are_complete() -> None:
    """At the details step check_availability isn't on offer, so a call to it is refused and nothing is searched."""
    rig = build_rig()
    conversation = rig.conversation()

    outcome = rig.run_tool(conversation, "check_availability", date_from="2026-10-03")

    assert (outcome.executed, outcome.error) == (False, "not_available_now")
    assert reload(conversation).search_from is None


def test_the_search_itself_also_refuses_to_run_without_the_details() -> None:
    """Behind the state machine the tool checks for itself, and tells the model which details are missing."""
    rig = build_rig()
    conversation = rig.conversation()

    outcome = rig.concierge.tools.check_availability(
        conversation, CheckAvailabilityArguments(date_from=date(2026, 10, 3)), TurnContext("en")
    )

    assert not outcome.ok
    assert outcome.error == "details_missing"
    assert outcome.result["missing"] == ["offering", "party_size", "name", "email"]


def test_a_new_window_is_searched_and_remembered() -> None:
    """Asking for another day searches there, puts the slots on offer, and keeps the window for next time."""
    rig = build_rig()
    conversation = conversation_with_details(rig)

    outcome = rig.run_tool(conversation, "check_availability", date_from="2026-10-05", date_to="2026-10-06")

    stored = reload(conversation)
    assert outcome.ok
    assert [option["when"] for option in outcome.result["options"]] == [
        "Mon 5 Oct, 14:30–15:30",
        "Tue 6 Oct, 14:30–15:30",
    ]
    assert (stored.search_from, stored.search_to) == (date(2026, 10, 5), date(2026, 10, 6))
    assert stored.search_part_of_day == "afternoon"


def test_a_part_of_day_can_change_without_the_days() -> None:
    """The days the visitor named last stay; only the part of the day moves."""
    rig = build_rig()
    conversation = conversation_with_details(rig)

    outcome = rig.run_tool(conversation, "check_availability", part_of_day="morning")

    assert outcome.result["searched"] == "2026-10-02 to 2026-10-02, morning"
    assert [option["when"] for option in outcome.result["options"]] == ["Fri 2 Oct, 11:30–12:30"]


# Holding


def test_a_hold_needs_an_option_that_was_offered() -> None:
    """Option 2 of a list of one is not a slot: nothing is held, and the model is told how many there are."""
    rig = build_rig()
    conversation = conversation_with_details(rig)

    outcome = rig.run_tool(conversation, "hold_slot", option=2)

    assert not outcome.ok
    assert outcome.error == "no_such_option"
    assert outcome.result["options_on_offer"] == 1
    assert not Reservation.objects.exists()


def test_a_hold_is_for_five_minutes_and_comes_with_a_receipt_written_from_it() -> None:
    """The receipt's facts are the held slot's, in the visitor's language, and the hold runs out in five minutes."""
    rig = build_rig()
    conversation = conversation_with_details(rig)

    outcome = rig.run_tool(conversation, "hold_slot", TurnContext("cs"), option=1)

    reservation = Reservation.objects.get(conversation=conversation)
    assert outcome.receipt == Receipt.HOLD_PLACED
    assert outcome.facts["when"] == "pá 2. 10., 14:30–15:30"
    assert outcome.facts["offering"] == "Cupping"
    assert reservation.hold_expires_at == rig.clock() + timedelta(minutes=5)
    assert outcome.slot_id == reservation.slot_id


def test_a_slot_taken_in_the_meantime_is_reported_with_the_receipt_and_fresh_options() -> None:
    """Another visitor's hold between the search and this call: the database refuses, and the answer is a receipt."""
    rig = build_rig()
    conversation = conversation_with_details(rig)
    cupping = Offering.objects.get(key="cupping")
    offered = reload(conversation).offered_slots[0]
    rival = make_conversation(cupping, session=OTHER_VISITOR, guest_name="Dan Wu")
    day = date(2026, 10, 2)
    rig.concierge.bookings.place_hold(rival, rig.concierge.bookings.free_slots(cupping, day, day, 2, "afternoon", 1)[0])

    outcome = rig.run_tool(conversation, "hold_slot", option=1)

    assert not outcome.ok
    assert outcome.error == "slot_unavailable"
    assert outcome.receipt == Receipt.SLOT_TAKEN
    assert offered not in reload(conversation).offered_slots
    assert not Reservation.objects.filter(conversation=conversation).exists()


def test_holding_a_second_option_moves_the_hold() -> None:
    """A conversation has one hold: the first is released when the visitor picks another."""
    rig = build_rig()
    conversation = conversation_with_details(rig)
    rig.run_tool(conversation, "check_availability", date_from="2026-10-05", date_to="2026-10-06")
    first = hold_first_option(rig, conversation)

    rig.run_tool(conversation, "hold_slot", option=2)

    first.refresh_from_db()
    assert first.status == Reservation.Status.RELEASED
    assert Reservation.objects.filter(conversation=conversation, status=Reservation.Status.HELD).count() == 1


# Confirming


def test_a_hold_made_in_this_turn_cant_be_confirmed_in_it() -> None:
    """The visitor hasn't said yes to a hold they haven't seen, so a model can't hold and confirm in one reply."""
    rig = build_rig()
    conversation = conversation_with_details(rig)
    held = hold_first_option(rig, conversation)

    outcome = rig.run_tool(conversation, "confirm_booking", TurnContext("en", held_before=None))

    held.refresh_from_db()
    assert not outcome.ok
    assert outcome.error == "needs_the_visitors_yes"
    assert held.status == Reservation.Status.HELD
    assert not Confirmation.objects.exists()


def test_confirming_the_hold_the_visitor_answered_books_it_and_records_the_mock_confirmation() -> None:
    """With the visitor's yes in a later message the hold becomes a booking, and the confirmation is only a record."""
    rig = build_rig()
    conversation = conversation_with_details(rig)
    held = hold_first_option(rig, conversation)

    outcome = rig.run_tool(conversation, "confirm_booking", TurnContext("en", held_before=held.pk))

    held.refresh_from_db()
    confirmation = Confirmation.objects.get(reservation=held)
    assert outcome.ok
    assert outcome.receipt == Receipt.BOOKING_CONFIRMED
    assert outcome.result["already_booked"] is False
    assert held.status == Reservation.Status.BOOKED
    assert held.idempotency_key == f"confirm-{held.code}"
    assert (confirmation.delivery, confirmation.to_address) == ("mock", "jana@example.test")
    mock_span = rig.spans.named("send confirmation")
    assert (mock_span.kind, mock_span.attrs["mock"]) == ("system.tool", True)


def test_a_hold_that_ran_out_cant_be_confirmed() -> None:
    """Six minutes later there is no live hold, so confirm isn't accepted, and nothing is booked."""
    rig = build_rig()
    conversation = conversation_with_details(rig)
    held = hold_first_option(rig, conversation)
    rig.clock.advance(6)

    outcome = rig.run_tool(conversation, "confirm_booking", TurnContext("en", held_before=held.pk))

    assert (outcome.executed, outcome.error) == (False, "not_available_now")
    assert reload(conversation).step == Step.AVAILABILITY
    assert not Confirmation.objects.exists()
    assert not Reservation.objects.filter(status=Reservation.Status.BOOKED).exists()


def test_a_hold_that_runs_out_during_the_call_is_refused_by_the_booking_rules_with_a_receipt() -> None:
    """The narrow case: the hold was live when the call began and ran out before it finished. Nothing is booked."""
    rig = build_rig()
    conversation = conversation_with_details(rig)
    held = hold_first_option(rig, conversation)
    rig.clock.advance(6)

    outcome = rig.concierge.tools.confirm_booking(conversation, NoArguments(), TurnContext("en", held_before=held.pk))

    assert not outcome.ok
    assert outcome.receipt == Receipt.HOLD_EXPIRED
    assert outcome.facts["when"] == "Fri 2 Oct, 14:30\u201315:30"
    assert not Confirmation.objects.exists()
    assert Reservation.objects.get(pk=held.pk).status != Reservation.Status.BOOKED


def test_confirming_with_nothing_held_is_an_error() -> None:
    """At the details step confirm isn't offered; at any other step with no hold it still finds nothing to confirm."""
    rig = build_rig()
    conversation = conversation_with_details(rig)

    outcome = rig.run_tool(conversation, "confirm_booking")

    assert not outcome.executed
    assert outcome.error == "not_available_now"
    assert not Reservation.objects.exists()


# Releasing and handing over


def test_releasing_gives_the_slot_back() -> None:
    """The slot is free for anyone again as soon as the hold is released."""
    rig = build_rig()
    conversation = conversation_with_details(rig)
    held = hold_first_option(rig, conversation)

    outcome = rig.run_tool(conversation, "release_hold")

    held.refresh_from_db()
    assert outcome.result == {"ok": True, "released": True}
    assert held.status == Reservation.Status.RELEASED
    assert reload(conversation).step == Step.AVAILABILITY


def test_handing_over_ends_the_conversation_and_nothing_is_accepted_after() -> None:
    """Once a person has the conversation no tool runs, whatever the model asks."""
    rig = build_rig()
    conversation = conversation_with_details(rig)

    outcome = rig.run_tool(conversation, "handoff_to_person", reason="asked_for_person")
    after = rig.run_tool(conversation, "hold_slot", option=1)

    assert outcome.receipt == Receipt.HANDED_OFF
    assert Handoff.objects.get(conversation=conversation).reason == Handoff.Reason.ASKED_FOR_PERSON
    assert reload(conversation).step == Step.HANDOFF
    assert (after.executed, after.error) == (False, "not_available_now")


# What the state machine and the schemas refuse


def test_a_tool_the_step_doesnt_accept_is_refused_and_changes_nothing() -> None:
    """Holding at the details step: refused as not available now, with the step named for the model."""
    rig = build_rig()
    conversation = rig.conversation()

    outcome = rig.run_tool(conversation, "hold_slot", option=1)

    assert (outcome.executed, outcome.ok, outcome.error) == (False, False, "not_available_now")
    assert outcome.result["step"] == Step.DETAILS
    assert not Reservation.objects.exists()


def test_a_tool_that_doesnt_exist_is_refused_by_name_and_the_name_is_cut_short() -> None:
    """A made-up tool is unknown, and a very long made-up name is not stored whole."""
    rig = build_rig()
    conversation = rig.conversation()

    outcome = rig.run_tool(conversation, "x" * 500)

    assert outcome.error == "unknown_tool"
    assert len(outcome.tool) <= 64


def test_malformed_arguments_are_an_error_that_names_the_field_and_not_the_value() -> None:
    """The model reads which field was wrong and why, never its own text back."""
    rig = build_rig()
    conversation = rig.conversation()

    outcome = rig.run_tool(conversation, "update_details", party_size="SECRET-NUMBER")

    assert (outcome.executed, outcome.error) == (True, "invalid_arguments")
    assert outcome.result["detail"] == "invalid arguments: party_size"
    assert "SECRET-NUMBER" not in outcome.for_model()


def test_arguments_that_are_not_json_are_an_error_too() -> None:
    """Broken JSON never reaches a handler."""
    rig = build_rig()
    conversation = rig.conversation()
    broken = ToolCall("call_x", "update_details", "{not json")

    outcome = rig.run_call(conversation, broken)

    assert outcome.error == "invalid_arguments"


# What the model reads, and what the Scope shows


def test_an_outcome_is_written_to_the_model_as_compact_json_in_any_alphabet() -> None:
    """No spaces to spend tokens on, and a Czech time reads as Czech and not as escapes."""
    outcome = ToolOutcome("hold_slot", True, True, {"ok": True, "held": "pá 2. 10., 14:30"})

    assert outcome.for_model() == '{"ok":true,"held":"pá 2. 10., 14:30"}'
    assert json.loads(outcome.for_model())["ok"] is True


def test_each_tool_runs_in_a_span_named_for_its_place_in_the_chain() -> None:
    """The Scope reads: collect details, check availability, hold slot, confirm."""
    rig = build_rig()
    conversation = conversation_with_details(rig)
    held = hold_first_option(rig, conversation)
    rig.run_tool(conversation, "confirm_booking", TurnContext("en", held_before=held.pk))

    names = rig.spans.names()

    assert names == ["check availability", "collect details", "hold slot", "send confirmation", "confirm"]
    assert {span.kind for span in rig.spans.spans} == {"system.tool"}


def test_a_span_records_the_outcome_and_never_the_visitors_words() -> None:
    """Spans carry metadata only: the tool, whether it worked and any error code, and never the guest's name."""
    rig = build_rig()
    conversation = rig.conversation()

    rig.give_details(conversation)
    rig.run_tool(conversation, "update_details", party_size="x")

    values = [value for span in rig.spans.spans for value in span.attrs.values()]
    assert "Jana Novak" not in values
    assert rig.spans.named("collect details").attrs["tool"] == "update_details"


def test_arguments_are_kept_on_the_outcome_for_the_eval_and_the_scope() -> None:
    """The validated arguments, without the fields the model left out, are what the golden-set grader compares."""
    rig = build_rig()
    conversation = rig.conversation()

    outcome = rig.run_tool(conversation, "update_details", party_size=2, name="Jana Novak")

    assert outcome.arguments == {"party_size": 2, "name": "Jana Novak"}
