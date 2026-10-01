"""Offline tests for LB-02's golden set: it follows its rules, and agrees with the seed data and the state machine.

The golden set grades the concierge, so a mistake in it would pass a wrong answer or fail a
right one. These checks keep every reference real (offerings, start times, days, party sizes)
and every script possible (a tool is only expected where the state machine would let it run),
and they keep the set honest about what it covers. Nothing here needs a database or a model.
"""

import re
from typing import Any, get_args

import pytest
from django.conf import settings
from pydantic import ValidationError

from core.data_files import read_data_file
from lb02.golden import GoldenCase, GoldenSet, Scenario, SlotRef, Turn, TurnExpectation, read_golden_set
from lb02.limits import CALENDAR_DAYS_AHEAD, MAX_MODEL_CALLS_PER_CONVERSATION
from lb02.messages import MODEL_WRITES_IN_OTHER_LANGUAGES, TEMPLATE_LANGUAGES, Receipt
from lb02.seed import CalendarFile, OfferingEntry
from lb02.states import ACCEPTED, Step, Tool


@pytest.fixture(scope="module")
def golden() -> GoldenSet:
    """Read the golden set once for the module."""
    return read_golden_set()


@pytest.fixture(scope="module")
def offerings() -> dict[str, OfferingEntry]:
    """Return every seeded offering by key."""
    calendar = read_data_file(settings.SEED_DIR / "lb02" / "offerings.yaml", CalendarFile)
    return {offering.key: offering for offering in calendar.offerings}


def slot_refs_of(case: GoldenCase) -> list[SlotRef]:
    """Collect every slot a case names, wherever it names one."""
    refs: list[SlotRef] = [event.slot for event in case.world]
    for turn in case.turns:
        refs += [*turn.expect.offers, *turn.expect.not_offered]
        if isinstance(turn.expect.hold, SlotRef):
            refs.append(turn.expect.hold)
    refs += [booking.slot for booking in case.end.bookings]
    if isinstance(case.end.hold, SlotRef):
        refs.append(case.end.hold)
    return refs


def single_step(step: Any) -> str | None:
    """Return the one step an expectation names, or None when it allows several."""
    return None if isinstance(step, list) else str(step)


def test_the_set_has_between_20_and_50_cases(golden: GoldenSet) -> None:
    """The playbook asks for 20 to 50 cases, written before the prompts."""
    assert 20 <= len(golden.cases) <= 50


def test_every_slot_a_case_names_exists_in_the_seeded_calendar(
    golden: GoldenSet, offerings: dict[str, OfferingEntry]
) -> None:
    """The offering is seeded, the time is one of its start times, and the day is one of the 14 laid out."""
    for case in golden.cases:
        for ref in slot_refs_of(case):
            assert ref.offering in offerings, f"{case.id}: {ref.offering}"
            assert ref.time in offerings[ref.offering].starts, f"{case.id}: {ref.offering} doesn't start at {ref.time}"
            assert 1 <= ref.day <= CALENDAR_DAYS_AHEAD, case.id


def test_no_case_asks_for_more_guests_than_a_room_takes(golden: GoldenSet, offerings: dict[str, OfferingEntry]) -> None:
    """Booked parties and the other visitors' parties fit the offering they are for."""
    for case in golden.cases:
        for booking in case.end.bookings:
            assert booking.party_size <= offerings[booking.slot.offering].capacity, case.id
        for event in case.world:
            assert event.party_size <= offerings[event.slot.offering].capacity, case.id


def test_the_set_covers_every_scenario_the_task_names(golden: GoldenSet) -> None:
    """Double bookings, expiry, a changed mind, injections, someone else's hold, missing details, out of scope."""
    covered = {scenario for case in golden.cases for scenario in case.covers}

    assert covered == set(get_args(Scenario.__value__))


def test_the_set_speaks_english_czech_and_another_language(golden: GoldenSet) -> None:
    """English and Czech, each with several cases, and at least one conversation in a third language."""
    languages = [case.language for case in golden.cases]

    assert languages.count("en") >= 8
    assert languages.count("cs") >= 6
    assert {"de", "sk"} <= set(languages)


def test_the_samples_open_the_demo_in_both_languages_with_both_defences(golden: GoldenSet) -> None:
    """The demo opens on a booking in each language, a double-booking attempt and an injection."""
    samples = golden.samples()
    covered = {scenario for case in samples for scenario in case.covers}

    assert {case.language for case in samples} >= {"en", "cs"}
    assert {"double_booking", "injection", "happy_path"} <= covered


