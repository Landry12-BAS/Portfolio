"""Loading the semantic layer for real: its structure, then every SQL expression it contains.

The layer defines metrics and dimensions as SQL expressions, and metrics that need several
steps as worked example queries. Those are shown to the model as the way to compute a
number, so a mistake in one would be copied into answers. This module runs each of them
through the same SQL check that guards visitors' questions: every expression is put in the
smallest query that can use it (over the tables it needs, joined by the declared keys), and
every example is checked as the query it is. A typo or an unsafe expression stops the
service at startup, with a message naming the metric.
"""

from collections.abc import Sequence
from pathlib import Path

import sqlglot
from sqlglot import exp
from sqlglot.errors import SqlglotError

from core.data_files import DataFileError
from lb05.safety import SqlRejectedError
from lb05.semantic_layer import DimensionSpec, MetricSpec, SemanticLayer, read_semantic_layer
from lb05.sql_policy import DIALECT, SqlPolicy


def join_condition(layer: SemanticLayer, included: Sequence[str], table: str) -> exp.Expr | None:
    """Find a declared join from `table` to a table already in the query, as an equality; None when there is none."""
    for pair in layer.join_pairs():
        sides = dict(pair)
        if table in sides and len(sides) == 2:
            other = next(name for name in sides if name != table)
            if other in included:
                return exp.column(sides[table], table).eq(exp.column(sides[other], other))
    return None


def query_using(expression_sql: str, needs: Sequence[str], layer: SemanticLayer) -> str:
    """Build the smallest query that uses an expression: its value over the tables it needs, joined by declared keys."""
    try:
        expression = sqlglot.parse_one(expression_sql, read=DIALECT)
    except SqlglotError:
        raise ValueError("the expression isn't valid SQL") from None
    included = [needs[0]]
    query = exp.select(exp.alias_(expression, "value")).from_(needs[0])
    for table in needs[1:]:
        condition = join_condition(layer, included, table)
        if condition is None:
            raise ValueError(f"the table {table} can't be joined to the others by a declared join")
        query = query.join(table, on=condition)
        included.append(table)
    return query.sql(dialect=DIALECT)


def check_expression(name: str, expression_sql: str, needs: Sequence[str], policy: SqlPolicy) -> None:
    """Check one metric or dimension expression, raising DataFileError that names it when it fails."""
    try:
        policy.validate(query_using(expression_sql, needs, policy.layer))
    except ValueError as error:
        raise DataFileError(f"{name}: {error}") from None
    except SqlRejectedError as error:
        raise DataFileError(f"{name}: the SQL check refuses it ({error.layer}/{error.rule}): {error.message}") from None


def check_pattern(name: str, pattern: str, policy: SqlPolicy) -> None:
    """Check one worked example query, raising DataFileError that names its metric when it fails."""
    try:
        policy.validate(pattern)
    except SqlRejectedError as error:
        raise DataFileError(
            f"{name}: the example query is refused ({error.layer}/{error.rule}): {error.message}"
        ) from None


def check_metric(metric: MetricSpec, policy: SqlPolicy) -> None:
    """Check a metric's expression or its example query."""
    if metric.expression is not None:
        check_expression(f"metric {metric.name!r}", metric.expression, metric.needs, policy)
    if metric.pattern is not None:
        check_pattern(f"metric {metric.name!r}", metric.pattern, policy)


def check_dimension(dimension: DimensionSpec, policy: SqlPolicy) -> None:
    """Check a dimension's expression."""
    check_expression(f"dimension {dimension.name!r}", dimension.expression, dimension.needs, policy)


def load_semantic_layer(directory: Path) -> SemanticLayer:
    """Read the semantic layer in a seed folder and prove every SQL expression in it safe, or raise DataFileError."""
    layer = read_semantic_layer(directory)
    policy = SqlPolicy(layer)
    for metric in layer.metrics:
        check_metric(metric, policy)
    for dimension in layer.dimensions:
        check_dimension(dimension, policy)
    return layer
