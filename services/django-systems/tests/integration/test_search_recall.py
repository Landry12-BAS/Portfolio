"""The retrieval gate: search's recall on the golden set may not fall below evals/lb01/search-baseline.yaml.

The seed loads the recorded passage vectors, and the eval uses the recorded golden-set
vectors, so the gate measures hybrid search in CI without calling a provider. Until
`just embed` has recorded them, it measures keyword search alone, and requires the
baseline to leave hybrid unset.
"""

from datetime import date

import pytest
from django.conf import settings

from lb01.golden import read_golden_set
from lb01.search_eval import (
    DRAFT_DEPTH,
    QUERY_SOURCES,
    RERANK_DEPTH,
    Recall,
    RecallReport,
    measure,
    read_baseline,
    read_query_vectors,
)
from lb01.seed import seed

pytestmark = [pytest.mark.integration, pytest.mark.django_db(databases=["lb01"])]


def below_gate(report: RecallReport, gate: Recall) -> list[str]:
    """Describe each depth at which a search falls below its gate, naming the cases it misses."""
    problems: list[str] = []
    for depth, floor in ((DRAFT_DEPTH, gate.recall_at_4), (RERANK_DEPTH, gate.recall_at_8)):
        measured = report.recall_at(depth)
        if measured < floor:
            misses = ", ".join(case.case_id for case in report.misses_at(depth))
            problems.append(
                f"{report.source} {report.mode} recall at {depth} is {measured:.3f}, below the gate's {floor:.3f}; "
                f"it misses {misses}"
            )
    return problems


def test_search_recall_holds_the_gate() -> None:
    """Every measured search is at or above its gate, and the gate covers exactly what can be measured."""
    seed(settings.SEED_DIR / "lb01", date(2026, 10, 1))
    reports = measure(read_golden_set(), read_query_vectors())
    baseline = read_baseline()

    problems: list[str] = []
    for source in QUERY_SOURCES:
        gate = baseline.for_source(source)
        by_mode = {report.mode: report for report in reports if report.source == source}
        problems += below_gate(by_mode["keyword"], gate.keyword)
        hybrid = by_mode.get("hybrid")
        if hybrid is None and gate.hybrid is not None:
            problems.append(f"{source} hybrid has a gate, but no recorded vectors to measure it: run `just embed`")
        elif hybrid is not None and gate.hybrid is None:
            measured = hybrid.as_recall()
            problems.append(
                f"{source} hybrid now measures {measured.recall_at_4} / {measured.recall_at_8}: "
                "add it to evals/lb01/search-baseline.yaml"
            )
        elif hybrid is not None and gate.hybrid is not None:
            problems += below_gate(hybrid, gate.hybrid)

    assert not problems, "\n".join(problems)
