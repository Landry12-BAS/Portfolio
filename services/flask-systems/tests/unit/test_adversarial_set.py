"""Tests for the adversarial set (evals/lb05/adversarial.yaml): its reader, and every attempt against the real layers.

The attempts run with no model in the way: each hand-written query goes through the parse-tree
check, the plan check and the locked connection, exactly as the pipeline sends a model's query,
and the layer that stops it must be the one the file names. A second test runs each raw statement
on the bare connection, with every check before it removed, to confirm what the file says about
the connection (and so where the parse-tree layer stands alone).
"""

import copy
import threading
from pathlib import Path
from typing import Any

import duckdb
import pytest
import yaml

from core.data_files import DataFileError
from lb05.golden import (
    EVALS_DIRECTORY,
    MIN_ATTEMPTS,
    AdversarialSet,
    Attempt,
    read_adversarial_set,
    read_golden_set,
)
from lb05.safety import MAX_ROWS, RULE_DETAILS, Layer, Rule, SqlRejectedError
from lb05.sql_policy import SqlPolicy
from lb05.warehouse import Warehouse

# How long a bare statement may run on the connection before the test interrupts it. A statement
# that is still running then was not refused: the connection allowed it to start.
BARE_STATEMENT_SECONDS = 0.4

ATTEMPTS = read_adversarial_set().attempts


@pytest.fixture(scope="module")
def adversarial() -> AdversarialSet:
    """Read the real adversarial set once."""
    return read_adversarial_set()


def layer_that_stops(sql: str, policy: SqlPolicy, warehouse: Warehouse) -> tuple[Layer, Rule]:
    """Send a query through the layers in the pipeline's order, and say which layer stopped it and why.

    A query that is accepted but whose result is cut to the row cap is "stopped" by the row cap.
    A query that nothing stops is an error: the attempt succeeded.
    """
    try:
        checked = policy.validate(sql)
        warehouse.explain(checked.sql)
        result = warehouse.run(checked.sql)
    except SqlRejectedError as stopped:
        return stopped.layer, stopped.rule
    if checked.limit_applied and len(result.rows) == checked.row_limit == MAX_ROWS:
        return Layer.ROW_LIMIT, Rule.ROW_CAP
    raise AssertionError("No layer stopped this query, and the row cap did not cut it.")


def bare_outcome(warehouse: Warehouse, sql: str) -> str:
    """Run a raw statement on a cursor of the locked connection, and say whether the connection refused it.

    A statement still running when the interrupt comes was started, so the connection allowed it.
    """
    cursor = warehouse._connection.cursor()
    timer = threading.Timer(BARE_STATEMENT_SECONDS, cursor.interrupt)
    timer.start()
    try:
        cursor.execute(sql)
        cursor.fetchmany(10)
    except duckdb.InterruptException:
        return "allowed"
    except duckdb.Error:
        return "refused"
    finally:
        timer.cancel()
        cursor.close()
    return "allowed"


def test_the_set_is_large_and_tries_every_kind_of_attack(adversarial: AdversarialSet) -> None:
    """The datasheet's twenty-five attempts is the floor; every category of attack has several."""
    assert len(adversarial.attempts) >= MIN_ATTEMPTS
    by_category: dict[str, int] = {}
    for attempt in adversarial.attempts:
        by_category[attempt.category] = by_category.get(attempt.category, 0) + 1
    assert len(by_category) == 10
    assert min(by_category.values()) >= 4, by_category


def test_the_attempts_are_stopped_by_several_layers(adversarial: AdversarialSet) -> None:
    """Not everything ends at the first layer: the parse, the allowlist, the plan and the row cap each have a share."""
    layers = {attempt.stopped_by for attempt in adversarial.attempts}
    assert {Layer.PARSE, Layer.ALLOWLIST, Layer.EXPLAIN, Layer.ROW_LIMIT} <= layers


def test_the_set_is_honest_about_where_the_connection_stands_alone(adversarial: AdversarialSet) -> None:
    """Some statements the connection alone would carry out, and the set says so instead of hiding it."""
    allowed = [attempt for attempt in adversarial.attempts if attempt.connection == "allowed"]
    refused = [attempt for attempt in adversarial.attempts if attempt.connection == "refused"]
    assert len(allowed) >= 20
    assert len(refused) >= 20
    assert any(attempt.id == "hidden-email" for attempt in allowed)
    assert any(attempt.id == "drop-orders-table" for attempt in refused)


def test_no_attempt_reuses_a_golden_question(adversarial: AdversarialSet) -> None:
    """The two sets are for different jobs, and an attack's words are never a golden question."""
    golden_questions = {case.question.lower() for case in read_golden_set().cases}
    assert not {attempt.question.lower() for attempt in adversarial.attempts} & golden_questions


