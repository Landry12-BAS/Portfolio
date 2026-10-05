"""`manage.py export_pack_lb02` (`just export-pack-lb02`): write LB-02's eval pack for Eval Lab, or check it.

The planner's pack (evals/packs/lb02-planner.yaml) is built from the production prompt, the tools, the
golden set and the offerings (lb02/pack.py), and the export refuses a pack that renders differently from
what the concierge sends. `--check` only says whether the committed file is up to date (`just check`).
"""

from argparse import ArgumentParser

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from core.data_files import DataFileError
from core.packs import PackMismatchError, packs_directory, render_pack, write_or_check
from lb02.pack import MADE_BY, PACK_NAME, SOURCE, export_pack


class Command(BaseCommand):
    """Writes or checks LB-02's eval pack."""

    help = "Write LB-02's eval pack (evals/packs/lb02-planner.yaml) for Eval Lab; --check only says if it is current."

    def add_arguments(self, parser: ArgumentParser) -> None:
        """Take the one option: check instead of write."""
        parser.add_argument("--check", action="store_true", help="Only say whether the committed pack is up to date.")

    def handle(self, *args: object, **options: object) -> None:
        """Build the pack, then write it or compare it with the committed file."""
        try:
            content = export_pack(settings.SEED_DIR / "lb02")
            path = packs_directory() / f"{PACK_NAME}.yaml"
            text = render_pack(content, MADE_BY, SOURCE)
            self.stdout.write(write_or_check(path, text, options["check"] is True, MADE_BY))
        except (DataFileError, PackMismatchError, ValueError) as error:
            raise CommandError(str(error)) from None
