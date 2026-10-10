"""Tests for the chart builder (lb05/chart.py): a chart for each result shape, and a spec that carries no code."""

import json
from typing import Any

import pytest
from pydantic import ValidationError

from core.platform import REPOSITORY_ROOT
from lb05.chart import (
    MAX_LABEL_CHARS,
    MAX_POINTS,
    MAX_SERIES,
    VEGA_LITE_SCHEMA,
    Chart,
    ChartHints,
    InlineData,
    NoChart,
    VegaLiteSpec,
    build_chart,
    choose_chart,
    hints_of,
    is_identifier,
    names_a_period,
    number_or_none,
)
from lb05.golden import read_adversarial_set
from lb05.semantic_layer import SemanticLayer
from lb05.sql_policy import SqlPolicy
from lb05.warehouse import CellValue, QueryResult, ResultColumn, Warehouse

# The cases the mock's copy of this builder (packages/api-clients/src/testing/lb05-chart.ts) is held to as well.
SHARED_CASES = json.loads((REPOSITORY_ROOT / "evals" / "lb05" / "chart-cases.json").read_text(encoding="utf-8"))[
    "cases"
]

# Every key a spec this service writes may hold, at any depth. Nothing that can run, fetch or compute is here.
ALLOWED_KEYS = {
    "$schema",
    "description",
    "data",
    "values",
    "mark",
    "type",
    "tooltip",
    "encoding",
    "x",
    "y",
    "color",
    "field",
    "title",
    "sort",
    "width",
    "height",
    "series",
}
FORBIDDEN_KEYS = {"url", "expr", "signal", "calculate", "transform", "params", "datasets", "filter", "join"}


def result_of(columns: list[tuple[str, str]], rows: list[tuple[CellValue, ...]]) -> QueryResult:
    """Make a query result from column names and kinds, and rows."""
    kinds: Any = dict(columns)
    return QueryResult(
        columns=tuple(ResultColumn(name, kinds[name]) for name, _ in columns), rows=rows, capped=False, elapsed_ms=1
    )


def all_keys(value: object) -> set[str]:
    """Collect every key of every object inside a JSON value."""
    if isinstance(value, dict):
        return {*value.keys(), *(key for item in value.values() for key in all_keys(item))}
    if isinstance(value, list):
        return {key for item in value for key in all_keys(item)}
    return set()


def test_a_date_and_a_number_make_a_line() -> None:
    """A series over time is a line, with a temporal x axis and the numbers up the y axis."""
    chart = build_chart(
        result_of(
            [("month", "date"), ("revenue", "integer")],
            [("2026-01-01T00:00:00", 100), ("2026-02-01T00:00:00", 150), ("2026-03-01T00:00:00", 120)],
        )
    )
    assert chart is not None
    assert chart.kind == "line"
    spec = chart.spec
    assert spec["$schema"] == VEGA_LITE_SCHEMA
    assert spec["mark"] == {"type": "line", "tooltip": True}
    encoding: Any = spec["encoding"]
    assert encoding["x"] == {"field": "x", "type": "temporal", "title": "month"}
    assert encoding["y"] == {"field": "y", "type": "quantitative", "title": "revenue"}
    assert spec["data"] == {
        "values": [
            {"x": "2026-01-01T00:00:00", "y": 100},
            {"x": "2026-02-01T00:00:00", "y": 150},
            {"x": "2026-03-01T00:00:00", "y": 120},
        ]
    }


def test_a_label_and_a_number_make_bars_in_the_order_the_rows_came() -> None:
    """A ranking stays a ranking: the bars are not re-sorted into alphabetical order."""
    chart = build_chart(
        result_of(
            [("product", "text"), ("revenue", "integer")],
            [("Zebra Blend", 900), ("Alpha Roast", 500), ("Middle Bean", 100)],
        )
    )
    assert chart is not None
    assert chart.kind == "bar"
    encoding: Any = chart.spec["encoding"]
    assert encoding["x"]["type"] == "nominal"
    assert encoding["x"]["sort"] == ["Zebra Blend", "Alpha Roast", "Middle Bean"]
    assert "color" not in encoding