def test_every_script_only_expects_a_tool_where_the_state_machine_lets_it_run(golden: GoldenSet) -> None:
    """The first tool of each turn must be accepted in the step the previous turn left the conversation in."""
    for case in golden.cases:
        step: str | None = Step.DETAILS
        for number, turn in enumerate(case.turns, start=1):
            if step is not None and turn.expect.tools:
                assert Tool(turn.expect.tools[0]) in ACCEPTED[step], (
                    f"{case.id}, turn {number}: {turn.expect.tools[0]} in {step}"
                )
            step = single_step(turn.expect.step)


def test_a_confirm_is_only_expected_after_a_hold(golden: GoldenSet) -> None:
    """A conversation can't be scripted to confirm a slot it never held."""
    for case in golden.cases:
        held = False
        for turn in case.turns:
            tools = turn.expect.tools or []
            if Tool.CONFIRM_BOOKING in tools:
                assert held, f"{case.id} confirms before any hold"
            held = held or isinstance(turn.expect.hold, SlotRef)


def test_a_booking_is_only_expected_where_the_script_confirms_one(golden: GoldenSet) -> None:
    """A case that ends in a booking confirms it in its last turn, and one that doesn't never does."""
    for case in golden.cases:
        confirms = [Tool.CONFIRM_BOOKING in (turn.expect.tools or []) for turn in case.turns]
        assert any(confirms) == bool(case.end.bookings), case.id


def test_receipts_are_expected_in_the_languages_the_code_writes_them_in(golden: GoldenSet) -> None:
    """A receipt stating a booking fact is only expected in English or Czech: others are the model's to write."""
    for case in golden.cases:
        language = case.language
        for turn in case.turns:
            language = turn.expect.reply_language or language
            if turn.expect.receipt in MODEL_WRITES_IN_OTHER_LANGUAGES:
                assert language in TEMPLATE_LANGUAGES, f"{case.id}: {turn.expect.receipt} in {language}"


def test_a_hold_that_expires_waits_longer_than_the_hold_lasts(golden: GoldenSet) -> None:
    """Every case about expiry has a turn that comes after more than the five minutes a hold lasts."""
    for case in golden.cases:
        if "hold_expires" in case.covers:
            assert any(turn.wait_minutes > 5 for turn in case.turns), case.id
        for turn in case.turns:
            assert turn.wait_minutes == 0 or "hold_expires" in case.covers, f"{case.id} waits without covering expiry"


def test_a_booking_fits_the_datasheets_call_budget(golden: GoldenSet) -> None:
    """A plain three-message booking is expected within the datasheet's 6 to 10 calls; none may exceed the cap."""
    for case in golden.cases:
        assert case.end.calls_at_most <= MAX_MODEL_CALLS_PER_CONVERSATION, case.id
        if case.covers == ["happy_path"] and len(case.turns) == 3:
            assert case.end.calls_at_most <= 11, case.id
    plain = [case for case in golden.cases if case.id in {"book-cupping-en", "book-tasting-cs"}]
    assert plain
    assert all(case.end.calls_at_most <= 10 for case in plain)


def test_an_injection_stopped_by_the_screen_costs_one_call(golden: GoldenSet) -> None:
    """When the receipt says the screen refused the message, the budget is the one guard call."""
    refused = [
        case
        for case in golden.cases
        if any(turn.expect.receipt == Receipt.INJECTION_REFUSED for turn in case.turns) and len(case.turns) == 1
    ]

    assert refused
    assert all(case.end.calls_at_most == 1 for case in refused)


def test_every_case_that_ends_without_a_booking_says_why(golden: GoldenSet) -> None:
    """A case with no booking ends in details, availability, handoff, or holds nothing: never in a half-made booking."""
    for case in golden.cases:
        if not case.end.bookings:
            steps = case.end.step if isinstance(case.end.step, list) else [case.end.step]
            assert Step.DONE not in steps, case.id


def test_the_names_the_golden_set_uses_for_slots_are_stable_texts(golden: GoldenSet) -> None:
    """Visitor lines stay short and case IDs stay readable, so a failing case can be found by name."""
    for case in golden.cases:
        assert re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", case.id), case.id
        assert all(len(turn.say) <= 500 for turn in case.turns), case.id


