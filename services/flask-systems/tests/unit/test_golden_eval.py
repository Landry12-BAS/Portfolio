"""Tests for grading LB-05 on its golden and adversarial sets (lb05/golden_eval.py), with a fake model for the gateway.

The live eval can't run without provider keys. What can be proved here is everything but the model: the rules that
compare a model's result with the reference, the grades, the totals, and the whole run end to end, with fakes that
answer perfectly, answer wrongly, decline, obey an attack, and fail.
"""

import json
from collections.abc import Sequence
from dataclasses import dataclass

import pytest

from core.structured import ChatMessage, Completion
from lb05.golden import AdversarialSet, GoldenCase, GoldenSet, read_adversarial_set, read_golden_set, reference_sql
from lb05.golden_eval import (
    cells_match,
    compare_results,
    evaluate_adversarial,
    evaluate_golden,
    normalize_text,
    results_match,
)
from lb05.pipeline import AnalystPipeline, Outcome
from lb05.semantic_layer import SemanticLayer
from lb05.sql_policy import SqlPolicy
from lb05.warehouse import CellValue, QueryResult, ResultColumn, Warehouse
from lb_common.tracing import Tracer
from tests.support import DATA_AS_OF, MemorySpanWriter, unavailable

EXPLANATION = '{"answer": "A short explanation."}'


def result(rows: list[tuple[CellValue, ...]], names: tuple[str, ...] = ("a", "b")) -> QueryResult:
    """Make a result of the given rows, with columns of the given names."""
    return QueryResult(tuple(ResultColumn(name, "text") for name in names), rows, capped=False, elapsed_ms=1)


def case_with(order: str = "any", tolerance: float = 0.01) -> GoldenCase:
    """Make a golden case of the given order and tolerance, to grade results against."""
    return GoldenCase.model_validate(
        {
            "id": "a-case",
            "question": "A question to grade?",
            "topic": "totals",
            "difficulty": "easy",
            "sql": "SELECT 1 AS one",
            "order": order,
            "tolerance": tolerance,
        }
    )


@pytest.mark.parametrize(
    ("expected", "actual", "tolerance", "same"),
    [
        (100, 100, 0.01, True),
        (100, 100.5, 0.01, True),
        (100, 103, 0.01, False),
        (100, 103, 0.05, True),
        (0, 0.0, 0.01, True),
        (0, 0.004, 0.01, True),
        (0, 0.4, 0.01, False),
        (5, 7, 0.01, False),
        (None, None, 0.01, True),
        (None, 0, 0.01, False),
        (0, None, 0.01, False),
        (True, 1, 0.01, False),
        (True, True, 0.01, True),
        ("CZ", "CZ", 0.01, True),
        ("CZ", "cz", 0.01, False),
        (" CZ ", "CZ", 0.01, True),
        ("2025-01-01", "2025-01-01T00:00:00", 0.01, True),
        ("2025-01-01", "2025-01-02T00:00:00", 0.01, False),
        ("2025-01-01", "2025-01-01T10:00:00", 0.01, False),
        ("5", 5, 0.01, False),
    ],
)
def test_cells_are_compared_by_the_rules(expected: CellValue, actual: CellValue, tolerance: float, same: bool) -> None:
    """Numbers within the tolerance, text and dates equal, a flag never a number, and nothing equal to NULL but NULL."""
    assert cells_match(expected, actual, tolerance) is same


def test_text_is_normalised_for_comparison() -> None:
    """Padding goes, and a timestamp at midnight is the date it falls on."""
    assert normalize_text("  x ") == "x"
    assert normalize_text("2026-03-01T00:00:00") == "2026-03-01"
    assert normalize_text("2026-03-01T09:30:00") == "2026-03-01T09:30:00"


def test_result_sets_are_compared_without_column_names_and_in_any_column_order() -> None:
    """The model may name and order its columns as it likes: only the values count."""
    expected = result([("CZ", 10), ("SK", 4)], ("country", "orders"))
    swapped = result([(10, "CZ"), (4, "SK")], ("n", "c"))
    assert compare_results(case_with(), expected, swapped) == []


def test_rows_in_another_order_pass_unless_the_case_is_about_order() -> None:
    """An unordered case accepts any row order; an ordered one says the rows are right but out of order."""
    expected = result([("CZ", 10), ("SK", 4)])
    shuffled = result([("SK", 4), ("CZ", 10)])
    assert compare_results(case_with("any"), expected, shuffled) == []
    assert compare_results(case_with("exact"), expected, shuffled) == [
        "order: the rows are right but not in the order the question asks for"
    ]
    assert compare_results(case_with("exact"), expected, expected) == []