def test_a_second_label_with_few_values_colours_the_series() -> None:
    """Bars by country and segment are coloured by the segment."""
    chart = build_chart(
        result_of(
            [("country", "text"), ("segment", "text"), ("orders", "integer")],
            [("CZ", "home", 10), ("CZ", "business", 4), ("SK", "home", 3), ("SK", "business", 2)],
        )
    )
    assert chart is not None
    encoding: Any = chart.spec["encoding"]
    assert encoding["color"] == {"field": "series", "type": "nominal", "title": "segment"}
    values: Any = chart.spec["data"]
    assert values["values"][1] == {"x": "CZ", "y": 4, "series": "business"}


def test_a_second_label_with_many_values_does_not_make_a_rainbow() -> None:
    """More than eight different values in the second label is too many colours to tell apart, so there is no series."""
    rows: list[tuple[CellValue, ...]] = [(f"country {n}", f"city {n}", n) for n in range(MAX_SERIES + 1)]
    chart = build_chart(result_of([("country", "text"), ("city", "text"), ("orders", "integer")], rows))
    assert chart is not None
    assert "color" not in chart.spec["encoding"]  # type: ignore[operator]


def test_a_year_in_whole_numbers_is_a_label_in_order() -> None:
    """A year is not a quantity: it is the ordered axis of the bars, and keeps its numeric order."""
    chart = build_chart(
        result_of([("year", "integer"), ("revenue", "integer")], [(2024, 100), (2025, 200), (2026, 300)])
    )
    assert chart is not None
    assert chart.kind == "bar"
    encoding: Any = chart.spec["encoding"]
    assert encoding["x"]["type"] == "ordinal"
    assert "sort" not in encoding["x"]
    values: Any = chart.spec["data"]
    assert [row["x"] for row in values["values"]] == [2024, 2025, 2026]


def test_two_numbers_make_a_scatter() -> None:
    """Two quantities with no label are plotted against each other."""
    chart = build_chart(result_of([("items", "integer"), ("total", "number")], [(1, 10.5), (2, 22.0), (3, 31.5)]))
    assert chart is not None
    assert chart.kind == "point"
    encoding: Any = chart.spec["encoding"]
    assert encoding["x"]["type"] == "quantitative"


@pytest.mark.parametrize(
    ("columns", "rows"),
    [
        ([("revenue", "integer")], [(8_766_862,)]),
        ([("product", "text"), ("revenue", "integer")], [("Basalt Blend", 100)]),
        ([("product", "text"), ("kind", "text")], [("a", "x"), ("b", "y")]),
        ([("flag", "boolean"), ("blob", "other")], [(True, "x"), (False, "y")]),
        ([("product", "text"), ("revenue", "integer")], []),
    ],
    ids=["single-value", "single-row", "only-text", "undrawable-kinds", "no-rows"],
)
def test_a_result_with_no_honest_chart_has_none(
    columns: list[tuple[str, str]], rows: list[tuple[CellValue, ...]]
) -> None:
    """A single value or row, a table of text, undrawable columns and an empty result are shown as tables."""
    assert build_chart(result_of(columns, rows)) is None


def title(name: str) -> str:
    """Write a column's name as the chart titles it."""
    return name.replace("_", " ")


@pytest.mark.parametrize("case", SHARED_CASES, ids=[case["id"] for case in SHARED_CASES])
def test_the_shared_cases_come_out_as_written(case: dict[str, Any]) -> None:
    """Each case both builders are held to: the chart that comes out, or the reason there is none."""
    result = result_of([(name, kind) for name, kind in case["columns"]], [tuple(row) for row in case["rows"]])
    hints = ChartHints(metrics=frozenset(case["metrics"]), keys=frozenset(case["keys"]))

    chosen = choose_chart(result, hints)

    expected = case["expect"]
    if expected is None:
        assert chosen is NoChart(case["why"])
        assert build_chart(result, hints) is None
        return
    assert isinstance(chosen, Chart)
    encoding: Any = chosen.spec["encoding"]
    assert chosen.kind == expected["kind"]
    assert (encoding["x"]["title"], encoding["x"]["type"]) == (title(expected["x"]), expected["xType"])
    assert encoding["y"]["title"] == title(expected["y"])
    if expected["series"] is None:
        assert "color" not in encoding
    else:
        assert encoding["color"]["title"] == title(expected["series"])


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("id", True),
        ("ID", True),
        ("order_id", True),
        ("Customer_ID", True),
        ("revenue", False),
        ("paid", False),
        ("valid", False),
        ("order_idx", False),
        ("identity", False),
    ],
)
def test_an_identifier_is_found_by_its_name(name: str, expected: bool) -> None:
    """`id` and names ending in `_id` label a row; a name that merely contains those letters does not."""
    assert is_identifier(ResultColumn(name, "integer"), ChartHints()) is expected


