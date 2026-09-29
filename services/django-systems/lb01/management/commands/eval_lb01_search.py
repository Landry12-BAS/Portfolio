"""`manage.py eval_lb01_search` (`just eval-search`): measure search's recall on the golden set.

Runs against the database `just seed` filled, and prints recall at 4 and at 8 for each
query source and search mode, next to the gate in evals/lb01/search-baseline.yaml, then
the cases each search misses. The same measurement gates CI
(tests/integration/test_search_recall.py).
"""

from django.core.management.base import BaseCommand, CommandError

from core.data_files import DataFileError
from lb01.golden import read_golden_set
from lb01.search_eval import (
    DRAFT_DEPTH,
    RERANK_DEPTH,
    Recall,
    RecallReport,
    measure,
    read_baseline,
    read_query_vectors,
)


def describe(recall: Recall | None) -> str:
    """Write a pair of recall numbers as `0.912 / 0.971`, or `unset`."""
    return "unset" if recall is None else f"{recall.recall_at_4:.3f} / {recall.recall_at_8:.3f}"


class Command(BaseCommand):
    """Prints search's recall on the golden set, and what it misses."""

    help = "Measure LB-01's search recall on the golden set, against the gate in evals/lb01/search-baseline.yaml."

    def handle(self, *args: object, **options: object) -> None:
        """Measure every query source and search mode that can run, and print the results."""
        try:
            golden = read_golden_set()
            baseline = read_baseline()
            reports = measure(golden, read_query_vectors())
        except DataFileError as error:
            raise CommandError(str(error)) from None
        cases = len(reports[0].cases) if reports else 0
        self.stdout.write(f"Search recall on the golden set, {cases} cases (at {DRAFT_DEPTH} / at {RERANK_DEPTH}):")
        for report in reports:
            gate = baseline.for_source(report.source)
            gate_recall = gate.keyword if report.mode == "keyword" else gate.hybrid
            self.stdout.write(
                f"  {report.source:<6} {report.mode:<7}  {describe(report.as_recall())}   gate {describe(gate_recall)}"
            )
        if not any(report.mode == "hybrid" for report in reports):
            self.stdout.write("  Hybrid search needs recorded vectors: run `just embed`, then `just seed`.")
        for report in reports:
            self.write_misses(report)

    def write_misses(self, report: RecallReport) -> None:
        """List the cases one search misses within the draft's depth, with what it found instead."""
        misses = report.misses_at(DRAFT_DEPTH)
        if not misses:
            return
        self.stdout.write(f"Missed at {DRAFT_DEPTH} by {report.source} {report.mode}:")
        for miss in misses:
            found = ", ".join(miss.ranked[:DRAFT_DEPTH]) or "nothing"
            self.stdout.write(f"  {miss.case_id}: expected {', '.join(miss.expected)}; found {found}")
