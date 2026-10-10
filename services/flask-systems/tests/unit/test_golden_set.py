"""Tests for the golden set (evals/lb05/golden.yaml): its reader, and its hundred reference queries on the data."""

import copy
from collections import Counter
from datetime import date
from pathlib import Path
from typing import Any

import pytest
import sqlglot
import yaml

from core.data_files import DataFileError
from lb05.generator import SIZES, generate
from lb05.golden import (
    EVALS_DIRECTORY,
    GOLDEN_SIZE,
    GoldenCase,
    GoldenSet,
    parameters_in,
    read_golden_set,
    reference_sql,
)
from lb05.sql_policy import DIALECT, SqlPolicy
from lb05.warehouse import Warehouse
from lb05.warehouse_build import write_dataset
from tests.support import DATA_AS_OF


@pytest.fixture(scope="module")
def golden() -> GoldenSet:
    """Read the real golden set once."""
    return read_golden_set()


@pytest.fixture(scope="module")
def checked_sql(golden: GoldenSet, policy: SqlPolicy) -> dict[str, str]:
    """Check every reference query once, and return the SQL that runs, by case ID."""
    return {case.id: policy.validate(reference_sql(case, DATA_AS_OF)).sql for case in golden.cases}


def raw_golden() -> dict[str, Any]:
    """Return the golden file as plain data, for a test to break."""
    loaded = yaml.safe_load((EVALS_DIRECTORY / "golden.yaml").read_text(encoding="utf-8"))
    assert isinstance(loaded, dict)
    return loaded


def write_golden(folder: Path, data: dict[str, Any]) -> Path:
    """Write golden data to a folder as golden.yaml, and return the folder."""
    (folder / "golden.yaml").write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    return folder


def test_the_golden_set_has_a_hundred_cases_and_a_few_samples(golden: GoldenSet) -> None:
    """The datasheet's hundred question and answer pairs, and the handful the live demo opens on."""
    assert len(golden.cases) == GOLDEN_SIZE == 100
    assert 4 <= len(golden.samples()) <= 8


def test_the_cases_cover_every_topic_and_difficulty_in_numbers(golden: GoldenSet) -> None:
    """No topic is a token case, and the set is not all easy."""
    topics = Counter(case.topic for case in golden.cases)
    assert len(topics) == 8
    assert min(topics.values()) >= 8
    difficulties = Counter(case.difficulty for case in golden.cases)
    assert difficulties["hard"] >= 10
    assert difficulties["easy"] >= 20


def test_ordered_cases_are_a_minority_with_a_reason(golden: GoldenSet) -> None:
    """Only rankings and series are graded on order, so a correct answer in another order is not marked wrong."""
    exact = [case for case in golden.cases if case.order == "exact"]
    assert 15 <= len(exact) <= 40


def test_the_headline_question_is_in_the_samples(golden: GoldenSet) -> None:
    """The question the datasheet leads with, which coffees lost the most repeat buyers last quarter, opens the demo."""
    samples = {case.id for case in golden.samples()}
    assert "lost-repeat-buyers-last-quarter" in samples


@pytest.mark.parametrize(
    ("change", "complaint"),
    [
        (lambda data: data["cases"].pop(), "100"),
        (lambda data: data["cases"].append(copy.deepcopy(data["cases"][0])), "100"),
        (lambda data: data["cases"][1].update(id=data["cases"][0]["id"]), "ID appears more than once"),
        (
            lambda data: data["cases"][1].update(question=data["cases"][0]["question"].upper()),
            "question appears more than once",
        ),
        (lambda data: data["cases"][1].update(sql="SELECT $next_quarter_start"), "unknown parameters"),
        (lambda data: data["cases"][1].update(topic="astrology"), "topic"),
        (lambda data: data["cases"][1].update(difficulty="impossible"), "difficulty"),
        (lambda data: data["cases"][1].update(surprise=True), "surprise"),
        (lambda data: data["cases"][1].update(question="Too short"), "question"),
        (lambda data: data["cases"][1].update(tolerance=2), "tolerance"),
        (lambda data: [case.update(sample=True) for case in data["cases"][:12]], "curated samples"),
        (lambda data: [case.update(sample=False) for case in data["cases"]], "curated samples"),
        (lambda data: [case.update(topic="totals") for case in data["cases"]], "every topic"),
    ],
    ids=[
        "too-few",
        "too-many",
        "repeated-id",
        "repeated-question",
        "unknown-parameter",
        "unknown-topic",
        "unknown-difficulty",
        "unknown-field",
        "short-question",
        "tolerance-out-of-range",
        "too-many-samples",
        "no-samples",
        "missing-topics",
    ],
)
def test_the_reader_is_strict(tmp_path: Path, change: Any, complaint: str) -> None:
    """A mistake in the file is an error that names it, never a silently smaller or odder set."""
    data = raw_golden()
    change(data)
    with pytest.raises(DataFileError) as stopped:
        read_golden_set(write_golden(tmp_path, data))
    assert complaint in str(stopped.value)


def test_parameters_are_found_by_name() -> None:
    """The date parameters a reference query uses are read from its syntax tree."""
    assert parameters_in("SELECT 1 WHERE d BETWEEN $last_quarter_start AND $last_quarter_end") == {
        "last_quarter_start",
        "last_quarter_end",
    }
    assert parameters_in("SELECT 1") == set()