def test_a_key_the_layer_joins_on_is_an_identifier_whatever_it_is_called() -> None:
    """The semantic layer's own metadata counts: a column it joins on is a label, not a quantity."""
    column = ResultColumn("buyer_number", "integer")

    assert is_identifier(column, ChartHints(keys=frozenset({"buyer_number"})))
    assert not is_identifier(column, ChartHints())


def test_the_hints_come_from_the_real_semantic_layer(layer: SemanticLayer) -> None:
    """Its twelve metrics are what a measure column is called, and its joins use four keys."""
    hints = hints_of(layer)

    assert {"revenue", "orders", "units_sold", "repeat_buyers", "lost_repeat_buyers"} <= hints.metrics
    assert len(hints.metrics) == len(layer.metrics) == 12
    assert hints.keys == {"customer_id", "order_id", "product_id", "subscription_id"}


def test_the_answer_to_a_dump_of_every_order_has_no_chart(
    layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse
) -> None:
    """`SELECT * FROM orders` (the dump-all-orders attack) is a list of records: not order numbers charted by day."""
    attack = next(item for item in read_adversarial_set().attempts if item.id == "dump-all-orders")
    result = warehouse.run(policy.validate(attack.sql).sql)

    assert len(result.rows) == 1_000
    assert {"order_id", "customer_id", "ordered_at", "status"} <= {column.name for column in result.columns}
    assert choose_chart(result, hints_of(layer)) is NoChart.REPEATED_POINTS
    assert build_chart(result, hints_of(layer)) is None


def test_repeats_are_judged_on_the_whole_result_not_on_the_part_that_is_drawn() -> None:
    """Two hundred distinct labels and then a repeat is still a list of records, though the chart would stop first."""
    rows: list[tuple[CellValue, ...]] = [(f"label {n}", n) for n in range(MAX_POINTS)]
    rows.append(("label 0", 999))

    assert choose_chart(result_of([("label", "text"), ("n", "integer")], rows)) is NoChart.REPEATED_POINTS


def test_a_long_result_is_cut_to_the_points_a_chart_can_show() -> None:
    """Past 200 rows a chart is noise: it draws the first 200 and says how many it left out."""
    rows: list[tuple[CellValue, ...]] = [(f"label {n}", n) for n in range(MAX_POINTS + 50)]
    chart = build_chart(result_of([("label", "text"), ("n", "integer")], rows))
    assert chart is not None
    values: Any = chart.spec["data"]
    assert len(values["values"]) == MAX_POINTS
    assert chart.omitted_rows == 50


def test_the_spec_can_carry_no_code_and_no_address() -> None:
    """Every key in a written spec is one the subset lists, and none of the keys that can run or fetch is there."""
    chart = build_chart(
        result_of(
            [("country", "text"), ("segment", "text"), ("orders", "integer")],
            [("CZ", "home", 10), ("SK", "business", 3)],
        )
    )
    assert chart is not None
    keys = all_keys(chart.spec)
    assert keys <= ALLOWED_KEYS, keys - ALLOWED_KEYS
    assert not keys & FORBIDDEN_KEYS


def test_a_hostile_column_name_or_value_is_only_ever_text() -> None:
    """Names and cells that look like code or markup become titles and values, never fields or keys."""
    nasty = 'x"}; alert(1) //<script>'
    chart = build_chart(result_of([(nasty, "text"), ("n", "integer")], [(nasty, 1), ("b", 2)]))
    assert chart is not None
    encoding: Any = chart.spec["encoding"]
    assert encoding["x"]["field"] == "x"
    assert encoding["x"]["title"] == nasty[:MAX_LABEL_CHARS]
    assert all_keys(chart.spec) <= ALLOWED_KEYS
    assert json.loads(json.dumps(chart.spec)) == chart.spec


