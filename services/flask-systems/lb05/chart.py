"""Charts for LB-05's answers: a Vega-Lite spec that this code builds from the shape of a result.

A model never writes a chart. It could not be trusted to: a Vega-Lite spec can carry expressions
and URLs, and a spec that came from a model would be code from outside. The chart is chosen
here, from the kinds of the result's columns (text, date, number), and written as a small, fixed
subset of Vega-Lite 5: one mark (bar, line or point), inline data, and up to three encoded
fields. Field names are generated (`x`, `y`, `series`), so a column name can never reach the
spec as a field, and the spec is a Pydantic model that refuses every key it does not list: no
`url`, no `expr`, no `signal`, no `calculate`, no `transform`.

The spec is data for the site to draw. The site must still render a title or label as text.
"""

from dataclasses import dataclass
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from lb05.warehouse import CellValue, QueryResult, ResultColumn

# The Vega-Lite version the specs are written for. The site's renderer must read version 5.
VEGA_LITE_SCHEMA = "https://vega.github.io/schema/vega-lite/v5.json"
# The most points a chart draws, and the most colours it uses: past either, a chart is noise.
MAX_POINTS = 200
MAX_SERIES = 8
CHART_HEIGHT = 280
# Whole-number columns that name a period are drawn as ordered categories, not as a quantity.
PERIOD_NAMES = frozenset({"year", "quarter", "month", "week", "day", "weekday"})
PERIOD_ENDINGS = ("_year", "_quarter", "_month", "_week")
PERIOD_BEGINNINGS = ("year_", "quarter_", "month_", "week_")
# What a title or a label may be: short text made from a column name or a cell.
MAX_LABEL_CHARS = 60

type ChartKind = Literal["bar", "line", "point"]
type AxisType = Literal["nominal", "ordinal", "quantitative", "temporal"]
type FieldName = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,15}$")]
type Label = Annotated[str, StringConstraints(max_length=MAX_LABEL_CHARS)]
type Datum = str | int | float | None


class StrictSpecPart(BaseModel):
    """The base of every part of a spec: nothing that is not listed is accepted, and nothing changes once built."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


class Channel(StrictSpecPart):
    """One encoded field: the generated field, its kind of value, its title, and the order of its labels."""

    field: FieldName
    type: AxisType
    title: Label
    # The labels of a category axis, in the order the rows came in, so a ranking stays a ranking.
    sort: list[Label] | None = Field(default=None, max_length=MAX_POINTS)


class Encoding(StrictSpecPart):
    """The fields a mark draws: x and y, and a colour for the series when there are some."""

    x: Channel
    y: Channel
    color: Channel | None = None


class Mark(StrictSpecPart):
    """The one mark of a chart, with a tooltip."""

    type: ChartKind
    tooltip: bool = True


class InlineData(StrictSpecPart):
    """The chart's data, written into the spec: rows of generated field names and plain values."""

    values: list[dict[FieldName, Datum]] = Field(max_length=MAX_POINTS)


class VegaLiteSpec(StrictSpecPart):
    """A chart in the subset of Vega-Lite this service writes."""

    schema_url: str = Field(default=VEGA_LITE_SCHEMA, alias="$schema")
    description: Annotated[str, StringConstraints(max_length=200)]
    data: InlineData
    mark: Mark
    encoding: Encoding
    width: Literal["container"] = "container"
    height: int = Field(default=CHART_HEIGHT, ge=100, le=600)

    @field_validator("schema_url")
    @classmethod
    def _check_schema(cls, url: str) -> str:
        """Accept only the one schema URL the service writes."""
        if url != VEGA_LITE_SCHEMA:
            raise ValueError("The spec is written for Vega-Lite 5 only.")
        return url


@dataclass(frozen=True)
class Chart:
    """A chart for an answer: what kind it is, the spec to draw as plain JSON, and how many rows it left out."""

    kind: ChartKind
    spec: dict[str, object]
    omitted_rows: int


@dataclass(frozen=True)
class ColumnGroups:
    """The positions of a result's columns by what can be drawn, in the order the query wrote them."""

    text: list[int]
    date: list[int]
    number: list[int]

    @classmethod
    def of(cls, columns: tuple[ResultColumn, ...]) -> Self:
        """Group a result's columns: text, dates, and numbers (whole or not). Anything else can't be drawn."""
        groups = cls(text=[], date=[], number=[])
        for position, column in enumerate(columns):
            if column.kind == "text":
                groups.text.append(position)
            elif column.kind == "date":
                groups.date.append(position)
            elif column.kind in ("integer", "number"):
                groups.number.append(position)
        return groups


