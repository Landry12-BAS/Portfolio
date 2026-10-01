"""`manage.py seed_lb02`: load LB-02's synthetic rooms, offerings and calendar."""

from argparse import ArgumentParser
from datetime import date
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from core.data_files import DataFileError
from lb02.booking import local_day
from lb02.seed import SeedError, reset_calendar, seed


class Command(BaseCommand):
    """Makes the lb02 tables match data/seed/lb02, leaving visitors' reservations alone unless asked to reset."""

    help = "Load LB-02's synthetic rooms, offerings and 14-day calendar from data/seed/lb02."

    def add_arguments(self, parser: ArgumentParser) -> None:
        """Take the data folder, the day the calendar counts from, and whether to clear the visitors' side first."""
        parser.add_argument(
            "--data",
            type=Path,
            default=None,
            help="The folder with offerings.yaml (default: data/seed/lb02).",
        )
        parser.add_argument(
            "--today",
            type=date.fromisoformat,
            default=None,
            help="The day the calendar counts from, as YYYY-MM-DD: slots start the day after (default: today).",
        )
        parser.add_argument(
            "--reset",
            action="store_true",
            help="First delete every conversation with its holds and bookings, as the nightly reset does.",
        )

    def handle(self, *args: object, **options: object) -> None:
        """Seed, then print what changed, table by table."""
        data = options["data"] if isinstance(options["data"], Path) else settings.SEED_DIR / "lb02"
        today = options["today"] if isinstance(options["today"], date) else local_day(timezone.now())
        run = reset_calendar if options["reset"] is True else seed
        try:
            report = run(data, today)
        except (DataFileError, SeedError) as error:
            raise CommandError(str(error)) from None
        for line in report.lines():
            self.stdout.write(line)
        self.stdout.write(self.style.SUCCESS(f"Seeded LB-02 from {data}, with the calendar counted from {today}."))
