"""The warehouse: LB-05's DuckDB database, opened so that it can only be read.

This is the last two of LB-05's layers of SQL safety, and it trusts nothing before it:

- the connection (`connection`): the database file is opened read-only, external access is
  switched off (no file, no network, no ATTACH, COPY, INSTALL or LOAD), memory and threads
  are limited, spilling to disk is off, and the configuration is locked, so no query can
  undo any of it. A write, a file read or a setting change is refused by DuckDB itself.
- the plan (`explain`): the query is planned without being run, and refused when the plan
  holds a cross product or expects more rows than any step may handle.
- the clock (`timeout`): a query that runs past five seconds is interrupted.
- the cap (`row_limit`): no more than 1,000 rows are ever fetched, whatever the SQL says.

Each request works on a cursor of its own, and only a few queries run at once, so a visitor
who sends many questions cannot take the machine's memory or processors from the others.
Nothing here is given visitor text except the SQL that already passed the parse-tree check.
"""

import json
import math
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Literal

import duckdb
from duckdb import DuckDBPyConnection

from lb05.safety import MAX_PLAN_ROWS, MAX_ROWS, STATEMENT_TIMEOUT_SECONDS, Rule, SqlRejectedError
from lb05.semantic_layer import SemanticLayer
from lb05.warehouse_build import DATABASE_FILE, HIDDEN_COLUMNS, TABLES, WarehouseMeta, read_meta

# How many queries may run at once, and how long a request waits for its turn.
MAX_CONCURRENT_QUERIES = 3
SLOT_WAIT_SECONDS = 5.0
# What a table cell or a column name may hold when it leaves the service.
MAX_CELL_CHARS = 200
MAX_COLUMN_NAME_CHARS = 60
# Integers beyond this can't be read exactly by JavaScript, so they travel as text.
MAX_SAFE_INTEGER = 2**53
# Plan nodes that join without an equality: a join on a condition that isn't one, or on none.
CROSS_JOIN_OPERATORS = frozenset(
    {"CROSS_PRODUCT", "BLOCKWISE_NL_JOIN", "NESTED_LOOP_JOIN", "PIECEWISE_MERGE_JOIN", "IE_JOIN"}
)
INTEGER_TYPES = frozenset(
    {"TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT", "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT", "UHUGEINT"}
)
NUMBER_TYPES = frozenset({"DOUBLE", "FLOAT", "REAL"})
DATE_TYPES = frozenset({"DATE", "TIMESTAMP", "TIMESTAMP WITH TIME ZONE", "TIMESTAMP_S", "TIMESTAMP_MS", "TIMESTAMP_NS"})
# Settings that must be in force for the connection to count as locked down.
LOCKDOWN_SETTINGS = {"enable_external_access": "false", "lock_configuration": "true"}

type CellValue = str | int | float | bool | None
type ColumnKind = Literal["text", "integer", "number", "date", "boolean", "other"]


class WarehouseError(Exception):
    """The warehouse can't be used: it is missing, doesn't match the semantic layer, or isn't locked down."""


class WarehouseBusyError(Exception):
    """Too many queries are running; the request waited its turn and none came."""


@dataclass(frozen=True)
class ResultColumn:
    """One column of a result: its name, and a kind the page can draw it by."""

    name: str
    kind: ColumnKind


@dataclass(frozen=True)
class QueryResult:
    """What a query returned: columns, rows, whether the row cap cut it short, and how long it took."""

    columns: tuple[ResultColumn, ...]
    rows: list[tuple[CellValue, ...]]
    capped: bool
    elapsed_ms: int


@dataclass(frozen=True)
class PlanReport:
    """What the plan check found: the operators in the plan and the most rows any step expects."""

    operators: tuple[str, ...]
    max_estimated_rows: int


def short_message(error: BaseException) -> str:
    """Take the first line of a DuckDB error, without the query's line and caret, as one short sentence."""
    first = str(error).strip().splitlines()[0] if str(error).strip() else type(error).__name__
    cleaned = "".join(character if character.isprintable() else " " for character in first)
    for marker in (" LINE ", "\tCandidate"):
        cleaned = cleaned.split(marker)[0]
    cleaned = " ".join(cleaned.split())
    return cleaned if len(cleaned) <= 240 else cleaned[:239] + "…"


def translate_error(error: duckdb.Error) -> SqlRejectedError:
    """Turn a DuckDB error into the refusal that names which layer and rule it belongs to."""
    detail = short_message(error)
    if isinstance(error, duckdb.InterruptException):
        return SqlRejectedError(
            Rule.TIMEOUT, f"The query ran longer than {STATEMENT_TIMEOUT_SECONDS:g} seconds and was stopped."
        )
    if isinstance(error, duckdb.OutOfMemoryException):
        return SqlRejectedError(
            Rule.OUT_OF_MEMORY, "The query needs more memory than a question may use; filter or group it."
        )
    if (
        isinstance(error, duckdb.PermissionException)
        or "read-only" in detail
        or "configuration has been locked" in detail
    ):
        return SqlRejectedError(Rule.CONNECTION_REFUSED, f"The database refused it: {detail}")
    if isinstance(error, duckdb.BinderException | duckdb.CatalogException | duckdb.ParserException):
        return SqlRejectedError(Rule.BINDER_ERROR, f"The database couldn't plan the query: {detail}")
    return SqlRejectedError(Rule.RUNTIME_ERROR, f"The database couldn't run the query: {detail}")


