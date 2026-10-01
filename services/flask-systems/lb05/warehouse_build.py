"""Writes a generated dataset to disk: Parquet files, and the DuckDB file the service queries read-only.

`just seed-lb05` ends here. The Parquet files are the dataset (portable, compressed, and
what an analyst would load anywhere); the DuckDB file is built from them with every table
copied in. The service opens that file read-only with no file access at all. Views over the
Parquet files would have forced the connection to be allowed to read their folder, and a
query that slipped past the SQL check could then read it; a database file needs no such
permission, so the connection can be shut completely (lb05/warehouse.py).

Everything is written to a staging folder and swapped into place, so a service that starts
while the data is being rebuilt sees either the old data or the new, never half of it.
"""

import json
import shutil
from datetime import date
from pathlib import Path

import duckdb
from duckdb import ColumnExpression, ConstantExpression, DuckDBPyConnection, DuckDBPyRelation, FunctionExpression
from pydantic import BaseModel, ConfigDict, ValidationError

from lb05.generator import GENERATOR_VERSION, NULL_WHEN_ZERO, Column, Columns, Dataset, TextColumn

DATABASE_FILE = "lb05.duckdb"
META_FILE = "meta.json"
# The tables, in the order they are written. Names come from here only, never from input.
TABLES = ("customers", "products", "orders", "order_lines", "subscriptions")
# Columns the data holds that the semantic layer leaves out: invisible to the model, unreadable by SQL.
HIDDEN_COLUMNS = frozenset({("customers", "email"), ("orders", "payment_reference")})


class WarehouseMetaError(Exception):
    """The folder has no usable dataset: its meta.json is missing, malformed or from another generator."""


class WarehouseMeta(BaseModel):
    """What meta.json records: when the data is as-of, how it was made, and its digest."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    generator_version: int
    as_of: date
    seed: int
    size: str
    rows: dict[str, int]
    digest: str


def read_meta(directory: Path) -> WarehouseMeta:
    """Read a dataset folder's meta.json, refusing a folder that has none or that an older generator wrote."""
    try:
        meta = WarehouseMeta.model_validate_json((directory / META_FILE).read_text(encoding="utf-8"))
    except OSError:
        raise WarehouseMetaError(f"There is no dataset in {directory}: run `just seed-lb05`.") from None
    except ValidationError:
        raise WarehouseMetaError(f"{directory / META_FILE} is malformed: run `just seed-lb05` again.") from None
    if meta.generator_version != GENERATOR_VERSION:
        raise WarehouseMetaError(f"The dataset in {directory} is from another generator version: run `just seed-lb05`.")
    return meta


def column_expression(name: str, column: Column, null_when_zero: bool) -> duckdb.Expression:
    """Say how a column is written: text looked up by code, dates as DATE, the zero sentinel as NULL, else as is."""
    expression = ColumnExpression(name)
    if isinstance(column, TextColumn):
        # List positions start at 1 in DuckDB, and a position past the end of the list (or a None name) gives NULL.
        position = expression + ConstantExpression(1)
        expression = FunctionExpression("list_extract", ConstantExpression(list(column.names)), position)
    elif column.dtype.kind == "M":
        expression = expression.cast(duckdb.sqltypes.DATE)
    elif null_when_zero:
        expression = FunctionExpression("nullif", expression, ConstantExpression(0))
    return expression.alias(name)


def typed_relation(connection: DuckDBPyConnection, table: str, columns: Columns) -> DuckDBPyRelation:
    """Turn a table's NumPy columns into a DuckDB relation with the right column types."""
    # Text travels as its integer codes, which DuckDB reads quickly; `column_expression` looks the text up again.
    data = {  # noqa: F841 - DuckDB finds the columns through this local name
        name: column.codes if isinstance(column, TextColumn) else column for name, column in columns.items()
    }
    relation = connection.sql("SELECT * FROM data")
    expressions = [
        column_expression(name, column, name in NULL_WHEN_ZERO.get(table, ())) for name, column in columns.items()
    ]
    return relation.project(*expressions)


def write_parquet(dataset: Dataset, directory: Path) -> None:
    """Write every table of the dataset as a compressed Parquet file."""
    with duckdb.connect() as connection:
        for table in TABLES:
            typed_relation(connection, table, dataset.tables[table]).write_parquet(
                str(directory / f"{table}.parquet"), compression="zstd"
            )


def build_database(directory: Path) -> None:
    """Build the DuckDB file from the Parquet files beside it, one table each."""
    with duckdb.connect(str(directory / DATABASE_FILE)) as connection:
        for table in TABLES:
            connection.read_parquet(str(directory / f"{table}.parquet")).create(table)


def write_meta(dataset: Dataset, directory: Path) -> None:
    """Record the dataset's as-of day, seed, size, row counts and digest."""
    meta = WarehouseMeta(
        generator_version=GENERATOR_VERSION,
        as_of=dataset.as_of,
        seed=dataset.seed,
        size=dataset.size.name,
        rows=dataset.row_counts(),
        digest=dataset.digest,
    )
    (directory / META_FILE).write_text(json.dumps(meta.model_dump(mode="json"), indent=2) + "\n", encoding="utf-8")


def write_dataset(dataset: Dataset, directory: Path) -> WarehouseMeta:
    """Write the dataset to `directory`, replacing what is there, and return what was recorded.

    The files are built in a staging folder next to `directory` and renamed into place.
    """
    directory.parent.mkdir(parents=True, exist_ok=True)
    staging = directory.parent / f".{directory.name}.building"
    previous = directory.parent / f".{directory.name}.previous"
    for leftover in (staging, previous):
        shutil.rmtree(leftover, ignore_errors=True)
    staging.mkdir()
    try:
        write_parquet(dataset, staging)
        build_database(staging)
        write_meta(dataset, staging)
        if directory.exists():
            directory.rename(previous)
        staging.rename(directory)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
        shutil.rmtree(previous, ignore_errors=True)
    return read_meta(directory)
