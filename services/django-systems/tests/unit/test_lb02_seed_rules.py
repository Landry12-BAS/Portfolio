"""Tests for LB-02's seed file rules: the file follows its schema, and a calendar that can't work is refused."""

import re
from copy import deepcopy
from datetime import date, timedelta
from typing import Any

import pytest
from django.conf import settings
from pydantic import ValidationError

from core.data_files import read_data_file
from lb02.limits import CALENDAR_DAYS_AHEAD, MAX_PARTY_SIZE
from lb02.models import ROASTERY_TIME_ZONE
from lb02.seed import CalendarFile, OfferingEntry, slot_ranges

TODAY = date(2026, 10, 1)


@pytest.fixture(scope="module")
def calendar() -> CalendarFile:
    """Read the real seed file once for the module."""
    return read_data_file(settings.SEED_DIR / "lb02" / "offerings.yaml", CalendarFile)


def valid_document(calendar: CalendarFile) -> dict[str, Any]:
    """Return the real seed file as plain data, for a test to break one rule of."""
    return deepcopy(calendar.model_dump())


def test_the_seed_file_has_the_datasheets_three_offerings(calendar: CalendarFile) -> None:
    """A tasting, a cupping session and a roasting workshop, each with a room, a duration and a capacity."""
    offerings = {offering.key: offering for offering in calendar.offerings}

    assert list(offerings) == ["tasting", "cupping", "roasting-workshop"]
    assert [(o.duration_minutes, o.capacity) for o in offerings.values()] == [(45, 6), (60, 8), (120, 10)]
    assert all(o.capacity <= MAX_PARTY_SIZE for o in offerings.values())


def test_two_offerings_share_a_room_and_their_times_overlap_there(calendar: CalendarFile) -> None:
    """The cupping at 11:30 overlaps the tasting at 12:00 in the same room, so the room-scoped constraint matters."""
    rooms = {offering.key: offering.resource for offering in calendar.offerings}
    tasting = next(o for o in calendar.offerings if o.key == "tasting")
    cupping = next(o for o in calendar.offerings if o.key == "cupping")

    assert rooms["tasting"] == rooms["cupping"] != rooms["roasting-workshop"]
    tasting_starts = {start: start for start in tasting.starts}
    assert "12:00" in tasting_starts
    assert "11:30" in cupping.starts


def test_every_offering_has_a_session_on_every_day_of_the_calendar(calendar: CalendarFile) -> None:
    """The calendar lays out 14 days from tomorrow, so a visitor can ask for any day and find something."""
    expected = {TODAY + timedelta(days=offset) for offset in range(1, CALENDAR_DAYS_AHEAD + 1)}
    for entry in calendar.offerings:
        days = {start.astimezone(ROASTERY_TIME_ZONE).date() for start, _ in slot_ranges(entry, TODAY)}
        assert days == expected, entry.key


def test_slots_are_laid_out_in_the_roasterys_own_time_zone(calendar: CalendarFile) -> None:
    """A 10:00 session is at 10:00 in Prague, so 08:00 UTC in summer time and 09:00 UTC in winter time."""
    entry = next(o for o in calendar.offerings if o.key == "tasting")

    summer = sorted(slot_ranges(entry, date(2026, 10, 1)))[0][0]
    winter = sorted(slot_ranges(entry, date(2026, 11, 30)))[0][0]

    assert (summer.astimezone(ROASTERY_TIME_ZONE).hour, summer.utcoffset()) == (10, timedelta(hours=2))
    assert (winter.astimezone(ROASTERY_TIME_ZONE).hour, winter.utcoffset()) == (10, timedelta(hours=1))


def test_the_calendar_starts_tomorrow_and_covers_two_weeks(calendar: CalendarFile) -> None:
    """The first slot is on the day after `today`, and the last one 14 days on."""
    entry = next(o for o in calendar.offerings if o.key == "roasting-workshop")
    starts = sorted(start for start, _ in slot_ranges(entry, TODAY))

    assert starts[0].date() == TODAY + timedelta(days=1)
    assert starts[-1].date() == TODAY + timedelta(days=CALENDAR_DAYS_AHEAD)
    assert len(starts) == len(entry.starts) * CALENDAR_DAYS_AHEAD


def mutated(calendar: CalendarFile, change: Any) -> dict[str, Any]:
    """Return the real seed file as data after `change` has edited it."""
    document = valid_document(calendar)
    change(document)
    return document


@pytest.mark.parametrize(
    ("change", "problem"),
    [
        (lambda d: d["offerings"][0].update(starts=["10:00", "10:30"]), "overlaps the one before it"),
        (lambda d: d["offerings"][0].update(starts=["23:30"]), "must end before midnight"),
        (lambda d: d["offerings"][0].update(starts=[]), "at least 1 item"),
        (lambda d: d["offerings"][0].update(starts=["25:00"]), "String should match pattern"),
        (lambda d: d["offerings"][0].update(resource="the-garage"), "which isn't a resource"),
        (lambda d: d["offerings"][1].update(key="tasting"), "offering key 'tasting' appears more than once"),
        (lambda d: d["resources"][1].update(key="tasting-room"), "resource key 'tasting-room' appears more than once"),
        (lambda d: d["offerings"][0].update(capacity=MAX_PARTY_SIZE + 1), "less than or equal to"),
        (lambda d: d["offerings"][0].update(capacity=0), "greater than or equal to 1"),
        (lambda d: d["offerings"][0].update(duration_minutes=5), "greater than or equal to 15"),
        (lambda d: d["offerings"][0].update(price_czk=-1), "greater than or equal to 0"),
        (lambda d: d["offerings"][0].update(surprise="field"), "Extra inputs are not permitted"),
        (lambda d: d["offerings"][0]["title"].update(cs=""), "at least 1 character"),
    ],
)
def test_a_calendar_that_cant_work_is_refused(calendar: CalendarFile, change: Any, problem: str) -> None:
    """Overlapping sessions, a session past midnight, an unknown room and out-of-range numbers all stop the seed."""
    with pytest.raises(ValidationError, match=re.escape(problem)):
        CalendarFile.model_validate(mutated(calendar, change))


def test_starts_must_leave_room_for_the_whole_session() -> None:
    """A 60-minute session can't be followed by one 45 minutes later."""
    with pytest.raises(ValidationError, match="overlaps the one before it"):
        OfferingEntry.model_validate(
            {
                "key": "cupping",
                "resource": "tasting-room",
                "title": {"en": "Cupping", "cs": "Cupping"},
                "summary": {"en": "A cupping.", "cs": "Cupping."},
                "duration_minutes": 60,
                "capacity": 8,
                "price_czk": 450,
                "starts": ["10:00", "10:45"],
            }
        )