def column_kind(type_name: str) -> ColumnKind:
    """Say what a DuckDB type is for the page: text, an integer, a number, a date or a flag."""
    base = type_name.split("(")[0].strip().upper()
    if base in INTEGER_TYPES:
        return "integer"
    if base in NUMBER_TYPES or base == "DECIMAL":
        return "number"
    if base in DATE_TYPES:
        return "date"
    if base == "BOOLEAN":
        return "boolean"
    return "text" if base == "VARCHAR" else "other"


def cell_value(value: object) -> CellValue:
    """Make one result value safe to send as JSON: exact numbers, ISO dates, and text of a bounded length."""
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value if abs(value) < MAX_SAFE_INTEGER else str(value)
    if isinstance(value, float | Decimal):
        number = float(value)
        return number if math.isfinite(number) else None
    if isinstance(value, datetime):
        return value.isoformat(timespec="seconds")
    if isinstance(value, date):
        return value.isoformat()
    return str(value)[:MAX_CELL_CHARS]


def plan_nodes(nodes: object) -> Iterator[dict[str, object]]:
    """Yield every node of a DuckDB JSON plan, parents before children."""
    if isinstance(nodes, list):
        for node in nodes:
            yield from plan_nodes(node)
    elif isinstance(nodes, dict):
        yield nodes
        yield from plan_nodes(nodes.get("children"))


def estimated_rows(node: dict[str, object]) -> int:
    """Read the number of rows a plan node expects to produce, or 0 when it doesn't say."""
    info = node.get("extra_info")
    value = info.get("Estimated Cardinality") if isinstance(info, dict) else None
    text = str(value).lstrip("~") if value is not None else ""
    return int(text) if text.isdigit() else 0


def read_plan(plan_json: str) -> PlanReport:
    """Read the operators and the largest row estimate out of DuckDB's JSON plan."""
    nodes = list(plan_nodes(json.loads(plan_json)))
    return PlanReport(
        operators=tuple(sorted({str(node.get("name", "")) for node in nodes})),
        max_estimated_rows=max((estimated_rows(node) for node in nodes), default=0),
    )


def check_plan(report: PlanReport) -> None:
    """Refuse a plan that joins without an equality, or that expects more rows than any step may handle."""
    if CROSS_JOIN_OPERATORS & set(report.operators):
        raise SqlRejectedError(
            Rule.CROSS_PRODUCT,
            "The plan joins tables without an equality, which multiplies their rows; join on the declared keys.",
        )
    if report.max_estimated_rows > MAX_PLAN_ROWS:
        raise SqlRejectedError(
            Rule.PLAN_TOO_LARGE,
            f"The plan expects {report.max_estimated_rows:,} rows at one step; filter or group before joining.",
        )


def open_connection(path: Path, memory_limit: str, threads: int) -> DuckDBPyConnection:
    """Open the DuckDB file read-only, shut off from files and the network, and lock its configuration."""
    config: dict[str, str | bool | int | float | list[str]] = {
        "memory_limit": memory_limit,
        "threads": threads,
        "enable_external_access": False,
        "autoinstall_known_extensions": False,
        "autoload_known_extensions": False,
        "allow_community_extensions": False,
        "allow_unsigned_extensions": False,
        # No spilling to disk: a query that needs more memory than its limit fails instead.
        "max_temp_directory_size": "0B",
    }
    try:
        connection = duckdb.connect(str(path), read_only=True, config=config)
    except duckdb.Error as error:
        raise WarehouseError(f"The warehouse at {path} can't be opened: {short_message(error)}") from None
    if not is_configuration_locked(connection):
        connection.execute("SET lock_configuration = true")
    return connection


def is_configuration_locked(connection: DuckDBPyConnection) -> bool:
    """Tell whether the database's configuration is already locked.

    DuckDB shares one database between every connection a process opens to the same file, and
    that database stays locked, so a second open must not try to lock it again. `verify_lockdown`
    still proves the lock before anything is served.
    """
    row = connection.execute("SELECT value FROM duckdb_settings() WHERE name = 'lock_configuration'").fetchone()
    return row is not None and str(row[0]).lower() == "true"


