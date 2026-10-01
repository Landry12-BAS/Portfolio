"""Calendar ranges counted from a day: "last quarter", "this year", "the last 30 days".

The data's dates are relative to the day it was generated (its "as-of" day), so every
range is counted from that day and never from the clock. Language models are poor at
calendar arithmetic, so the pipeline works the ranges out here and hands the model plain
dates; the generator uses the same ranges to place its stories where "last quarter" is;
and the golden set's reference SQL reads them as parameters. One definition serves all three.

All ranges are inclusive at both ends.
"""

from dataclasses import dataclass
from datetime import date, timedelta


@dataclass(frozen=True)
class TimeRange:
    """A named stretch of days, from `start` to `end`, both included."""

    name: str
    label: str
    start: date
    end: date


def month_start(day: date) -> date:
    """Return the first day of the day's month."""
    return day.replace(day=1)


def quarter_start(day: date) -> date:
    """Return the first day of the day's calendar quarter."""
    return date(day.year, 3 * ((day.month - 1) // 3) + 1, 1)


def day_before(day: date) -> date:
    """Return the day before."""
    return day - timedelta(days=1)


def years_earlier(day: date, years: int) -> date:
    """Return the same calendar day `years` earlier; quarter and year boundaries never fall on 29 February."""
    return day.replace(year=day.year - years)


def week_start(day: date) -> date:
    """Return the Monday of the day's week."""
    return day - timedelta(days=day.weekday())


def last_days(today: date, count: int) -> tuple[date, date]:
    """Return the range of the last `count` days, ending today."""
    return today - timedelta(days=count - 1), today


def quarter_bounds(start: date) -> tuple[date, date]:
    """Return the first and last day of the quarter that starts on `start`."""
    next_start = date(start.year + (start.month + 2) // 12, (start.month + 2) % 12 + 1, 1)
    return start, day_before(next_start)


def named_ranges(today: date) -> dict[str, TimeRange]:
    """Return every named range counted from `today`, by name."""
    this_quarter = quarter_start(today)
    last_quarter = quarter_bounds(quarter_start(day_before(this_quarter)))
    before_last = quarter_bounds(quarter_start(day_before(last_quarter[0])))
    this_month = month_start(today)
    last_month = month_start(day_before(this_month))
    this_week = week_start(today)
    year_start = date(today.year, 1, 1)
    ranges = [
        TimeRange("today", "today", today, today),
        TimeRange("yesterday", "yesterday", day_before(today), day_before(today)),
        TimeRange("this_week", "this week", this_week, today),
        TimeRange("last_week", "last week", this_week - timedelta(days=7), day_before(this_week)),
        TimeRange("this_month", "this month", this_month, today),
        TimeRange("last_month", "last month", last_month, day_before(this_month)),
        TimeRange("this_quarter", "this quarter", this_quarter, today),
        TimeRange("last_quarter", "last quarter", *last_quarter),
        TimeRange("quarter_before_last", "the quarter before last", *before_last),
        TimeRange(
            "last_quarter_a_year_ago",
            "last quarter a year earlier",
            years_earlier(last_quarter[0], 1),
            years_earlier(last_quarter[1], 1),
        ),
        TimeRange("this_year", "this year", year_start, today),
        TimeRange("last_year", "last year", date(today.year - 1, 1, 1), date(today.year - 1, 12, 31)),
        TimeRange("year_before_last", "the year before last", date(today.year - 2, 1, 1), date(today.year - 2, 12, 31)),
        TimeRange("last_7_days", "the last 7 days", *last_days(today, 7)),
        TimeRange("last_30_days", "the last 30 days", *last_days(today, 30)),
        TimeRange("last_90_days", "the last 90 days", *last_days(today, 90)),
        TimeRange("last_12_months", "the last 12 months", *last_days(today, 365)),
    ]
    return {item.name: item for item in ranges}


def range_parameters(today: date) -> dict[str, date]:
    """Return every named range's two ends, and today, as parameters: `last_quarter_start`, `last_quarter_end`, `today`.

    The golden set's reference SQL names these as `$last_quarter_start`, and so on.
    """
    parameters: dict[str, date] = {"today": today}
    for item in named_ranges(today).values():
        parameters[f"{item.name}_start"] = item.start
        parameters[f"{item.name}_end"] = item.end
    return parameters
