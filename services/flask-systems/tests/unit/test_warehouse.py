"""Tests for the warehouse (lb05/warehouse.py): the locked connection, plan check, timeout, row cap and slots."""

import inspect
import json
import shutil
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path

import duckdb
import pytest

from lb05 import warehouse as warehouse_module
from lb05.safety import MAX_PLAN_ROWS, MAX_ROWS, STATEMENT_TIMEOUT_SECONDS, Layer, Rule, SqlRejectedError
from lb05.semantic_layer import ColumnSpec, SemanticLayer
from lb05.warehouse import (
    MAX_CELL_CHARS,
    MAX_CONCURRENT_QUERIES,
    PlanReport,
    Warehouse,
    WarehouseBusyError,
    WarehouseError,
    cell_value,
    check_plan,
    column_kind,
    open_connection,
    read_plan,
    short_message,
    translate_error,
    verify_lockdown,
)
from lb05.warehouse_build import DATABASE_FILE

# Joins two copies of the orders on a column with six values: a hundred billion pairs on this data.
HEAVY_JOIN = (
    "WITH a AS (SELECT ship_country AS k FROM orders), b AS (SELECT ship_country AS k FROM orders) "
    "SELECT COUNT(*) AS n FROM a JOIN b ON a.k = b.k"
)


def refusal(callable_: object, *arguments: object) -> SqlRejectedError:
    """Call something that must refuse, and return the refusal."""
    assert callable(callable_)
    with pytest.raises(SqlRejectedError) as stopped:
        callable_(*arguments)
    return stopped.value


def test_the_datasheet_limits_are_the_defaults() -> None:
    """The five second timeout and the 1,000 row cap are what a query gets unless a caller asks otherwise."""
    parameters = inspect.signature(Warehouse.run).parameters
    assert parameters["timeout_seconds"].default == STATEMENT_TIMEOUT_SECONDS == 5.0
    assert parameters["max_rows"].default == MAX_ROWS == 1_000


def test_it_opens_read_only_and_locked(warehouse: Warehouse) -> None:
    """The service's own connection is read-only, shut off from files and the network, and locked."""
    verify_lockdown(warehouse._connection)
    settings = dict(
        warehouse._connection.execute(
            "SELECT name, value FROM duckdb_settings() "
            "WHERE name IN ('enable_external_access', 'lock_configuration', 'threads')"
        ).fetchall()
    )
    assert settings["enable_external_access"] == "false"
    assert settings["lock_configuration"] == "true"
    assert settings["threads"] == "2"


def test_a_connection_that_is_not_locked_down_is_refused(small_data: Path, tmp_path: Path) -> None:
    """The service refuses to serve through a connection missing any of its protections."""
    copy = tmp_path / "copy"
    shutil.copytree(small_data, copy)
    unlocked = duckdb.connect(str(copy / DATABASE_FILE), read_only=True)
    try:
        with pytest.raises(WarehouseError, match="not locked down"):
            verify_lockdown(unlocked)
    finally:
        unlocked.close()
    writable = tmp_path / "writable"
    shutil.copytree(small_data, writable)
    locked_but_writable = duckdb.connect(str(writable / DATABASE_FILE), config={"enable_external_access": False})
    try:
        locked_but_writable.execute("SET lock_configuration = true")
        with pytest.raises(WarehouseError, match="not read-only"):
            verify_lockdown(locked_but_writable)
    finally:
        locked_but_writable.close()


def test_a_missing_database_is_a_clear_error(tmp_path: Path) -> None:
    """A folder with no DuckDB file is reported by name."""
    with pytest.raises(WarehouseError, match="can't be opened"):
        open_connection(tmp_path / "missing.duckdb", "1GB", 1)


