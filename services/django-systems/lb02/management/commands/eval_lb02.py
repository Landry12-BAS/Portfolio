"""`manage.py eval_lb02` (`just eval-lb02`): run LB-02's golden set through the live concierge and grade it.

Every case is played turn by turn through the gateway as synthetic data, on a clock the eval holds, graded by
the rules in lb02/golden_eval.py and rolled back. It costs about eight gateway calls a case, a full run at most
247, so run it when prompts or routes change: `--samples` runs only the curated samples (39 calls at most), and
`--case` picks cases by ID. Needs the gateway running with provider keys, and the calendar seeded (`just seed`).

The command fails unless every case passes, so it can gate a change. `--min-pass-rate` loosens that, for a
live model that is allowed an occasional miss.
"""

from argparse import ArgumentParser

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from core.data_files import DataFileError
from lb02.booking import SilentNotifier
from lb02.concierge import connect_concierge
from lb02.golden import read_golden_set
from lb02.golden_eval import EvalClock, EvalSetupError, evaluate


class Command(BaseCommand):
    """Grades the live concierge on the golden set."""

    help = "Run LB-02's golden set through the live concierge and grade it by rules (about eight gateway calls a case)."

    def add_arguments(self, parser: ArgumentParser) -> None:
        """Take the cases to run (all, the curated samples, or chosen IDs) and the pass rate the run must reach."""
        parser.add_argument("--samples", action="store_true", help="Run only the curated samples.")
        parser.add_argument("--case", action="append", default=[], help="Run this case ID; repeat for more.")
        parser.add_argument(
            "--min-pass-rate",
            type=float,
            default=1.0,
            help="Fail when fewer than this share of the cases pass (0 to 1; the default is all of them).",
        )

    def handle(self, *args: object, **options: object) -> None:
        """Run the chosen cases, then print each failure, the totals and what the conversations cost."""
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
        minimum = options["min_pass_rate"]
        if not isinstance(minimum, float) or not 0 <= minimum <= 1:
            raise CommandError("--min-pass-rate is a share from 0 to 1.")
        clock = EvalClock(timezone.now())
        try:
            concierge = connect_concierge(clock=clock, notifier=SilentNotifier())
        except (ValueError, OSError) as error:
            raise CommandError(f"Can't reach the gateway: {error}") from None
        try:
            report = evaluate(golden, concierge, clock, case_ids=chosen or None)
        except EvalSetupError as error:
            raise CommandError(f"{error} Run `just seed` first.") from None
        for grade in report.grades:
            self.stdout.write(f"{'pass' if grade.passed else 'FAIL'}  {grade.case_id}  ({grade.calls} calls)")
            for failure in grade.failures:
                self.stdout.write(f"      {failure}")
        passed = sum(grade.passed for grade in report.grades)
        self.stdout.write(f"{passed} of {len(report.grades)} cases passed ({report.pass_rate():.1%}).")
        self.stdout.write(f"{report.total_calls()} gateway calls in all.")
        cost = report.calls_per_booking()
        if cost is not None:
            fewest, most, mean = cost
            self.stdout.write(f"A booking took {fewest} to {most} calls, {mean:.1f} on average.")
        for check, count in report.failures_by_check().most_common():
            self.stdout.write(f"  {check}: {count} failures")
        if report.pass_rate() < minimum:
            raise CommandError(f"{report.pass_rate():.1%} of the cases passed; the run must reach {minimum:.1%}.")
