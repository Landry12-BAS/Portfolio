"""The semantic layer: what LB-05's model may know about the data, and what its SQL may touch.

The layer lives in data/seed/lb05/semantic_layer.yaml. It lists the tables and columns a
question may use, the joins between them, and how each metric and dimension is
computed. It does two jobs at once: it is the only description of the data the model
ever sees, and it is the allowlist the SQL check holds every query to. A column the data
holds but the layer leaves out is therefore invisible to the model and unreadable by SQL.

This module only reads and checks the file's structure (every name used is defined, and
nothing is defined twice). That every expression in it is safe SQL is checked by
lb05/semantic_check.py, which needs the SQL check and so comes after it.
"""

from collections.abc import Mapping
from pathlib import Path
from typing import Annotated, Literal, Self

from pydantic import Field, StringConstraints, model_validator

from core.data_files import StrictEntry, Text, read_data_file

# A table, column, metric or dimension name: lowercase words joined by underscores.
Identifier = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,40}$")]
# A column named with its table, such as `orders.customer_id`.
ColumnRef = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,40}\.[a-z][a-z0-9_]{0,40}$")]
# A short label for people.
Label = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]
# A SQL expression, or a worked example query, as the file writes it.
Expression = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=700)]
Pattern = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2_500)]
# A word or phrase a question may use for a metric or a dimension.
Synonym = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]
# The kinds of column the data holds.
ColumnType = Literal["integer", "text", "date"]
# The file this module reads.
LAYER_FILE = "semantic_layer.yaml"


class ColumnSpec(StrictEntry):
    """One column a question may use: its name, what it holds and, for a short list, every value it takes."""

    name: Identifier
    type: ColumnType
    description: Text
    # Every value a low-cardinality column holds, so the model writes `'CZ'` and not `'Czechia'`.
    values: list[str | int] = Field(default_factory=list, max_length=30)
    nullable: bool = False

    @model_validator(mode="after")
    def _check_values_fit_the_type(self) -> Self:
        """Require whole numbers for an integer column and text for a text column, and none for a date."""
        wanted = {"integer": int, "text": str}.get(self.type)
        if self.values and (wanted is None or any(type(value) is not wanted for value in self.values)):
            raise ValueError(f"column {self.name!r} lists values that aren't {self.type} values")
        return self


class TableSpec(StrictEntry):
    """One table a question may use, and its columns."""

    name: Identifier
    description: Text
    columns: list[ColumnSpec] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def _check_unique_columns(self) -> Self:
        """Refuse a column listed twice in one table."""
        names = [column.name for column in self.columns]
        if len(set(names)) != len(names):
            raise ValueError(f"table {self.name!r} lists a column twice")
        return self


class JoinSpec(StrictEntry):
    """One allowed join: two columns, from different tables, that may be set equal."""

    left: ColumnRef
    right: ColumnRef


class MetricSpec(StrictEntry):
    """One number the data can answer for, and how it is computed.

    A simple metric has an `expression`, computed over the tables in `needs` once they are
    joined. A metric that needs several steps has a `pattern` instead: a worked example
    query, with example dates, that the model adapts.
    """

    name: Identifier
    label: Label
    description: Text
    expression: Expression | None = None
    pattern: Pattern | None = None
    needs: list[Identifier] = Field(min_length=1, max_length=6)
    synonyms: list[Synonym] = Field(default_factory=list, max_length=12)

    @model_validator(mode="after")
    def _check_has_one_definition(self) -> Self:
        """Require exactly one of an expression and a pattern."""
        if (self.expression is None) == (self.pattern is None):
            raise ValueError(f"metric {self.name!r} needs exactly one of expression and pattern")
        return self


class DimensionSpec(StrictEntry):
    """One way to slice a metric, and the expression that computes it."""

    name: Identifier
    description: Text
    expression: Expression
    needs: list[Identifier] = Field(min_length=1, max_length=6)
    synonyms: list[Synonym] = Field(default_factory=list, max_length=12)


class SemanticLayer(StrictEntry):
    """The whole of semantic_layer.yaml."""

    version: Literal[1]
    tables: list[TableSpec] = Field(min_length=1, max_length=12)
    joins: list[JoinSpec] = Field(default_factory=list, max_length=24)
    metrics: list[MetricSpec] = Field(min_length=1, max_length=30)
    dimensions: list[DimensionSpec] = Field(default_factory=list, max_length=30)

    @model_validator(mode="after")
    def _check_references(self) -> Self:
        """Refuse repeated names, joins between unknown columns, and needs that name a table the layer lacks."""
        table_names = [table.name for table in self.tables]
        require_unique(table_names, "table")
        require_unique([metric.name for metric in self.metrics], "metric")
        require_unique([dimension.name for dimension in self.dimensions], "dimension")
        known = set(table_names)
        columns = self.allowed_columns()
        for join in self.joins:
            for reference in (join.left, join.right):
                table, _, column = reference.partition(".")
                if column not in columns.get(table, frozenset()):
                    raise ValueError(f"join names {reference!r}, which is not a column of the layer")
            if join.left.partition(".")[0] == join.right.partition(".")[0]:
                raise ValueError(f"join {join.left} = {join.right} joins a table to itself")
        needing: list[MetricSpec | DimensionSpec] = [*self.metrics, *self.dimensions]
        for item in needing:
            unknown = sorted(set(item.needs) - known)
            if unknown:
                raise ValueError(f"{item.name!r} needs tables the layer doesn't have: {', '.join(unknown)}")
        return self

    def allowed_columns(self) -> Mapping[str, frozenset[str]]:
        """Return every table the layer allows, with the names of its columns."""
        return {table.name: frozenset(column.name for column in table.columns) for table in self.tables}

    def column_types(self) -> Mapping[str, Mapping[str, ColumnType]]:
        """Return the type of every column, by table."""
        return {table.name: {column.name: column.type for column in table.columns} for table in self.tables}

    def metric_names(self) -> frozenset[str]:
        """Return the names of the metrics the layer defines, which is what a result's measure columns are called."""
        return frozenset(metric.name for metric in self.metrics)

    def key_column_names(self) -> frozenset[str]:
        """Return the names of the columns the layer's joins use: keys that label a row and are never a quantity."""
        references = [reference for join in self.joins for reference in (join.left, join.right)]
        return frozenset(reference.partition(".")[2] for reference in references)

    def join_pairs(self) -> frozenset[frozenset[tuple[str, str]]]:
        """Return the allowed joins as unordered pairs of (table, column), so either side may come first."""
        pairs = set()
        for join in self.joins:
            left = tuple(join.left.split("."))
            right = tuple(join.right.split("."))
            pairs.add(frozenset({(left[0], left[1]), (right[0], right[1])}))
        return frozenset(pairs)

    def table(self, name: str) -> TableSpec:
        """Return one table's definition, or raise KeyError."""
        for table in self.tables:
            if table.name == name:
                return table
        raise KeyError(name)


def require_unique(names: list[str], what: str) -> None:
    """Raise if any name appears twice, naming the first repeat."""
    seen: set[str] = set()
    for name in names:
        if name in seen:
            raise ValueError(f"{what} {name!r} appears more than once")
        seen.add(name)


def read_semantic_layer(directory: Path) -> SemanticLayer:
    """Read and structurally check the semantic layer in a seed folder such as data/seed/lb05."""
    return read_data_file(directory / LAYER_FILE, SemanticLayer)