@pytest.mark.parametrize(
    "sql",
    [
        "DROP TABLE orders",
        "DELETE FROM orders",
        "UPDATE products SET price_czk = 1",
        "INSERT INTO customers (customer_id) VALUES (1)",
        "CREATE TABLE stolen AS SELECT * FROM customers",
        "COPY customers TO '/tmp/lb05-test-customers.csv'",
        "ATTACH '/tmp/lb05-test-other.db' AS other",
        "SET enable_external_access = true",
        "SET memory_limit = '100GB'",
        "SELECT * FROM read_csv('/etc/passwd')",
        "SELECT * FROM read_text('/proc/self/environ')",
        "INSTALL httpfs",
        "LOAD httpfs",
    ],
)
def test_the_connection_refuses_writes_files_and_settings_by_itself(warehouse: Warehouse, sql: str) -> None:
    """With every check before it removed, the connection alone refuses writes, file reads and setting changes."""
    stopped = refusal(warehouse.run, sql)
    assert (stopped.layer, stopped.rule) == (Layer.CONNECTION, Rule.CONNECTION_REFUSED)
    assert stopped.retryable is False
    assert not list(Path(tempfile.gettempdir()).glob("lb05-test-*"))


def test_a_query_runs_and_comes_back_typed(warehouse: Warehouse) -> None:
    """A result has named, typed columns and plain values."""
    result = warehouse.run(
        "SELECT status, COUNT(*) AS n, ROUND(AVG(total_czk), 1) AS average, MIN(ordered_at) AS first FROM orders "
        "GROUP BY status ORDER BY n DESC LIMIT 2"
    )
    assert [(column.name, column.kind) for column in result.columns] == [
        ("status", "text"),
        ("n", "integer"),
        ("average", "number"),
        ("first", "date"),
    ]
    assert result.rows[0][0] == "delivered"
    assert isinstance(result.rows[0][2], float)
    assert isinstance(result.rows[0][3], str)
    assert result.capped is False
    assert result.elapsed_ms >= 0


def test_the_row_cap_holds_without_a_limit_in_the_sql(warehouse: Warehouse) -> None:
    """Even a query with no LIMIT returns at most 1,000 rows, and says that it was cut short."""
    result = warehouse.run("SELECT order_id FROM orders")
    assert len(result.rows) == MAX_ROWS
    assert result.capped is True


def test_a_result_of_exactly_the_cap_is_not_called_cut_short(warehouse: Warehouse) -> None:
    """Whether the cap cut a result is told by one row more than it, not guessed."""
    result = warehouse.run("SELECT order_id FROM orders LIMIT 1000")
    assert len(result.rows) == MAX_ROWS
    assert result.capped is False


def test_a_smaller_cap_can_be_asked_for(warehouse: Warehouse) -> None:
    """The cap is a parameter, so a caller may ask for fewer rows."""
    result = warehouse.run("SELECT order_id FROM orders", max_rows=7)
    assert len(result.rows) == 7
    assert result.capped is True


def test_a_slow_query_is_interrupted_and_the_connection_stays_usable(warehouse: Warehouse) -> None:
    """A query that runs past its time is stopped by an interrupt, and the next query runs normally."""
    stopped = refusal(warehouse.run, HEAVY_JOIN, MAX_ROWS, 0.05)
    assert (stopped.layer, stopped.rule) == (Layer.TIMEOUT, Rule.TIMEOUT)
    assert stopped.retryable is True
    assert "seconds" in stopped.message
    assert warehouse.run("SELECT COUNT(*) FROM customers").rows == [(6000,)]


def test_a_query_that_needs_more_memory_than_its_limit_fails_instead_of_spilling(
    small_data: Path, tmp_path: Path
) -> None:
    """With a tiny memory limit and no temporary files, a grouping over the whole table runs out of memory."""
    copy = tmp_path / "small-copy"
    shutil.copytree(small_data, copy)
    squeezed = Warehouse.open(copy, "1MB", 1)
    try:
        stopped = refusal(
            squeezed.run, "SELECT customer_id, COUNT(*) FROM orders GROUP BY customer_id ORDER BY 2 DESC LIMIT 3"
        )
    finally:
        squeezed.close()
    assert (stopped.layer, stopped.rule) == (Layer.CONNECTION, Rule.OUT_OF_MEMORY)
    assert stopped.retryable is True


def test_the_plan_check_refuses_a_cross_product_before_it_runs(warehouse: Warehouse) -> None:
    """A plan that joins without an equality is refused by EXPLAIN alone: nothing is executed."""
    stopped = refusal(warehouse.explain, "SELECT COUNT(*) FROM orders, customers")
    assert (stopped.layer, stopped.rule) == (Layer.EXPLAIN, Rule.CROSS_PRODUCT)