def test_parameters_become_typed_dates_on_the_tree(golden: GoldenSet) -> None:
    """A parameter is replaced by a date value in the tree, so it can never become part of the query's text."""
    case = next(case for case in golden.cases if case.id == "revenue-last-quarter")
    filled = reference_sql(case, DATA_AS_OF)
    assert "$" not in filled
    assert "CAST('2026-07-01' AS DATE)" in filled
    assert "CAST('2026-09-30' AS DATE)" in filled
    other = reference_sql(case, date(2027, 2, 10))
    assert "CAST('2026-10-01' AS DATE)" in other


def test_every_parameter_a_case_names_is_filled(golden: GoldenSet) -> None:
    """After filling, no case has a placeholder left."""
    for case in golden.cases:
        tree = sqlglot.parse_one(reference_sql(case, DATA_AS_OF), read=DIALECT)
        assert not list(tree.find_all(sqlglot.exp.Placeholder)), case.id


def test_every_reference_query_passes_the_checks_a_visitors_query_does(
    golden: GoldenSet, checked_sql: dict[str, str], warehouse: Warehouse
) -> None:
    """The reference queries are held to the model's checks: the parse-tree check, the plan check and the cap."""
    for case in golden.cases:
        warehouse.explain(checked_sql[case.id])
        result = warehouse.run(checked_sql[case.id])
        assert result.rows, f"{case.id} returns no rows on the test data"
        assert not result.capped, f"{case.id} is cut short by the row cap"
        assert len(result.columns) <= 4, f"{case.id} returns a very wide table"


def test_no_reference_answer_is_all_zeros_or_nulls(
    golden: GoldenSet, checked_sql: dict[str, str], warehouse: Warehouse
) -> None:
    """An answer of nothing would be matched by any wrong query that also returns nothing."""
    for case in golden.cases:
        rows = warehouse.run(checked_sql[case.id]).rows
        assert any(cell not in (None, 0, 0.0) for row in rows for cell in row), case.id


def test_every_reference_query_gives_the_same_answer_twice(
    golden: GoldenSet, checked_sql: dict[str, str], warehouse: Warehouse
) -> None:
    """Rankings and series are ordered completely, so a repeat run gives the same rows in the same order."""
    for case in golden.cases:
        first = warehouse.run(checked_sql[case.id]).rows
        second = warehouse.run(checked_sql[case.id]).rows
        if case.order == "exact":
            assert first == second, case.id
        else:
            assert sorted(map(repr, first)) == sorted(map(repr, second)), case.id


def limit_of(case: GoldenCase) -> int | None:
    """Return the LIMIT a case's reference query asks for, or None."""
    limit = sqlglot.parse_one(case.sql, read=DIALECT).args.get("limit")
    return None if limit is None else int(limit.expression.name)


def test_top_n_cases_have_no_tie_at_the_boundary(golden: GoldenSet, policy: SqlPolicy, warehouse: Warehouse) -> None:
    """A top-five whose fifth and sixth place are tied would have two right answers, so none is in the set."""
    checked_any = False
    for case in golden.cases:
        count = limit_of(case)
        if count is None:
            continue
        tree = sqlglot.parse_one(reference_sql(case, DATA_AS_OF), read=DIALECT)
        tree.set("limit", None)
        rows = warehouse.run(policy.validate(tree.sql(dialect=DIALECT)).sql).rows
        checked_any = True
        if len(rows) > count:
            boundary = rows[count - 1 : count + 1]
            assert boundary[0][1:] != boundary[1][1:], f"{case.id} is tied at {count}"
            assert boundary[0][-1] != boundary[1][-1], f"{case.id} is tied at {count}"
    assert checked_any


def test_exact_order_cases_without_a_limit_have_no_tied_rows(
    golden: GoldenSet, checked_sql: dict[str, str], warehouse: Warehouse
) -> None:
    """In a case graded on order, two rows that tie on every number would have no right order."""
    for case in golden.cases:
        if case.order != "exact" or limit_of(case) is not None:
            continue
        result = warehouse.run(checked_sql[case.id])
        numeric = [index for index, column in enumerate(result.columns) if column.kind in ("integer", "number")]
        for earlier, later in zip(result.rows, result.rows[1:], strict=False):
            tied = bool(numeric) and all(earlier[index] == later[index] for index in numeric) and earlier != later
            assert not tied, f"{case.id}: {earlier} and {later} tie"


def test_the_headline_answer_is_kenya_nyeri(checked_sql: dict[str, str], warehouse: Warehouse) -> None:
    """On the test data, the coffee that lost the most repeat buyers last quarter is Kenya Nyeri, by a clear margin."""
    rows = warehouse.run(checked_sql["lost-repeat-buyers-last-quarter"]).rows
    ranked = sorted(rows, key=lambda row: -int(row[1] or 0))
    assert ranked[0][0] == "Kenya Nyeri"
    assert int(ranked[0][1] or 0) > 1.3 * int(ranked[1][1] or 0)


def test_the_answers_hold_on_another_seed_and_on_a_tiny_dataset(
    golden: GoldenSet, checked_sql: dict[str, str], tmp_path: Path
) -> None:
    """The set does not depend on one lucky dataset: on another seed and size, every reference still returns rows."""
    directory = tmp_path / "other"
    write_dataset(generate(SIZES["tiny"], DATA_AS_OF, 11), directory)
    other = Warehouse.open(directory, "1GB", 1)
    try:
        for case in golden.cases:
            assert other.run(checked_sql[case.id]).rows, case.id
    finally:
        other.close()