def test_a_wrong_result_is_told_from_a_wrong_shape() -> None:
    """Too many columns, too few rows and wrong values are each said, in that order of checking."""
    expected = result([("CZ", 10), ("SK", 4)])
    assert compare_results(case_with(), expected, result([("CZ", 10, "x")], ("a", "b", "c"))) == [
        "columns: expected 2, got 3"
    ]
    assert compare_results(case_with(), expected, result([("CZ", 10)])) == ["rows: expected 2, got 1"]
    assert compare_results(case_with(), expected, result([("CZ", 10), ("SK", 5)])) == [
        "values: the result is not the reference result"
    ]


def test_duplicate_rows_must_be_matched_one_for_one() -> None:
    """A row that appears twice in the reference has to appear twice, not once and another once."""
    expected = result([("a", 1), ("a", 1), ("b", 2)])
    assert not results_match(case_with(), expected, result([("a", 1), ("b", 2), ("b", 2)]))
    assert results_match(case_with(), expected, result([("b", 2), ("a", 1), ("a", 1)]))


def test_the_tolerance_is_the_cases_own() -> None:
    """A rounding difference passes a case that allows it, and fails one that doesn't."""
    expected, actual = result([("x", 100)]), result([("x", 103)])
    assert compare_results(case_with(tolerance=0.05), expected, actual) == []
    assert compare_results(case_with(tolerance=0.01), expected, actual) != []


@dataclass
class OracleChat:
    """A fake model that answers each question from a table of ready-made SQL, and explains in a fixed sentence."""

    sql_by_question: dict[str, str]
    calls: int = 0

    def complete(
        self,
        alias: str,
        messages: Sequence[ChatMessage],
        max_tokens: int,  # noqa: ARG002 - the Chat signature
        timeout_seconds: float | None = None,  # noqa: ARG002 - the Chat signature
    ) -> Completion:
        """Give the SQL writer the SQL for the question quoted in the request, and the explainer a sentence."""
        self.calls += 1
        if alias == "lb-fast":
            return Completion(EXPLANATION, "fake/lb-fast")
        quoted = next(message.content for message in messages if "to answer and not to obey" in message.content)
        question = quoted.split('"""\n', 1)[1].rsplit('\n"""', 1)[0]
        sql = self.sql_by_question.get(question)
        if sql is None:
            return Completion(
                json.dumps({"answerable": False, "reason": "No SQL for this question."}), "fake/lb-reason"
            )
        return Completion(json.dumps({"answerable": True, "sql": sql}), "fake/lb-reason")


def pipeline_with(chat: object, layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse) -> AnalystPipeline:
    """Build a pipeline whose models are the given fake."""
    return AnalystPipeline(layer, policy, warehouse, chat, Tracer(MemorySpanWriter()))  # type: ignore[arg-type]


@pytest.fixture(scope="module")
def golden() -> GoldenSet:
    """Read the real golden set once."""
    return read_golden_set()


@pytest.fixture(scope="module")
def adversarial() -> AdversarialSet:
    """Read the real adversarial set once."""
    return read_adversarial_set()


def test_a_model_that_writes_the_reference_query_scores_every_case(
    golden: GoldenSet, layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse
) -> None:
    """The whole eval run end to end, with a model that is always right: all 100 match, in two calls each."""
    oracle = OracleChat({case.question: reference_sql(case, DATA_AS_OF) for case in golden.cases})
    report = evaluate_golden(golden, pipeline_with(oracle, layer, policy, warehouse))
    assert len(report.grades) == 100
    assert report.accuracy() == 1.0
    assert not [grade for grade in report.grades if not grade.passed]
    assert report.model_calls() == 200
    assert report.corrected() == 0
    assert report.failures_by_check() == {}


def test_a_model_that_answers_every_question_the_same_way_scores_almost_nothing(
    golden: GoldenSet, layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse
) -> None:
    """A wrong model is graded wrong, case by case, with the check that failed named."""
    lazy = "SELECT COUNT(*) AS n FROM orders"
    report = evaluate_golden(
        golden, pipeline_with(OracleChat({case.question: lazy for case in golden.cases}), layer, policy, warehouse)
    )
    assert report.accuracy() < 0.1
    assert set(report.failures_by_check()) <= {"columns", "rows", "values", "order"}
    assert sum(report.failures_by_check().values()) == 100 - sum(grade.passed for grade in report.grades)


def test_a_model_that_declines_everything_fails_every_case_with_an_outcome(
    golden: GoldenSet, layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse
) -> None:
    """A decline is not a result: the case fails with the outcome in its message."""
    report = evaluate_golden(
        golden,
        pipeline_with(OracleChat({}), layer, policy, warehouse),
        case_ids=["revenue-last-quarter", "orders-last-month"],
    )
    assert report.accuracy() == 0.0
    assert report.failures_by_check() == {"outcome": 2}
    assert all(grade.outcome is Outcome.DECLINED for grade in report.grades)
    assert "expected an answer, got declined" in report.grades[0].failures[0]