def test_a_long_label_is_cut() -> None:
    """A label or title never exceeds sixty characters."""
    chart = build_chart(result_of([("p", "text"), ("n", "integer")], [("L" * 300, 1), ("b", 2)]))
    assert chart is not None
    values: Any = chart.spec["data"]
    assert len(values["values"][0]["x"]) == MAX_LABEL_CHARS


def test_null_and_non_numbers_in_the_measure_become_gaps() -> None:
    """A missing value is a gap in the chart, not a zero and not an error."""
    chart = build_chart(result_of([("p", "text"), ("n", "number")], [("a", None), ("b", 2.5)]))
    assert chart is not None
    values: Any = chart.spec["data"]
    assert values["values"][0]["y"] is None
    assert number_or_none(True) is None
    assert number_or_none("3") is None
    assert number_or_none(3) == 3


@pytest.mark.parametrize(
    ("name", "kind", "expected"),
    [
        ("year", "integer", True),
        ("order_month", "integer", True),
        ("quarter_number", "integer", True),
        ("days_to_deliver", "integer", False),
        ("revenue", "integer", False),
        ("year", "number", False),
    ],
)
def test_period_columns_are_found_by_name(name: str, kind: str, expected: bool) -> None:
    """Only whole numbers named for a period are drawn as ordered labels."""
    column = ResultColumn(name, kind)  # type: ignore[arg-type]
    assert names_a_period(column) is expected


def spec_data(**changes: Any) -> dict[str, Any]:
    """Build a small valid spec as plain data, with the given top-level changes."""
    data: dict[str, Any] = {
        "$schema": VEGA_LITE_SCHEMA,
        "description": "A bar chart.",
        "data": {"values": [{"x": "a", "y": 1}]},
        "mark": {"type": "bar"},
        "encoding": {
            "x": {"field": "x", "type": "nominal", "title": "p"},
            "y": {"field": "y", "type": "quantitative", "title": "n"},
        },
    }
    data.update(changes)
    return data


def test_the_spec_model_accepts_a_valid_spec() -> None:
    """The model that guards the spec accepts what the builder writes."""
    assert VegaLiteSpec.model_validate(spec_data()).mark.type == "bar"


@pytest.mark.parametrize(
    "change",
    [
        {"transform": [{"calculate": "datum.y * 2", "as": "z"}]},
        {"data": {"url": "https://evil.example/data.json"}},
        {"data": {"values": [{"X Y": 1}]}},
        {"data": {"values": [{"x": ["nested"]}]}},
        {"mark": {"type": "arc"}},
        {"mark": {"type": "bar", "href": "https://evil.example"}},
        {
            "encoding": {
                "x": {"field": "x", "type": "nominal", "title": "p", "scale": {"expr": "1"}},
                "y": {"field": "y", "type": "quantitative", "title": "n"},
            }
        },
        {
            "encoding": {
                "x": {"field": "datum.x", "type": "nominal", "title": "p"},
                "y": {"field": "y", "type": "quantitative", "title": "n"},
            }
        },
        {"$schema": "https://evil.example/schema.json"},
        {"width": 100000},
    ],
    ids=[
        "transform",
        "data-url",
        "field-name-with-space",
        "nested-value",
        "unknown-mark",
        "mark-link",
        "scale-expression",
        "field-expression",
        "other-schema",
        "width",
    ],
)
def test_the_spec_model_refuses_anything_it_does_not_list(change: dict[str, Any]) -> None:
    """The subset is closed: an unlisted key, a field name not made by this code or a foreign schema is an error."""
    with pytest.raises(ValidationError):
        VegaLiteSpec.model_validate(spec_data(**change))


def test_the_data_is_bounded() -> None:
    """The inline data holds at most 200 rows."""
    with pytest.raises(ValidationError):
        InlineData.model_validate({"values": [{"x": "a", "y": 1}] * (MAX_POINTS + 1)})
