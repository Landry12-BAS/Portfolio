"""`manage.py eval_lb01` (`just eval-lb01`): run LB-01's golden set through the live pipeline and grade it.

Every case is filed as a synthetic ticket, run through the gateway, graded by the rules
in lb01/golden_eval.py and rolled back. It costs about five gateway calls a case, so run
it when prompts or routes change: `--samples` runs only the curated samples, and
`--case` picks cases by ID. Needs the gateway running with provider keys, and the
database seeded (`just seed`).
"""

from argparse import ArgumentParser

from django.core.management.base import BaseCommand, CommandError

from core.data_files import DataFileError
from lb01.golden import read_golden_set
from lb01.golden_eval import evaluate
from lb01.pipeline import connect_pipeline


class Command(BaseCommand):
    """Grades the live pipeline on the golden set."""

    help = "Run LB-01's golden set through the live pipeline and grade it by rules (about five gateway calls a case)."

    def add_arguments(self, parser: ArgumentParser) -> None:
        """Take the cases to run: all, the curated samples, or chosen IDs."""
        parser.add_argument("--samples", action="store_true", help="Run only the curated samples.")
        parser.add_argument("--case", action="append", default=[], help="Run this case ID; repeat for more.")

    def handle(self, *args: object, **options: object) -> None:
        """Run the chosen cases, then print each failure and the totals."""
        try:
            golden = read_golden_set()
        except DataFileError as error:
            raise CommandError(str(error)) from None
        chosen = [str(case_id) for case_id in options["case"]] if isinstance(options["case"], list) else []
        if options["samples"] is True:
            chosen += [case.id for case in golden.samples()]
        unknown = sorted(set(chosen) - {case.id for case in golden.cases})
        if unknown:
            raise CommandError(f"No golden case has the ID {', '.join(unknown)}.")
        try:
            pipeline = connect_pipeline()
        except (ValueError, OSError) as error:
            raise CommandError(f"Can't reach the gateway: {error}") from None
        report = evaluate(golden, pipeline, case_ids=chosen or None)
        for case_grade in report.grades:
            mark = "pass" if case_grade.passed else "FAIL"
            self.stdout.write(f"{mark}  {case_grade.case_id}")
            for failure in case_grade.failures:
                self.stdout.write(f"      {failure}")
        passed = sum(case_grade.passed for case_grade in report.grades)
        self.stdout.write(f"{passed} of {len(report.grades)} cases passed ({report.pass_rate():.1%}).")
        if report.drafts:
            self.stdout.write(f"{report.supported_drafts} of {report.drafts} drafts passed the claim check.")
        for check, count in report.failures_by_check().most_common():
            self.stdout.write(f"  {check}: {count} failures")
