"""`manage.py export_packs_lb01` (`just export-packs-lb01`): write LB-01's eval packs for Eval Lab, or check them.

The classifier's and the drafter's packs (evals/packs/lb01-*.yaml) are built from the production prompts,
the golden set and the seed files (lb01/pack.py), and the export refuses a pack that renders differently
from what the pipeline sends. `--check` only says whether the committed files are up to date, which is
what `just check` runs.
"""

from argparse import ArgumentParser

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from core.data_files import DataFileError
from core.packs import PackMismatchError, packs_directory, render_pack, write_or_check
from lb01.pack import MADE_BY, SOURCE, export_packs


class Command(BaseCommand):
    """Writes or checks LB-01's eval packs."""

    help = (
        "Write LB-01's eval packs (evals/packs/lb01-*.yaml) for Eval Lab, or with --check say whether they are current."
    )

    def add_arguments(self, parser: ArgumentParser) -> None:
        """Take the one option: check instead of write."""
        parser.add_argument("--check", action="store_true", help="Only say whether the committed packs are up to date.")

    def handle(self, *args: object, **options: object) -> None:
        """Build both packs, then write each or compare it with the committed file."""
        check = options["check"] is True
        try:
            packs = export_packs(settings.SEED_DIR / "lb01")
        except (DataFileError, PackMismatchError, ValueError) as error:
            raise CommandError(f"The packs can't be built: {error}") from None
        for name, content in packs.items():
            path = packs_directory() / f"{name}.yaml"
            try:
                self.stdout.write(write_or_check(path, render_pack(content, MADE_BY, SOURCE), check, MADE_BY))
            except PackMismatchError as error:
                raise CommandError(str(error)) from None