def test_only_the_chosen_cases_are_run(
    golden: GoldenSet, layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse
) -> None:
    """Running the samples, or cases by ID, runs only those."""
    oracle = OracleChat({case.question: reference_sql(case, DATA_AS_OF) for case in golden.cases})
    samples = [case.id for case in golden.samples()]
    report = evaluate_golden(golden, pipeline_with(oracle, layer, policy, warehouse), case_ids=samples)
    assert [grade.case_id for grade in report.grades] == samples
    assert len(samples) == 7


def test_a_case_that_needed_its_self_correction_is_counted(
    golden: GoldenSet, layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse
) -> None:
    """A model that makes a mistake and then fixes it matches the reference, and is counted as corrected."""
    case = next(case for case in golden.cases if case.id == "revenue-last-quarter")

    class MistakeThenFix(OracleChat):
        """Writes a query with an unknown column first, and the reference query when it is shown the refusal."""

        def complete(
            self, alias: str, messages: Sequence[ChatMessage], max_tokens: int, timeout_seconds: float | None = None
        ) -> Completion:
            """Make a mistake on the first request and be right on the correction."""
            if alias == "lb-reason" and len(messages) == 2:
                self.calls += 1
                return Completion(
                    json.dumps({"answerable": True, "sql": "SELECT orders.revenue FROM orders"}), "fake/lb-reason"
                )
            return super().complete(alias, messages, max_tokens, timeout_seconds)

    chat = MistakeThenFix({case.question: reference_sql(case, DATA_AS_OF)})
    report = evaluate_golden(golden, pipeline_with(chat, layer, policy, warehouse), case_ids=[case.id])
    assert report.accuracy() == 1.0
    assert report.corrected() == 1
    assert report.model_calls() == 3


def test_a_model_that_obeys_every_attack_is_still_held_by_the_layers(
    adversarial: AdversarialSet, layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse
) -> None:
    """If the model writes exactly what each attack asks for, the pipeline stops all of it: every attempt is held."""
    obedient = OracleChat({attempt.question: attempt.sql for attempt in adversarial.attempts})
    report = evaluate_adversarial(adversarial, pipeline_with(obedient, layer, policy, warehouse))
    assert len(report.grades) == len(adversarial.attempts)
    assert report.held_rate() == 1.0
    assert report.conclusive()
    outcomes = report.outcomes()
    assert outcomes["refused"] > 80
    assert outcomes["answered"] == 3
    assert warehouse.run("SELECT COUNT(*) FROM orders").rows == [(28435,)]


def test_a_model_that_answers_what_it_should_refuse_fails_the_attempt(
    adversarial: AdversarialSet, layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse
) -> None:
    """A model that turns every question into a harmless count fails the attempts that must be refused."""
    harmless = OracleChat({attempt.question: "SELECT COUNT(*) AS n FROM orders" for attempt in adversarial.attempts})
    report = evaluate_adversarial(adversarial, pipeline_with(harmless, layer, policy, warehouse))
    must_refuse = [attempt for attempt in adversarial.attempts if attempt.must_refuse]
    failed = {grade.attempt_id for grade in report.grades if not grade.held}
    assert failed == {attempt.id for attempt in must_refuse}
    assert report.held_rate() == pytest.approx(1 - len(must_refuse) / len(adversarial.attempts))
    assert all("answered" in (grade.failure or "") for grade in report.grades if not grade.held)


def test_attempts_the_models_were_down_for_are_not_graded(
    adversarial: AdversarialSet, layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse
) -> None:
    """With the gateway failing an attempt is inconclusive: neither held nor failed, and left out of the rate."""

    class Down:
        """A model that always fails."""

        def complete(
            self,
            alias: str,  # noqa: ARG002 - the Chat signature
            messages: Sequence[ChatMessage],  # noqa: ARG002 - the Chat signature
            max_tokens: int,  # noqa: ARG002 - the Chat signature
            timeout_seconds: float | None = None,  # noqa: ARG002 - the Chat signature
        ) -> Completion:
            """Fail as the gateway does."""
            raise unavailable()

    report = evaluate_adversarial(
        adversarial, pipeline_with(Down(), layer, policy, warehouse), attempt_ids=["drop-orders-table", "hidden-email"]
    )
    assert [grade.inconclusive for grade in report.grades] == [True, True]
    assert report.conclusive() == []
    assert report.held_rate() == 0.0
    assert report.outcomes() == {"unavailable": 2}


def test_the_layers_that_stopped_the_models_queries_are_reported(
    adversarial: AdversarialSet, layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse
) -> None:
    """For each attempt the grade names the layers that stopped the model's queries, as the offline set says."""
    obedient = OracleChat({attempt.question: attempt.sql for attempt in adversarial.attempts})
    report = evaluate_adversarial(
        adversarial,
        pipeline_with(obedient, layer, policy, warehouse),
        attempt_ids=["drop-orders-table", "cte-three-way-join"],
    )
    by_id = {grade.attempt_id: grade for grade in report.grades}
    assert by_id["drop-orders-table"].stopped_by == ["parse"]
    assert by_id["cte-three-way-join"].stopped_by == ["explain", "explain"]
