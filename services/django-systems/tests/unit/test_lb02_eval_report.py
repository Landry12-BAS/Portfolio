"""Tests for the pure parts of LB-02's golden-set eval: the report's arithmetic, the clock and the argument grader."""

from datetime import UTC, date, datetime

from lb02.golden import ToolArguments
from lb02.golden_eval import CaseGrade, EvalClock, EvalReport, days_from, mismatches

TODAY = date(2026, 10, 1)


def test_the_report_counts_what_passed_and_what_failed_by_check() -> None:
    """The pass rate is the share of cases with no failure, and failures are tallied by the check that found them."""
    report = EvalReport(
        [
            CaseGrade("a", [], calls=7, booked=True),
            CaseGrade("b", ["tools: turn 1: expected x", "step: turn 2: expected y"], calls=9, booked=True),
            CaseGrade("c", ["tools: turn 1: expected z"], calls=3, booked=False),
        ]
    )

    assert report.pass_rate() == 1 / 3
    assert report.failures_by_check() == {"tools": 2, "step": 1}
    assert report.total_calls() == 19


def test_calls_per_booking_are_read_from_the_conversations_that_booked() -> None:
    """Only a conversation that made a booking tells what a booking costs: the fewest, the most and the average."""
    report = EvalReport(
        [
            CaseGrade("a", [], calls=7, booked=True),
            CaseGrade("b", [], calls=10, booked=True),
            CaseGrade("c", [], calls=3, booked=False),
        ]
    )

    assert report.calls_per_booking() == (7, 10, 8.5)


def test_an_empty_report_has_nothing_to_say() -> None:
    """No cases means a pass rate of zero, not a division by zero, and no cost of a booking."""
    report = EvalReport([])

    assert (report.pass_rate(), report.total_calls(), report.calls_per_booking()) == (0.0, 0, None)
    assert not report.failures_by_check()


def test_the_clock_stands_still_until_it_is_moved() -> None:
    """A hold runs out when the script says six minutes passed, and not before."""
    clock = EvalClock(datetime(2026, 10, 1, 9, 0, tzinfo=UTC))

    assert clock() == clock()
    clock.advance(6)

    assert clock() == datetime(2026, 10, 1, 9, 6, tzinfo=UTC)


def test_a_date_a_call_carried_is_counted_in_days_from_today() -> None:
    """Day 1 is tomorrow; a call that carried no date, or one that isn't text, has no day."""
    assert days_from(TODAY, "2026-10-02") == 1
    assert days_from(TODAY, "2026-10-01") == 0
    assert days_from(TODAY, None) is None
    assert days_from(TODAY, 20261002) is None


def test_only_the_arguments_a_case_lists_are_compared() -> None:
    """A call may carry more than the case checks, and a name only needs to contain what the case says."""
    wanted = ToolArguments(offering="cupping", party_size=2, name_contains="jana", from_day=1, to_day=1)
    given: dict[str, object] = {
        "offering": "cupping",
        "party_size": 2,
        "name": "Jana Novak",
        "date_from": "2026-10-02",
        "date_to": "2026-10-02",
        "part_of_day": "evening",
    }

    assert mismatches(wanted, given, TODAY) == []


def test_every_argument_that_differs_is_named() -> None:
    """Each difference is a line of its own, so a failure says exactly what the model got wrong."""
    wanted = ToolArguments(offering="cupping", party_size=2, name_contains="Jana", from_day=1, part_of_day="morning")
    given: dict[str, object] = {"offering": "tasting", "party_size": 3, "name": "Petr", "date_from": "2026-10-04"}

    problems = mismatches(wanted, given, TODAY)

    assert problems == [
        "offering: expected cupping, got tasting",
        "party_size: expected 2, got 3",
        "part_of_day: expected morning, got None",
        "name: expected one containing Jana, got Petr",
        "date_from: expected day 1, got 2026-10-04",
    ]
