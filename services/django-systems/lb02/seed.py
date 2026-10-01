"""Loads LB-02's synthetic calendar from data/seed/lb02 into the lb02 schema.

The seed file is the source of truth for the rooms, the offerings and their start times.
Seeding makes those tables match it and lays out the calendar: one slot for each start
time on each of the next 14 days, counted from the day it runs (the calendar opens
tomorrow), so a demo never goes stale. Running it twice changes nothing. The file is
checked against the schemas below before anything is written, so a typo stops the seed
with a message naming the file and the field instead of reaching a demo.

Seeding leaves what visitors made alone: a slot that has reservations stays until they
are gone. The nightly reset (`reset_calendar`) is the one that clears the visitors' side:
conversations, holds, bookings and their confirmations go, and the calendar is laid out
afresh.
"""

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from itertools import pairwise
from pathlib import Path
from typing import Annotated, Any, Self

from django.db import models, transaction
from django.db.backends.postgresql.psycopg_any import DateTimeTZRange
from django.db.models import ProtectedError
from pydantic import Field, StringConstraints, model_validator

from core.data_files import Key, StrictEntry, read_data_file
from lb02.limits import CALENDAR_DAYS_AHEAD, MAX_PARTY_SIZE
from lb02.models import ROASTERY_TIME_ZONE, Conversation, Offering, Resource, Slot