def verify_lockdown(connection: DuckDBPyConnection) -> None:
    """Check that the connection really is read-only and locked, and refuse to serve if it is not."""
    settings = dict(
        connection.execute(
            "SELECT name, value FROM duckdb_settings() WHERE name IN ('enable_external_access', 'lock_configuration')"
        ).fetchall()
    )
    for name, wanted in LOCKDOWN_SETTINGS.items():
        if str(settings.get(name)).lower() != wanted:
            raise WarehouseError(f"The connection is not locked down: {name} is {settings.get(name)}.")
    readonly = connection.execute(
        "SELECT readonly FROM duckdb_databases() WHERE database_name = current_database()"
    ).fetchone()
    if readonly is None or readonly[0] is not True:
        raise WarehouseError("The connection is not read-only.")


class Warehouse:
    """The locked-down DuckDB database one process queries, shared by every request thread."""

    def __init__(self, connection: DuckDBPyConnection, meta: WarehouseMeta) -> None:
        """Serve queries on `connection`, which must already be locked down (see `open`)."""
        self._connection = connection
        self.meta = meta
        self._slots = threading.BoundedSemaphore(MAX_CONCURRENT_QUERIES)

    @classmethod
    def open(cls, directory: Path, memory_limit: str, threads: int) -> "Warehouse":
        """Open the dataset in `directory` (what `just seed-lb05` writes) and verify it is locked down."""
        meta = read_meta(directory)
        connection = open_connection(directory / DATABASE_FILE, memory_limit, threads)
        verify_lockdown(connection)
        return cls(connection, meta)

    def close(self) -> None:
        """Close the database."""
        self._connection.close()

    def check_matches(self, layer: SemanticLayer) -> None:
        """Check that the database holds exactly what the semantic layer describes, or raise WarehouseError.

        Every table and column of the layer must exist with a matching type, and the only
        extra columns allowed are the ones deliberately left out of the layer.
        """
        rows = self._connection.execute(
            "SELECT table_name, column_name, data_type FROM information_schema.columns"
        ).fetchall()
        found = {(str(table), str(column)): str(kind) for table, column, kind in rows}
        if {table for table, _ in found} != set(TABLES):
            raise WarehouseError("The database's tables aren't the ones the semantic layer expects.")
        wanted = {
            (table, column): kind for table, columns in layer.column_types().items() for column, kind in columns.items()
        }
        for key, kind in wanted.items():
            if key not in found or column_kind(found[key]) != kind:
                raise WarehouseError(f"The column {key[0]}.{key[1]} isn't in the database as the semantic layer says.")
        undeclared = set(found) - set(wanted) - HIDDEN_COLUMNS
        if undeclared:
            raise WarehouseError("The database has columns the semantic layer doesn't know and doesn't hide.")

    @contextmanager
    def slot(self) -> Iterator[None]:
        """Take one of the few places for running a query, waiting a little for one, or raise WarehouseBusyError."""
        if not self._slots.acquire(timeout=SLOT_WAIT_SECONDS):
            raise WarehouseBusyError("Too many questions are running at once.")
        try:
            yield
        finally:
            self._slots.release()

    def explain(self, sql: str) -> PlanReport:
        """Plan a query without running it, and refuse a plan with a cross product or an enormous step.

        This also binds the query, so a column or function the database doesn't know is
        found here, cheaply, and its message is what the model gets to correct itself with.
        """
        cursor = self._connection.cursor()
        try:
            rows = cursor.execute("EXPLAIN (FORMAT JSON) " + sql).fetchall()
        except duckdb.Error as error:
            raise translate_error(error) from None
        finally:
            cursor.close()
        report = read_plan(str(rows[0][1]))
        check_plan(report)
        return report

    def run(
        self, sql: str, max_rows: int = MAX_ROWS, timeout_seconds: float = STATEMENT_TIMEOUT_SECONDS
    ) -> QueryResult:
        """Run a query on its own cursor, fetching at most `max_rows` rows and stopping it after `timeout_seconds`."""
        with self.slot():
            return self.run_in_slot(sql, max_rows, timeout_seconds)

    def run_in_slot(self, sql: str, max_rows: int, timeout_seconds: float) -> QueryResult:
        """Run a query once a place for it is held: the interrupt timer, the fetch, and the cleanup."""
        cursor = self._connection.cursor()
        timer = threading.Timer(timeout_seconds, interrupt, args=(cursor,))
        started = time.perf_counter()
        timer.start()
        try:
            cursor.execute(sql)
            description = cursor.description
            fetched = cursor.fetchmany(max_rows + 1)
        except duckdb.Error as error:
            raise translate_error(error) from None
        finally:
            timer.cancel()
            cursor.close()
        capped = len(fetched) > max_rows
        columns = tuple(
            ResultColumn(str(item[0])[:MAX_COLUMN_NAME_CHARS], column_kind(str(item[1]))) for item in description
        )
        rows = [tuple(cell_value(value) for value in row) for row in fetched[:max_rows]]
        return QueryResult(columns, rows, capped, round((time.perf_counter() - started) * 1000))


def interrupt(cursor: DuckDBPyConnection) -> None:
    """Stop the query a cursor is running, when the timer says time is up; a cursor already closed is left alone."""
    with suppress(duckdb.Error):
        cursor.interrupt()