@pytest.mark.parametrize("attempt", ATTEMPTS, ids=[attempt.id for attempt in ATTEMPTS])
def test_each_attempt_is_stopped_by_the_layer_the_set_names(
    attempt: Attempt, policy: SqlPolicy, warehouse: Warehouse
) -> None:
    """The first layer to stop the attempt, and the rule it applied, are the ones the file says."""
    assert layer_that_stops(attempt.sql, policy, warehouse) == (attempt.stopped_by, attempt.rule)


@pytest.mark.parametrize(
    "attempt",
    [attempt for attempt in ATTEMPTS if attempt.connection != "not_tried"],
    ids=[attempt.id for attempt in ATTEMPTS if attempt.connection != "not_tried"],
)
def test_the_bare_connection_does_what_the_set_says_it_does(attempt: Attempt, warehouse: Warehouse) -> None:
    """With every check before it removed, DuckDB refuses the statement exactly when the set says it does."""
    assert bare_outcome(warehouse, attempt.sql) == attempt.connection


def test_a_destructive_statement_never_changes_the_data(
    policy: SqlPolicy, warehouse: Warehouse, adversarial: AdversarialSet
) -> None:
    """After every attempt has run, the tables hold what they held: nothing was written, dropped or emptied."""
    before = warehouse.run(
        "SELECT (SELECT COUNT(*) FROM customers), (SELECT COUNT(*) FROM orders), (SELECT COUNT(*) FROM products)"
    ).rows
    for attempt in adversarial.attempts:
        if attempt.stopped_by in (Layer.PARSE, Layer.ALLOWLIST):
            continue
        layer_that_stops(attempt.sql, policy, warehouse)
    after = warehouse.run(
        "SELECT (SELECT COUNT(*) FROM customers), (SELECT COUNT(*) FROM orders), (SELECT COUNT(*) FROM products)"
    ).rows
    assert before == after == [(6000, 28435, 12)]


def test_the_hardest_rows_never_leave_with_the_hidden_columns(policy: SqlPolicy, warehouse: Warehouse) -> None:
    """A dump of a whole table is cut to the cap, and carries the layer's columns only."""
    checked = policy.validate("SELECT * FROM customers")
    result = warehouse.run(checked.sql)
    assert len(result.rows) == MAX_ROWS
    assert {column.name for column in result.columns} == {
        "customer_id",
        "country",
        "city",
        "segment",
        "signup_date",
        "acquisition_channel",
    }


def raw_attempts() -> dict[str, Any]:
    """Return the adversarial file as plain data, for a test to break."""
    loaded = yaml.safe_load((EVALS_DIRECTORY / "adversarial.yaml").read_text(encoding="utf-8"))
    assert isinstance(loaded, dict)
    return loaded


@pytest.mark.parametrize(
    ("change", "complaint"),
    [
        (lambda data: data["attempts"][0].update(rule="timeout"), "not applied by the layer"),
        (lambda data: data["attempts"][0].update(stopped_by="explain"), "not applied by the layer"),
        (lambda data: data["attempts"][0].update(category="mischief"), "category"),
        (lambda data: data["attempts"][0].update(connection="maybe"), "connection"),
        (lambda data: data["attempts"][0].update(surprise=1), "surprise"),
        (lambda data: data["attempts"][1].update(id=data["attempts"][0]["id"]), "attempt ID appears more than once"),
        (lambda data: data["attempts"].__setitem__(slice(None), data["attempts"][:10]), "at least"),
        (
            lambda data: data.update(attempts=[a for a in data["attempts"] if a["category"] != "injection"]),
            "every category",
        ),
        (lambda data: data["attempts"][0].update(note="short"), "note"),
    ],
    ids=[
        "rule-in-another-layer",
        "layer-for-the-rule",
        "unknown-category",
        "unknown-connection-outcome",
        "unknown-field",
        "repeated-id",
        "too-few-attempts",
        "missing-category",
        "short-note",
    ],
)
def test_the_reader_is_strict(tmp_path: Path, change: Any, complaint: str) -> None:
    """A mistake in the file is an error that names it."""
    data = copy.deepcopy(raw_attempts())
    change(data)
    (tmp_path / "adversarial.yaml").write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    with pytest.raises(DataFileError) as stopped:
        read_adversarial_set(tmp_path)
    assert complaint in str(stopped.value)


def test_every_rule_an_attempt_names_belongs_to_the_layer_it_names(adversarial: AdversarialSet) -> None:
    """The reader enforces it, and so does this: no attempt claims a layer that does not apply its rule."""
    for attempt in adversarial.attempts:
        assert RULE_DETAILS[attempt.rule][0] == attempt.stopped_by, attempt.id