def test_the_plan_check_refuses_an_inequality_join_and_a_loop_in_a_loop(warehouse: Warehouse) -> None:
    """Joins on an inequality only, and a subquery that scans a table for every row, are joins without an equality."""
    inequality = (
        "SELECT COUNT(*) FROM orders AS a JOIN orders AS b ON a.total_czk < b.total_czk AND a.ordered_at > b.ordered_at"
    )
    assert refusal(warehouse.explain, inequality).rule == Rule.CROSS_PRODUCT
    loop = "SELECT (SELECT COUNT(*) FROM orders AS p WHERE p.ordered_at < o.ordered_at) FROM orders AS o"
    assert refusal(warehouse.explain, loop).rule == Rule.CROSS_PRODUCT


def test_the_plan_check_refuses_a_step_that_expects_too_many_rows(warehouse: Warehouse) -> None:
    """A join between two WITH queries on a column with few values is sized from the plan, and refused."""
    stopped = refusal(warehouse.explain, HEAVY_JOIN)
    assert (stopped.layer, stopped.rule) == (Layer.EXPLAIN, Rule.PLAN_TOO_LARGE)
    assert "rows at one step" in stopped.message


def test_the_plan_check_passes_a_sensible_join_and_reports_it(warehouse: Warehouse) -> None:
    """A join on a key plans as a hash join, with an estimate near the size of the tables."""
    report = warehouse.explain("SELECT COUNT(*) FROM orders AS o JOIN order_lines AS l ON l.order_id = o.order_id")
    assert "HASH_JOIN" in report.operators
    assert 0 < report.max_estimated_rows < MAX_PLAN_ROWS


def test_the_plan_check_also_finds_what_the_database_cannot_bind(warehouse: Warehouse) -> None:
    """A column that does not exist is found while planning, with the database's own message for the model."""
    stopped = refusal(warehouse.explain, "SELECT nothing FROM orders")
    assert (stopped.layer, stopped.rule, stopped.retryable) == (Layer.EXPLAIN, Rule.BINDER_ERROR, True)
    assert "nothing" in stopped.message


def test_a_runtime_error_is_a_mistake_to_correct(warehouse: Warehouse) -> None:
    """A query that fails while running (a bad cast) is a retryable error of the connection layer."""
    stopped = refusal(warehouse.run, "SELECT CAST(status AS INTEGER) FROM orders")
    assert (stopped.layer, stopped.rule, stopped.retryable) == (Layer.CONNECTION, Rule.RUNTIME_ERROR, True)


def test_only_a_few_queries_run_at_once(warehouse: Warehouse, monkeypatch: pytest.MonkeyPatch) -> None:
    """When every place is taken, the next request waits a little and is then told the warehouse is busy."""
    monkeypatch.setattr(warehouse_module, "SLOT_WAIT_SECONDS", 0.05)
    with warehouse.slot(), warehouse.slot(), warehouse.slot():
        with pytest.raises(WarehouseBusyError):
            warehouse.run("SELECT 1")
        with pytest.raises(WarehouseBusyError), warehouse.slot():
            pass
    assert MAX_CONCURRENT_QUERIES == 3
    assert warehouse.run("SELECT 1").rows == [(1,)]


def test_a_place_is_given_back_when_a_query_fails(warehouse: Warehouse) -> None:
    """Failing queries release their place, so a run of mistakes can't use up the warehouse."""
    for _ in range(MAX_CONCURRENT_QUERIES + 2):
        refusal(warehouse.run, "SELECT nothing FROM orders")
    assert warehouse.run("SELECT 1").rows == [(1,)]


def test_many_threads_share_the_warehouse(warehouse: Warehouse) -> None:
    """Request threads each work on a cursor of their own, so concurrent queries all get their own right answers."""
    expected = warehouse.run("SELECT status, COUNT(*) FROM orders GROUP BY status ORDER BY 1").rows

    def ask(_: int) -> list[tuple[object, ...]]:
        """Run the same grouping from a worker thread."""
        return list(warehouse.run("SELECT status, COUNT(*) FROM orders GROUP BY status ORDER BY 1").rows)

    with ThreadPoolExecutor(max_workers=8) as pool:
        answers = list(pool.map(ask, range(24)))
    assert all(answer == expected for answer in answers)
    assert threading.active_count() < 20


