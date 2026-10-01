"""Tests for the semantic layer: its strict reader and the SQL check of everything written in it."""

from pathlib import Path

import pytest

from core.data_files import DataFileError
from lb05.semantic_check import load_semantic_layer, query_using
from lb05.semantic_layer import LAYER_FILE, SemanticLayer, read_semantic_layer

# Columns the data holds that the layer must leave out: they are the hidden ones.
HIDDEN = {("customers", "email"), ("orders", "payment_reference")}


def layer_text(seed_directory: Path) -> str:
    """Return the real semantic layer's text, for a test to change."""
    return (seed_directory / LAYER_FILE).read_text(encoding="utf-8")


def changed(seed_directory: Path, tmp_path: Path, old: str, new: str) -> Path:
    """Write a copy of the real layer with one passage replaced, and return its folder."""
    text = layer_text(seed_directory)
    assert text.count(old) == 1, f"{old!r} must appear exactly once in the real layer"
    (tmp_path / LAYER_FILE).write_text(text.replace(old, new), encoding="utf-8")
    return tmp_path


def test_the_real_layer_describes_the_five_tables_of_the_warehouse(layer: SemanticLayer) -> None:
    """The layer lists every table the model may use, and its metrics and dimensions."""
    assert [table.name for table in layer.tables] == ["customers", "products", "orders", "order_lines", "subscriptions"]
    assert len(layer.metrics) == 12
    assert len(layer.dimensions) == 14
    assert len(layer.joins) == 6


def test_the_real_layer_leaves_the_hidden_columns_out(layer: SemanticLayer) -> None:
    """The warehouse holds two columns the layer does not describe, so the model never sees them."""
    described = {(table, column) for table, columns in layer.allowed_columns().items() for column in columns}
    assert not described & HIDDEN


def test_every_metric_and_dimension_names_tables_of_the_layer(layer: SemanticLayer) -> None:
    """A metric or dimension only needs tables the layer lists."""
    tables = set(layer.allowed_columns())
    for metric in layer.metrics:
        assert set(metric.needs) <= tables, metric.name
    for dimension in layer.dimensions:
        assert set(dimension.needs) <= tables, dimension.name


def test_the_hero_question_has_a_worked_example(layer: SemanticLayer) -> None:
    """Metrics that need several steps carry a worked query, not a one-line expression."""
    lost = next(metric for metric in layer.metrics if metric.name == "lost_repeat_buyers")
    assert lost.pattern is not None
    assert lost.expression is None
    assert "WITH" in lost.pattern


def test_column_types_and_values(layer: SemanticLayer) -> None:
    """Each column has a type, and a low-cardinality text column lists the values it takes."""
    types = layer.column_types()
    assert types["orders"]["ordered_at"] == "date"
    assert types["orders"]["total_czk"] == "integer"
    assert types["customers"]["country"] == "text"
    country = next(column for column in layer.table("customers").columns if column.name == "country")
    assert country.values == ["CZ", "SK", "DE", "AT", "PL", "HU"]


def test_joins_are_unordered_pairs(layer: SemanticLayer) -> None:
    """A join may be written with either side first."""
    pairs = layer.join_pairs()
    assert frozenset({("orders", "customer_id"), ("customers", "customer_id")}) in pairs
    assert len(pairs) == 6


def test_an_unknown_table_is_a_key_error(layer: SemanticLayer) -> None:
    """Asking for a table the layer does not have is an error, not an empty answer."""
    with pytest.raises(KeyError):
        layer.table("employees")


@pytest.mark.parametrize(
    ("old", "new", "complaint"),
    [
        ("version: 1", "version: 2", "version"),
        ("version: 1", "version: 1\nsurprise: true", "surprise"),
        (
            "    synonyms: [sales, turnover, income, takings, earnings]",
            "    synonyms: [sales]\n    colour: red",
            "colour",
        ),
        (
            '{name: customer_id, type: integer, description: "Customer number, unique."}',
            '{name: customer_id, type: blob, description: "Customer number, unique."}',
            "type",
        ),
        ('  - name: orders\n    label: "Orders"', '  - name: revenue\n    label: "Orders"', "appears more than once"),
        (
            "  - {left: orders.customer_id, right: customers.customer_id}",
            "  - {left: orders.customer_id, right: customers.nothing}",
            "not a column of the layer",
        ),
        (
            "  - {left: orders.customer_id, right: customers.customer_id}",
            "  - {left: orders.customer_id, right: orders.order_id}",
            "joins a table to itself",
        ),
        (
            "    needs: [orders, order_lines]\n    synonyms: [sales,",
            "    needs: [orders, employees]\n    synonyms: [sales,",
            "needs tables the layer doesn't have",
        ),
        (
            "values: [CZ, SK, DE, AT, PL, HU]}\n      - {name: city",
            "values: [1, 2]}\n      - {name: city",
            "aren't text values",
        ),
    ],
    ids=[
        "version",
        "unknown-top-key",
        "unknown-metric-key",
        "unknown-type",
        "duplicate-metric",
        "unknown-join-column",
        "self-join",
        "unknown-needs",
        "values-wrong-type",
    ],
)
def test_the_reader_is_strict(lb05_seed_directory: Path, tmp_path: Path, old: str, new: str, complaint: str) -> None:
    """A mistake in the file stops the service at startup, with a message that names it."""
    directory = changed(lb05_seed_directory, tmp_path, old, new)
    with pytest.raises(DataFileError) as stopped:
        read_semantic_layer(directory)
    assert complaint in str(stopped.value)


