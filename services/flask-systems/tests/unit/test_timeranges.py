"""Tests for the calendar ranges counted from a day (lb05/timeranges.py)."""

from datetime import date, timedelta

import pytest

from lb05.timeranges import (
    last_days,
    month_start,
    named_ranges,
    quarter_bounds,
    quarter_start,
    range_parameters,
    week_start,
)

# A Wednesday in the middle of the fourth quarter.
MID_QUARTER = date(2026, 11, 18)


def bounds(today: date, name: str) -> tuple[date, date]:
    """Return a named range's first and last day."""
    found = named_ranges(today)[name]
    return found.start, found.end


@pytest.mark.parametrize(
    ("name", "start", "end"),
    [
        ("today", date(2026, 11, 18), date(2026, 11, 18)),
        ("yesterday", date(2026, 11, 17), date(2026, 11, 17)),
        ("this_week", date(2026, 11, 16), date(2026, 11, 18)),
        ("last_week", date(2026, 11, 9), date(2026, 11, 15)),
        ("this_month", date(2026, 11, 1), date(2026, 11, 18)),
        ("last_month", date(2026, 10, 1), date(2026, 10, 31)),
        ("this_quarter", date(2026, 10, 1), date(2026, 11, 18)),
        ("last_quarter", date(2026, 7, 1), date(2026, 9, 30)),
        ("quarter_before_last", date(2026, 4, 1), date(2026, 6, 30)),
        ("last_quarter_a_year_ago", date(2025, 7, 1), date(2025, 9, 30)),
        ("this_year", date(2026, 1, 1), date(2026, 11, 18)),
        ("last_year", date(2025, 1, 1), date(2025, 12, 31)),
        ("year_before_last", date(2024, 1, 1), date(2024, 12, 31)),
        ("last_7_days", date(2026, 11, 12), date(2026, 11, 18)),
        ("last_30_days", date(2026, 10, 20), date(2026, 11, 18)),
        ("last_90_days", date(2026, 8, 21), date(2026, 11, 18)),
        ("last_12_months", date(2025, 11, 19), date(2026, 11, 18)),
    ],
)
def test_ranges_in_the_middle_of_a_quarter(name: str, start: date, end: date) -> None:
    """Each named range is counted from the day, and both of its ends are included."""
    assert bounds(MID_QUARTER, name) == (start, end)


def test_ranges_across_a_year_boundary() -> None:
    """Early in January, the last quarter and the last month are in the year before."""
    today = date(2027, 1, 10)
    assert bounds(today, "last_quarter") == (date(2026, 10, 1), date(2026, 12, 31))
    assert bounds(today, "quarter_before_last") == (date(2026, 7, 1), date(2026, 9, 30))
    assert bounds(today, "last_month") == (date(2026, 12, 1), date(2026, 12, 31))
    assert bounds(today, "this_quarter") == (date(2027, 1, 1), today)
    assert bounds(today, "last_year") == (date(2026, 1, 1), date(2026, 12, 31))


def test_last_week_on_a_monday_is_the_whole_week_before() -> None:
    """On a Monday, this week is one day long and last week is the seven days before it."""
    monday = date(2026, 1, 5)
    assert bounds(monday, "this_week") == (monday, monday)
    assert bounds(monday, "last_week") == (date(2025, 12, 29), date(2026, 1, 4))


def test_a_leap_year_does_not_break_the_year_earlier_range() -> None:
    """Quarter boundaries never fall on 29 February, so the range a year earlier always exists."""
    assert bounds(date(2028, 4, 10), "last_quarter") == (date(2028, 1, 1), date(2028, 3, 31))
    assert bounds(date(2028, 4, 10), "last_quarter_a_year_ago") == (date(2027, 1, 1), date(2027, 3, 31))
    assert bounds(date(2028, 2, 29), "last_quarter_a_year_ago") == (date(2026, 10, 1), date(2026, 12, 31))


def test_every_range_is_well_formed_on_every_day_for_six_years() -> None:
    """Whatever the day, a range starts no later than it ends and a quarter is a whole quarter."""
    today = date(2024, 1, 1)
    while today <= date(2029, 12, 31):
        ranges = named_ranges(today)
        for found in ranges.values():
            assert found.start <= found.end, (today, found.name)
            assert found.end <= today, (today, found.name)
        quarter = ranges["last_quarter"]
        day_after = quarter.end + timedelta(days=1)
        assert quarter.start.day == 1
        assert quarter.start.month in (1, 4, 7, 10)
        assert quarter_start(day_after) == day_after
        assert quarter.end < quarter_start(today)
        today += timedelta(days=1)


def test_no_range_reaches_past_today() -> None:
    """The data ends on the as-of day, so no named range may include a later day."""
    for found in named_ranges(MID_QUARTER).values():
        assert found.end <= MID_QUARTER


def test_parameters_name_both_ends_of_each_range_and_today() -> None:
    """The golden set's reference queries read ranges as parameters such as `last_quarter_start`."""
    parameters = range_parameters(MID_QUARTER)
    assert parameters["today"] == MID_QUARTER
    assert parameters["last_quarter_start"] == date(2026, 7, 1)
    assert parameters["last_quarter_end"] == date(2026, 9, 30)
    assert len(parameters) == 1 + 2 * len(named_ranges(MID_QUARTER))


def test_small_helpers() -> None:
    """The helpers the ranges are made of."""
    assert month_start(date(2026, 3, 31)) == date(2026, 3, 1)
    assert quarter_start(date(2026, 8, 5)) == date(2026, 7, 1)
    assert week_start(date(2026, 11, 22)) == date(2026, 11, 16)
    assert last_days(date(2026, 3, 1), 1) == (date(2026, 3, 1), date(2026, 3, 1))
    assert quarter_bounds(date(2026, 10, 1)) == (date(2026, 10, 1), date(2026, 12, 31))
    assert quarter_bounds(date(2026, 1, 1)) == (date(2026, 1, 1), date(2026, 3, 31))