# A start time on the roastery's clock, such as 14:30.
ClockTime = Annotated[str, StringConstraints(pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")]
# A room's or an offering's name, and a one-line description.
ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
LongText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]


class SeedError(Exception):
    """The seed file contradicts itself, or seeding would lose a visitor's booking."""


class ShortTranslated(StrictEntry):
    """A name in both of the site's languages."""

    en: ShortText
    cs: ShortText


class LongTranslated(StrictEntry):
    """A description in both of the site's languages."""

    en: LongText
    cs: LongText


class ResourceEntry(StrictEntry):
    """One room, as offerings.yaml writes it."""

    key: Key
    name: ShortTranslated


class OfferingEntry(StrictEntry):
    """One thing a visitor can book, the room it runs in, and the times it starts each day."""

    key: Key
    resource: Key
    title: ShortTranslated
    summary: LongTranslated
    duration_minutes: int = Field(ge=15, le=480)
    capacity: int = Field(ge=1, le=MAX_PARTY_SIZE)
    price_czk: int = Field(ge=0)
    starts: list[ClockTime] = Field(min_length=1)

    @model_validator(mode="after")
    def _check_starts(self) -> Self:
        """Require start times in order with room for the whole session, and a session that ends on its day."""
        minutes = [clock_minutes(start) for start in self.starts]
        for earlier, later in pairwise(minutes):
            if later < earlier + self.duration_minutes:
                raise ValueError(f"{self.key}: a session starting at {format_clock(later)} overlaps the one before it")
        if minutes[-1] + self.duration_minutes >= 24 * 60:
            raise ValueError(f"{self.key}: the last session must end before midnight")
        return self


class CalendarFile(StrictEntry):
    """The whole of offerings.yaml."""

    resources: list[ResourceEntry] = Field(min_length=1)
    offerings: list[OfferingEntry] = Field(min_length=1)

    @model_validator(mode="after")
    def _check_references(self) -> Self:
        """Refuse a repeated key, and an offering in a room the file doesn't have."""
        require_unique([resource.key for resource in self.resources], "resource key")
        require_unique([offering.key for offering in self.offerings], "offering key")
        rooms = {resource.key for resource in self.resources}
        for offering in self.offerings:
            if offering.resource not in rooms:
                raise ValueError(f"offering {offering.key!r} runs in {offering.resource!r}, which isn't a resource")
        return self


def require_unique(values: list[str], what: str) -> None:
    """Raise if any value appears more than once, naming the first repeat."""
    seen: set[str] = set()
    for value in values:
        if value in seen:
            raise ValueError(f"{what} {value!r} appears more than once")
        seen.add(value)


def clock_minutes(clock_time: str) -> int:
    """Turn a start time such as 14:30 into minutes since midnight."""
    hours, minutes = clock_time.split(":")
    return int(hours) * 60 + int(minutes)


def format_clock(minutes: int) -> str:
    """Turn minutes since midnight back into a start time such as 14:30."""
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


@dataclass
class TableChanges:
    """How many rows of one table a seed run created, updated and deleted."""

    created: int = 0
    updated: int = 0
    deleted: int = 0

    def count(self, change: str) -> None:
        """Count one row's change: "created", "updated" or "unchanged"."""
        if change == "created":
            self.created += 1
        elif change == "updated":
            self.updated += 1

    def describe(self) -> str:
        """Put the counts in words, such as "2 created, 1 updated, 0 deleted"."""
        return f"{self.created} created, {self.updated} updated, {self.deleted} deleted"


@dataclass
class SeedReport:
    """What a seed run changed, table by table."""

    resources: TableChanges = field(default_factory=TableChanges)
    offerings: TableChanges = field(default_factory=TableChanges)
    slots: TableChanges = field(default_factory=TableChanges)
    # Slots the calendar no longer lays out that stay, because a reservation still refers to them.
    slots_kept: int = 0
    # Conversations the nightly reset deleted, with their holds and bookings.
    conversations_deleted: int = 0

    def lines(self) -> list[str]:
        """Describe the run, one table per line, for the seed command to print."""
        lines = [
            f"Rooms: {self.resources.describe()}",
            f"Offerings: {self.offerings.describe()}",
            f"Slots: {self.slots.describe()}, {self.slots_kept} kept for their reservations",
        ]
        if self.conversations_deleted:
            lines.append(f"Conversations deleted by the reset: {self.conversations_deleted}")
        return lines


def seed(directory: Path, today: date) -> SeedReport:
    """Check offerings.yaml in `directory`, then make the lb02 calendar match it in one transaction.

    `today` is the day the calendar counts from: its slots run from tomorrow for 14 days.
    A file that doesn't follow its schema raises core.data_files.DataFileError; a file
    that would remove a room or offering visitors have booked raises SeedError.
    """
    calendar = read_data_file(directory / "offerings.yaml", CalendarFile)
    report = SeedReport()
    try:
        with transaction.atomic(using="lb02"):
            room_ids = sync_resources(calendar, report)
            offerings = sync_offerings(calendar, room_ids, report)
            delete_removed(calendar, report)
            sync_slots(calendar, offerings, today, report)
    except ProtectedError:
        raise SeedError(
            "Seeding would remove a room, offering or slot that a visitor's reservation refers to."
        ) from None
    return report


def reset_calendar(directory: Path, today: date) -> SeedReport:
    """Clear everything visitors made, then lay the calendar out afresh from `today`, in one transaction.

    Conversations go with their messages, holds, bookings, confirmations and handoffs.
    """
    with transaction.atomic(using="lb02"):
        conversations = Conversation.objects.all()
        count = conversations.count()
        conversations.delete()
        report = seed(directory, today)
        report.conversations_deleted = count
    return report


def sync_resources(calendar: CalendarFile, report: SeedReport) -> dict[str, int]:
    """Create or update every room in the file, and return each one's row ID by key."""
    room_ids: dict[str, int] = {}
    for entry in calendar.resources:
        change, resource = upsert(Resource, {"key": entry.key}, {"name_en": entry.name.en, "name_cs": entry.name.cs})
        report.resources.count(change)
        room_ids[entry.key] = resource.pk
    return room_ids


def sync_offerings(calendar: CalendarFile, room_ids: Mapping[str, int], report: SeedReport) -> dict[str, Offering]:
    """Create or update every offering in the file, and return each one by key."""
    offerings: dict[str, Offering] = {}
    for position, entry in enumerate(calendar.offerings, start=1):
        change, offering = upsert(
            Offering,
            {"key": entry.key},
            {
                "resource_id": room_ids[entry.resource],
                "position": position,
                "title_en": entry.title.en,
                "title_cs": entry.title.cs,
                "summary_en": entry.summary.en,
                "summary_cs": entry.summary.cs,
                "duration_minutes": entry.duration_minutes,
                "capacity": entry.capacity,
                "price_czk": entry.price_czk,
            },
        )
        report.offerings.count(change)
        offerings[entry.key] = offering
    return offerings


def delete_removed(calendar: CalendarFile, report: SeedReport) -> None:
    """Delete the offerings and rooms the file no longer has, offerings first because they hold the rooms."""
    removed_offerings = Offering.objects.exclude(key__in=[offering.key for offering in calendar.offerings])
    report.offerings.deleted = removed_offerings.count()
    removed_offerings.delete()
    removed_rooms = Resource.objects.exclude(key__in=[resource.key for resource in calendar.resources])
    report.resources.deleted = removed_rooms.count()
    removed_rooms.delete()


def slot_ranges(entry: OfferingEntry, today: date) -> set[tuple[datetime, datetime]]:
    """Return the start and end of every slot the calendar lays out for an offering: its times, tomorrow onward."""
    ranges: set[tuple[datetime, datetime]] = set()
    for day_offset in range(1, CALENDAR_DAYS_AHEAD + 1):
        day = today + timedelta(days=day_offset)
        for start in entry.starts:
            hours, minutes = divmod(clock_minutes(start), 60)
            starts_at = datetime.combine(day, time(hours, minutes), tzinfo=ROASTERY_TIME_ZONE)
            ranges.add((starts_at, starts_at + timedelta(minutes=entry.duration_minutes)))
    return ranges


def sync_slots(calendar: CalendarFile, offerings: Mapping[str, Offering], today: date, report: SeedReport) -> None:
    """Make each offering's slots the ones the calendar lays out, and keep any a reservation still needs."""
    for entry in calendar.offerings:
        offering = offerings[entry.key]
        wanted = slot_ranges(entry, today)
        existing = {(slot.starts_at, slot.ends_at): slot for slot in Slot.objects.filter(offering=offering)}
        missing = [
            Slot(offering=offering, during=DateTimeTZRange(starts_at, ends_at, "[)"))
            for starts_at, ends_at in sorted(wanted - existing.keys())
        ]
        Slot.objects.bulk_create(missing)
        report.slots.created += len(missing)
        leftover = [slot for span, slot in existing.items() if span not in wanted]
        deletable = Slot.objects.filter(pk__in=[slot.pk for slot in leftover], reservations__isnull=True)
        deleted_here = deletable.count()
        deletable.delete()
        report.slots.deleted += deleted_here
        report.slots_kept += len(leftover) - deleted_here


def upsert[Row: models.Model](model: type[Row], lookup: dict[str, Any], values: dict[str, Any]) -> tuple[str, Row]:
    """Create the row, update only the fields that differ, or leave it alone, and say which.

    Returns "created", "updated" or "unchanged", with the row.
    """
    row = model._default_manager.filter(**lookup).first()
    if row is None:
        return "created", model._default_manager.create(**lookup, **values)
    changed = [name for name, value in values.items() if getattr(row, name) != value]
    if not changed:
        return "unchanged", row
    for name in changed:
        setattr(row, name, values[name])
    row.save(update_fields=changed)
    return "updated", row