def test_a_metric_needs_exactly_one_definition(lb05_seed_directory: Path, tmp_path: Path) -> None:
    """A metric with both an expression and a pattern, or with neither, is refused."""
    expression_line = '    expression: "COUNT(customers.customer_id)"\n'
    both_folder = tmp_path / "both"
    both_folder.mkdir()
    both = changed(lb05_seed_directory, both_folder, expression_line, expression_line + '    pattern: "SELECT 1"\n')
    with pytest.raises(DataFileError, match="exactly one of expression and pattern"):
        read_semantic_layer(both)
    neither_folder = tmp_path / "neither"
    neither_folder.mkdir()
    neither = changed(lb05_seed_directory, neither_folder, expression_line, "")
    with pytest.raises(DataFileError, match="exactly one of expression and pattern"):
        read_semantic_layer(neither)


def test_a_missing_file_is_a_data_file_error(tmp_path: Path) -> None:
    """A seed folder without the layer is reported, not crashed on."""
    with pytest.raises(DataFileError):
        read_semantic_layer(tmp_path)


@pytest.mark.parametrize(
    ("old", "new", "complaint"),
    [
        ('expression: "COUNT(customers.customer_id)"', 'expression: "COUNT(customers.email)"', "unknown_column"),
        (
            'expression: "COUNT(customers.customer_id)"',
            "expression: \"COUNT(read_csv('/etc/passwd'))\"",
            "function_not_allowed",
        ),
        ('expression: "COUNT(customers.customer_id)"', 'expression: "COUNT("', "isn't valid SQL"),
        (
            "expression: \"COUNT(*) FILTER (WHERE subscriptions.status = 'active')\"",
            "expression: \"COUNT(*) FILTER (WHERE subscriptions.state = 'active')\"",
            "unknown_column",
        ),
        (
            "expression: \"DATE_TRUNC('month', orders.ordered_at)\"",
            "expression: \"DATE_TRUNC('month', orders.ordered_at) + random()\"",
            "function_not_allowed",
        ),
        (
            'expression: "customers.country", needs: [customers]',
            'expression: "customers.country", needs: [customers, products]',
            "can't be joined",
        ),
    ],
    ids=["hidden-column", "file-function", "syntax", "unknown-column", "forbidden-function", "tables-that-do-not-join"],
)
def test_an_unsafe_expression_stops_the_load(
    lb05_seed_directory: Path, tmp_path: Path, old: str, new: str, complaint: str
) -> None:
    """Every expression in the layer is run through the SQL check, and one the check refuses stops the service."""
    directory = changed(lb05_seed_directory, tmp_path, old, new)
    with pytest.raises(DataFileError) as stopped:
        load_semantic_layer(directory)
    assert complaint in str(stopped.value)


def test_an_unsafe_worked_example_stops_the_load(lb05_seed_directory: Path, tmp_path: Path) -> None:
    """A worked query is checked as the query it is."""
    directory = changed(
        lb05_seed_directory,
        tmp_path,
        "SELECT in_period.product AS product, COUNT(*) AS repeat_buyers",
        "SELECT in_period.product AS product, COUNT(*) AS repeat_buyers, in_period.nothing AS nothing",
    )
    with pytest.raises(DataFileError, match="repeat_buyers"):
        load_semantic_layer(directory)


def test_the_smallest_query_joins_the_tables_an_expression_needs(layer: SemanticLayer) -> None:
    """An expression is checked inside the query that uses it: its tables, joined by declared keys."""
    sql = query_using("SUM(order_lines.line_total_czk)", ["orders", "order_lines", "products"], layer)
    assert "JOIN order_lines ON order_lines.order_id = orders.order_id" in sql
    assert "JOIN products ON products.product_id = order_lines.product_id" in sql
    with pytest.raises(ValueError, match="can't be joined"):
        query_using("COUNT(*)", ["customers", "products"], layer)
