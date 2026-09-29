"""`manage.py seed_lb01`: load LB-01's synthetic policies, customers and orders."""

from argparse import ArgumentParser
from datetime import date
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from lb01.seed import SeedError, seed


class Command(BaseCommand):
    """Makes the lb01 tables match data/seed/lb01, leaving visitor tickets alone."""

    help = "Load LB-01's synthetic policies, customers and orders from data/seed/lb01."

    def add_arguments(self, parser: ArgumentParser) -> None:
        """Take the data folder and the day that relative order dates count from."""
        parser.add_argument(
            "--data",
            type=Path,
            default=None,
            help="The folder with policies.yaml, customers.yaml and orders.yaml (default: data/seed/lb01).",
        )
        parser.add_argument(
            "--today",
            type=date.fromisoformat,
            default=None,
            help="The day relative order dates count from, as YYYY-MM-DD (default: today, in UTC).",
        )

    def handle(self, *args: object, **options: object) -> None:
        """Seed, then print what changed, table by table."""
        data = options["data"] if isinstance(options["data"], Path) else settings.SEED_DIR / "lb01"
        today = options["today"] if isinstance(options["today"], date) else timezone.localdate()
        try:
            report = seed(data, today)
        except SeedError as error:
            raise CommandError(str(error)) from None
        for line in report.lines():
            self.stdout.write(line)
        self.stdout.write(self.style.SUCCESS(f"Seeded LB-01 from {data}, with order dates counted from {today}."))
