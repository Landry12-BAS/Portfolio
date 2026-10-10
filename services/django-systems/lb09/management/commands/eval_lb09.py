"""`manage.py eval_lb09` (`just eval-lb09`): run LB-09's golden set through the live pipeline and grade it.

Each scripted meeting is fed to the pipeline as the transcript a transcriber would give (one segment a turn,
timed by the committed audio's manifest), as synthetic data; the labelling, extraction and alignment run live
through the gateway, and the result is graded by the rules in lb09/golden_eval.py against the gate in
evals/lb09/golden.yaml. It costs two chat calls a case, plus a repair for an answer that doesn't validate, so
run it when prompts or routes change: `--samples` runs only the curated samples, `--case` picks cases by ID.
The transcriber is not measured here: `just wer-lb09` does that, on the audio.
"""

from argparse import ArgumentParser

from django.core.management.base import BaseCommand, CommandError

from core.data_files import DataFileError
from lb09.evaluation import evaluate_pipeline
from lb09.golden import read_golden_set
from lb09.pipeline import connect_pipeline
from lb09.scripts import read_scripts
from lb09.tts import read_manifest


class Command(BaseCommand):
    """Grades the live pipeline on the golden set."""

    help = "Run LB-09's golden set through the live pipeline and grade it by rules (two to four gateway calls a case)."

    def add_arguments(self, parser: ArgumentParser) -> None:
        """Take the cases to run: all, the curated samples, or chosen IDs."""
        parser.add_argument("--samples", action="store_true", help="Run only the curated samples.")
        parser.add_argument("--case", action="append", default=[], help="Run this case ID; repeat for more.")

    def handle(self, *args: object, **options: object) -> None:
        """Run the chosen cases, then print each case's problems and the totals against the gate."""
        try:
            golden = read_golden_set()
            scripts = read_scripts()
            manifest = read_manifest()
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
        report = evaluate_pipeline(golden, scripts, pipeline, manifest, chosen or None)
        for grade in report.grades:
            mark = "ok  " if grade.clean and not grade.problems else "FAIL"
            self.stdout.write(f"{mark}  {grade.case_id}: {grade.matched} of {grade.expected} expected items found")
            for problem in grade.problems:
                self.stdout.write(f"      {problem}")
        self.stdout.write(
            f"recall {report.recall:.2f}  precision {report.precision:.2f}  owner {report.owner:.2f}  "
            f"deadline {report.deadline:.2f}  span {report.span:.2f}  labels {report.labels:.2f}  "
            f"evidence {report.evidence:.2f}"
        )
        failures = report.failures(golden)
        if failures:
            raise CommandError("Under the gate:\n- " + "\n- ".join(failures))
        self.stdout.write(f"{len(report.grades)} cases pass the gate.")