@dataclass(frozen=True)
class Axes:
    """Which columns a chart draws: positions for x, y and the optional series, and what kind of axis x is."""

    x: int
    y: int
    series: int | None
    x_type: AxisType


def names_a_period(column: ResultColumn) -> bool:
    """Tell whether a whole-number column is named for a period, such as `year`: an axis of ordered categories."""
    if column.kind != "integer":
        return False
    name = column.name.lower()
    return name in PERIOD_NAMES or name.endswith(PERIOD_ENDINGS) or name.startswith(PERIOD_BEGINNINGS)


def title_of(column: ResultColumn) -> str:
    """Make a column's name a short axis title."""
    return column.name.replace("_", " ")[:MAX_LABEL_CHARS]


def number_or_none(value: CellValue) -> int | float | None:
    """Keep a cell that is a number, and turn anything else into nothing (a bar of text is not a bar)."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return value


def series_position(result: QueryResult, candidates: list[int], taken: set[int]) -> int | None:
    """Pick a text column to colour the series by, when it has few enough different values to tell apart."""
    for position in candidates:
        if position in taken:
            continue
        distinct = {row[position] for row in result.rows}
        if 1 < len(distinct) <= MAX_SERIES:
            return position
    return None


def x_value(cell: CellValue, axis: AxisType) -> Datum:
    """Write an x value for the spec: labels as bounded text, numbers and dates as they are."""
    if axis == "nominal":
        return str(cell)[:MAX_LABEL_CHARS]
    return cell if isinstance(cell, str | int | float) and not isinstance(cell, bool) else None


def build_rows(result: QueryResult, axes: Axes) -> list[dict[FieldName, Datum]]:
    """Write the chart's data: one row per result row, with generated field names and bounded values."""
    rows: list[dict[FieldName, Datum]] = []
    for row in result.rows[:MAX_POINTS]:
        entry: dict[FieldName, Datum] = {"x": x_value(row[axes.x], axes.x_type), "y": number_or_none(row[axes.y])}
        if axes.series is not None:
            entry["series"] = str(row[axes.series])[:MAX_LABEL_CHARS]
        rows.append(entry)
    return rows


def label_order(rows: list[dict[FieldName, Datum]]) -> list[str]:
    """List the x labels in the order the rows came, each once."""
    return list(dict.fromkeys(str(entry["x"]) for entry in rows))


def make_chart(kind: ChartKind, result: QueryResult, axes: Axes) -> Chart:
    """Build the spec for one chart over the given columns of a result, validating it as it is built."""
    rows = build_rows(result, axes)
    x_channel = Channel(
        field="x",
        type=axes.x_type,
        title=title_of(result.columns[axes.x]),
        sort=label_order(rows) if axes.x_type == "nominal" else None,
    )
    color = None
    if axes.series is not None:
        color = Channel(field="series", type="nominal", title=title_of(result.columns[axes.series]))
    description = f"A {kind} chart of {title_of(result.columns[axes.y])} by {title_of(result.columns[axes.x])}."
    spec = VegaLiteSpec(
        description=description[:200],
        data=InlineData(values=rows),
        mark=Mark(type=kind),
        encoding=Encoding(
            x=x_channel, y=Channel(field="y", type="quantitative", title=title_of(result.columns[axes.y])), color=color
        ),
    )
    return Chart(
        kind=kind,
        spec=spec.model_dump(by_alias=True, exclude_none=True, mode="json"),
        omitted_rows=max(len(result.rows) - MAX_POINTS, 0),
    )


def build_chart(result: QueryResult) -> Chart | None:
    """Choose a chart for a result from its shape, or return None when it has no honest chart.

    A date and a number make a line. A label and a number make bars, coloured by a second
    label when that has few values. A period in whole numbers (a year) is a label, in order.
    Two numbers make a scatter. A single value, a result of one row and a table of text
    are shown as they are.
    """
    if len(result.rows) < 2:
        return None
    found = ColumnGroups.of(result.columns)
    if found.date and found.number:
        x, y = found.date[0], found.number[0]
        series = series_position(result, found.text, {x, y})
        return make_chart("line", result, Axes(x, y, series, "temporal"))
    if found.text and found.number:
        x, y = found.text[0], found.number[0]
        series = series_position(result, found.text[1:], {x, y})
        return make_chart("bar", result, Axes(x, y, series, "nominal"))
    periods = [position for position in found.number if names_a_period(result.columns[position])]
    quantities = [position for position in found.number if position not in periods]
    if periods and quantities:
        return make_chart("bar", result, Axes(periods[0], quantities[0], None, "ordinal"))
    if len(found.number) >= 2:
        return make_chart("point", result, Axes(found.number[0], found.number[1], None, "quantitative"))
    return None