def layer_with_columns(layer: SemanticLayer, table: str, columns: list[ColumnSpec]) -> SemanticLayer:
    """Return a copy of the layer in which one table lists the given columns."""
    tables = [spec.model_copy(update={"columns": columns}) if spec.name == table else spec for spec in layer.tables]
    return layer.model_copy(update={"tables": tables})


def test_the_database_matches_the_layer_and_a_mismatch_is_found(layer: SemanticLayer, warehouse: Warehouse) -> None:
    """The startup check passes for the real layer, and fails for a layer that asks for what the data lacks."""
    warehouse.check_matches(layer)
    customers = layer.table("customers").columns
    nickname = ColumnSpec(name="nickname", type="text", description="A nickname.")
    extra = layer_with_columns(layer, "customers", [*customers, nickname])
    with pytest.raises(WarehouseError, match=r"customers\.nickname"):
        warehouse.check_matches(extra)
    retyped = [
        column.model_copy(update={"type": "text"}) if column.name == "signup_date" else column for column in customers
    ]
    with pytest.raises(WarehouseError, match=r"customers\.signup_date"):
        warehouse.check_matches(layer_with_columns(layer, "customers", retyped))


def test_a_column_the_layer_leaves_out_without_hiding_it_is_found(layer: SemanticLayer, warehouse: Warehouse) -> None:
    """Only the two deliberately hidden columns may be missing from the layer; another would be hidden by accident."""
    without_city = [column for column in layer.table("customers").columns if column.name != "city"]
    with pytest.raises(WarehouseError, match="doesn't know"):
        warehouse.check_matches(layer_with_columns(layer, "customers", without_city))


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, None),
        (True, True),
        (7, 7),
        (2**60, str(2**60)),
        (-(2**60), str(-(2**60))),
        (1.5, 1.5),
        (Decimal("1.50"), 1.5),
        (float("nan"), None),
        (float("inf"), None),
        (date(2026, 1, 2), "2026-01-02"),
        (datetime(2026, 1, 2, 3, 4, 5, 678, tzinfo=UTC), "2026-01-02T03:04:05+00:00"),
        ("plain", "plain"),
    ],
)
def test_cells_are_made_safe_for_json(value: object, expected: object) -> None:
    """Numbers stay exact, big integers travel as text, dates are ISO, and NaN and infinity become NULL."""
    assert cell_value(value) == expected


def test_long_text_is_cut_to_a_bounded_length() -> None:
    """A text cell never carries more than 200 characters out of the service."""
    assert cell_value("x" * 1_000) == "x" * MAX_CELL_CHARS


@pytest.mark.parametrize(
    ("type_name", "kind"),
    [
        ("BIGINT", "integer"),
        ("UTINYINT", "integer"),
        ("HUGEINT", "integer"),
        ("DOUBLE", "number"),
        ("DECIMAL(18,3)", "number"),
        ("DATE", "date"),
        ("TIMESTAMP", "date"),
        ("BOOLEAN", "boolean"),
        ("VARCHAR", "text"),
        ("BLOB", "other"),
        ("STRUCT(a INTEGER)", "other"),
        ("INTEGER[]", "other"),
    ],
)
def test_column_kinds(type_name: str, kind: str) -> None:
    """Each DuckDB type is a kind the page can draw: text, integer, number, date or flag."""
    assert column_kind(type_name) == kind


def test_database_messages_are_made_short_and_one_line() -> None:
    """The first line only, without the query's own text, control characters or a very long tail."""
    message = (
        'Binder Error: Referenced column "nothing" not found in FROM clause!\n'
        'Candidate bindings: "a", "b"\nLINE 1: SELECT nothing'
    )
    assert (
        short_message(duckdb.BinderException(message))
        == 'Binder Error: Referenced column "nothing" not found in FROM clause!'
    )
    assert short_message(duckdb.Error("Error: it failed LINE 1: SELECT secret")) == "Error: it failed"
    assert short_message(duckdb.Error("a\x07b")) == "a b"
    assert short_message(RuntimeError()) == "RuntimeError"
    assert len(short_message(duckdb.Error("x" * 1_000))) == 240