# A complete expectation to vary in the rule tests below.
EXPECTATION: dict[str, Any] = {"tools": ["update_details"], "step": "availability"}


@pytest.mark.parametrize(
    ("changes", "problem"),
    [
        ({"args": {"hold_slot": {}}}, "doesn't run in this turn"),
        ({"hold": {"offering": "tasting", "day": 1, "time": "12:00"}}, "can only be held in the hold step"),
        ({"step": "hold", "hold": "none"}, "the hold step holds a slot"),
        ({"never": ["x"]}, "at least 2 characters"),
        ({"receipt": "a_made_up_receipt"}, "Input should be"),
        ({"tools": ["transfer_money"]}, "Input should be"),
        ({"step": "somewhere"}, "Input should be"),
    ],
)
def test_an_expectation_must_be_consistent(changes: dict[str, Any], problem: str) -> None:
    """Arguments for a tool that doesn't run, a hold outside the hold step and unknown names are all refused."""
    with pytest.raises(ValidationError, match=re.escape(problem)):
        TurnExpectation.model_validate({**EXPECTATION, **changes})


def case_data(**changes: Any) -> dict[str, Any]:
    """Build a one-turn case as data, to vary in the rule tests below."""
    case: dict[str, Any] = {
        "id": "a-case",
        "covers": ["happy_path"],
        "language": "en",
        "note": "A case.",
        "turns": [{"say": "Hello", "expect": {"step": "details"}}],
        "end": {"step": "details", "calls_at_most": 3},
    }
    return {**case, **changes}


@pytest.mark.parametrize(
    ("changes", "problem"),
    [
        ({"end": {"step": "availability", "calls_at_most": 3}}, "ends in a step its last turn doesn't allow"),
        ({"end": {"step": "details", "calls_at_most": 21}}, "less than or equal to 20"),
        (
            {
                "turns": [{"say": "Hello", "expect": {"step": "done"}}],
                "end": {"step": "done", "calls_at_most": 3},
            },
            "the done step means a booking was made",
        ),
        (
            {
                "turns": [{"say": "Hello", "expect": {"step": "handoff"}}],
                "end": {"step": "handoff", "calls_at_most": 3},
            },
            "say why the conversation was handed over",
        ),
        (
            {"end": {"step": "details", "handoff": "out_of_scope", "calls_at_most": 3}},
            "needs the handoff step",
        ),
        (
            {
                "world": [
                    {
                        "before_turn": 2,
                        "other_visitor": "holds",
                        "slot": {"offering": "tasting", "day": 1, "time": "10:00"},
                    }
                ]
            },
            "but there are only 1",
        ),
        ({"turns": [{"say": "", "expect": {"step": "details"}}]}, "at least 1 character"),
        ({"turns": [{"say": "x" * 501, "expect": {"step": "details"}}]}, "at most 500 characters"),
        ({"covers": ["a_made_up_scenario"]}, "Input should be"),
        ({"language": "english"}, "String should match pattern"),
        ({"surprise": 1}, "Extra inputs are not permitted"),
    ],
)
def test_a_case_must_be_consistent_with_itself(changes: dict[str, Any], problem: str) -> None:
    """Endings the script doesn't reach, a booking without a done step and a stray world event are refused."""
    with pytest.raises(ValidationError, match=re.escape(problem)):
        GoldenCase.model_validate(case_data(**changes))


def test_the_set_refuses_repeated_ids_and_samples_in_one_language(golden: GoldenSet) -> None:
    """Case IDs are unique, and the samples must speak both languages."""
    cases = [case.model_dump(mode="json") for case in golden.cases]

    with pytest.raises(ValidationError, match="appears more than once"):
        GoldenSet.model_validate({"cases": [*cases[:-1], cases[0]]})
    english_samples_only = [{**case, "sample": case["sample"] and case["language"] == "en"} for case in cases]
    with pytest.raises(ValidationError, match="in English and in Czech"):
        GoldenSet.model_validate({"cases": english_samples_only})


def test_a_turn_can_wait_but_not_for_a_day() -> None:
    """The wait before a message is a number of minutes, at most an hour."""
    Turn.model_validate({"say": "Hello", "wait_minutes": 60, "expect": {"step": "details"}})
    with pytest.raises(ValidationError, match="less than or equal to 60"):
        Turn.model_validate({"say": "Hello", "wait_minutes": 61, "expect": {"step": "details"}})