@pytest.mark.parametrize(
    ("error", "layer", "rule"),
    [
        (duckdb.InterruptException("INTERRUPT Error: Interrupted!"), Layer.TIMEOUT, Rule.TIMEOUT),
        (duckdb.OutOfMemoryException("Out of Memory Error: could not allocate"), Layer.CONNECTION, Rule.OUT_OF_MEMORY),
        (
            duckdb.PermissionException("Permission Error: file system operations are disabled"),
            Layer.CONNECTION,
            Rule.CONNECTION_REFUSED,
        ),
        (
            duckdb.InvalidInputException(
                "Cannot execute statement of type DROP on a database attached in read-only mode!"
            ),
            Layer.CONNECTION,
            Rule.CONNECTION_REFUSED,
        ),
        (
            duckdb.InvalidInputException("Cannot change configuration option - the configuration has been locked"),
            Layer.CONNECTION,
            Rule.CONNECTION_REFUSED,
        ),
        (duckdb.BinderException("Binder Error: nothing"), Layer.EXPLAIN, Rule.BINDER_ERROR),
        (duckdb.CatalogException("Catalog Error: nothing"), Layer.EXPLAIN, Rule.BINDER_ERROR),
        (duckdb.ParserException("Parser Error: nothing"), Layer.EXPLAIN, Rule.BINDER_ERROR),
        (duckdb.ConversionException("Conversion Error: nothing"), Layer.CONNECTION, Rule.RUNTIME_ERROR),
        (duckdb.Error("something else"), Layer.CONNECTION, Rule.RUNTIME_ERROR),
    ],
)
def test_database_errors_become_refusals_that_name_their_layer(error: duckdb.Error, layer: Layer, rule: Rule) -> None:
    """Whatever DuckDB says, the visitor and the trace get a layer and a rule."""
    translated = translate_error(error)
    assert (translated.layer, translated.rule) == (layer, rule)


def plan_json(*nodes: dict[str, object]) -> str:
    """Make the JSON DuckDB's EXPLAIN gives, from nodes that each hold their children."""
    return json.dumps(list(nodes))


def test_the_plan_is_read_for_its_operators_and_its_largest_estimate() -> None:
    """The report names the operators in the whole tree and the biggest row estimate in it."""
    plan = plan_json(
        {
            "name": "PROJECTION",
            "extra_info": {"Estimated Cardinality": "10"},
            "children": [
                {
                    "name": "HASH_JOIN",
                    "extra_info": {"Estimated Cardinality": "~5000"},
                    "children": [
                        {"name": "SEQ_SCAN", "extra_info": {"Estimated Cardinality": "28435"}, "children": []}
                    ],
                }
            ],
        }
    )
    report = read_plan(plan)
    assert report.operators == ("HASH_JOIN", "PROJECTION", "SEQ_SCAN")
    assert report.max_estimated_rows == 28435


def test_a_plan_without_estimates_is_read_as_zero() -> None:
    """A node that gives no estimate counts for nothing, and an odd value is ignored."""
    report = read_plan(
        plan_json(
            {
                "name": "X",
                "extra_info": "text",
                "children": [{"name": "Y", "extra_info": {"Estimated Cardinality": "n/a"}}],
            }
        )
    )
    assert report.max_estimated_rows == 0


def test_check_plan_applies_both_rules() -> None:
    """A cross product is refused, and so is a step with more rows than the plan limit."""
    check_plan(PlanReport(("HASH_JOIN",), MAX_PLAN_ROWS))
    assert refusal(check_plan, PlanReport(("CROSS_PRODUCT",), 1)).rule == Rule.CROSS_PRODUCT
    assert refusal(check_plan, PlanReport(("IE_JOIN",), 1)).rule == Rule.CROSS_PRODUCT
    assert refusal(check_plan, PlanReport(("HASH_JOIN",), MAX_PLAN_ROWS + 1)).rule == Rule.PLAN_TOO_LARGE


def test_closing_the_warehouse_stops_queries(small_data: Path, tmp_path: Path) -> None:
    """After close(), a query is an error, not a silent success."""
    copy = tmp_path / "closing"
    shutil.copytree(small_data, copy)
    closing = Warehouse.open(copy, "1GB", 1)
    closing.close()
    with pytest.raises(duckdb.Error):
        closing.run("SELECT 1")
