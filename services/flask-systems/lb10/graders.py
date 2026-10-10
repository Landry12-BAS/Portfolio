"""The closed set of rule-based graders an eval pack may name, each a pure function of the model's output.

A grader never runs a model, never builds a regular expression from a string, and never reads anything
but the text it is given and the fixed values its pack wrote down. Each returns whether the output met
the rule and one short sentence saying what it compared, so a changed case can be explained on the
board. A case passes when every grader it names passes: the lab's scores are shares of passing cases.

The JSON graders read the one JSON object in the output (bare or in a code fence, as production's
`core.structured` does), and walk into it by a dotted path: `category`, `sentences.0.text`,
`nodes.*.connector` (`*` visits every element of a list). The SQL grader compares syntax trees with
sqlglot, since the lab holds no copy of the data the query would run on.
"""

import json
import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Annotated, Any, Literal

import jsonschema
import sqlglot
from pydantic import Field, StringConstraints
from sqlglot import exp
from sqlglot.errors import SqlglotError
from sqlglot.optimizer.normalize_identifiers import normalize_identifiers

from core.data_files import StrictEntry
from core.structured import json_object_in

# A JSON value a grader may compare with: a label, a number, a flag or nothing.
type JsonScalar = str | int | float | bool | None
# What the graders may name: labels of a sensible length.
type Label = Annotated[str, StringConstraints(min_length=1, max_length=2_000)]
type Path = Annotated[str, StringConstraints(max_length=200, pattern=r"^$|^[A-Za-z0-9_*-]+(?:\.[A-Za-z0-9_*-]+)*$")]
# How much of an output a detail quotes: enough to tell the cases apart, never the whole reply.
DETAIL_CHARS = 120
# The SQL dialects a pack may name: LB-05 writes DuckDB.
type Dialect = Literal["duckdb"]


class ExactMatch(StrictEntry):
    """The whole output, trimmed, is exactly the expected text."""

    kind: Literal["exact_match"]
    expected: Label


class ContainsAll(StrictEntry):
    """Every listed value appears in the output (ignoring case unless the pack says otherwise)."""

    kind: Literal["contains_all"]
    values: list[Label] = Field(min_length=1, max_length=50)
    case_sensitive: bool = False


class ContainsNone(StrictEntry):
    """None of the listed values appears in the output: what a careful answer must never say."""

    kind: Literal["contains_none"]
    values: list[Label] = Field(min_length=1, max_length=50)
    case_sensitive: bool = False


class JsonSchema(StrictEntry):
    """The output holds one JSON object that the given JSON Schema (draft 2020-12) accepts."""

    kind: Literal["json_schema"]
    schema_: dict[str, Any] = Field(alias="schema")


class JsonFieldEquals(StrictEntry):
    """The value at `path` in the output's JSON object equals `expected`."""

    kind: Literal["json_field_equals"]
    path: Path
    expected: JsonScalar


class JsonFieldOneOf(StrictEntry):
    """The value at `path` is one of the options: for a case where two answers are both right."""

    kind: Literal["json_field_one_of"]
    path: Path
    options: list[JsonScalar] = Field(min_length=1, max_length=20)


class JsonPathContainsAll(StrictEntry):
    """Every listed value is among the values found at `path`, which may visit every element with `*`."""

    kind: Literal["json_path_contains_all"]
    path: Path
    values: list[JsonScalar] = Field(min_length=1, max_length=50)


class NumberWithin(StrictEntry):
    """The number at `path` is within `tolerance` (a share of the expected value) of `expected`."""

    kind: Literal["number_within"]
    path: Path
    expected: float
    tolerance: Annotated[float, Field(ge=0.0, le=1.0)] = 0.01


class LengthBounds(StrictEntry):
    """The output (or the text at `path`) is between `min_chars` and `max_chars` characters long."""

    kind: Literal["length_bounds"]
    path: Path | None = None
    min_chars: Annotated[int, Field(ge=0)] = 0
    max_chars: Annotated[int, Field(ge=1, le=100_000)]


class CitationPresent(StrictEntry):
    """Every listed source ID is cited somewhere in the lists found at `path` (such as `sentences.*.sources`)."""

    kind: Literal["citation_present"]
    path: Path
    ids: list[Label] = Field(min_length=1, max_length=20)


class SqlStructural(StrictEntry):
    """The SQL at `path` parses and has the structure of the reference query.

    `compare: shape` asks for the same tables and the same aggregate functions, which is what a query
    that answers the same question shares with the reference however it is written; `compare: ast`
    asks for the same normalised syntax tree.
    """

    kind: Literal["sql_structural"]
    path: Path
    reference: Annotated[str, StringConstraints(min_length=1, max_length=4_000)]
    dialect: Dialect = "duckdb"
    compare: Literal["shape", "ast"] = "shape"


type Grader = Annotated[
    ExactMatch
    | ContainsAll
    | ContainsNone
    | JsonSchema
    | JsonFieldEquals
    | JsonFieldOneOf
    | JsonPathContainsAll
    | NumberWithin
    | LengthBounds
    | CitationPresent
    | SqlStructural,
    Field(discriminator="kind"),
]
# The names of every grader kind, for the README and the board's words.
GRADER_KINDS: tuple[str, ...] = (
    "exact_match",
    "contains_all",
    "contains_none",
    "json_schema",
    "json_field_equals",
    "json_field_one_of",
    "json_path_contains_all",
    "number_within",
    "length_bounds",
    "citation_present",
    "sql_structural",
)


@dataclass(frozen=True)
class GradeResult:
    """One grader's verdict on one output, and a short sentence on what it compared."""

    kind: str
    passed: bool
    detail: str


class PathError(ValueError):
    """A path led nowhere in the output's JSON object."""


def shorten(text: str) -> str:
    """Cut a quoted piece of output to a short label, with no line breaks."""
    flat = " ".join(text.split())
    return flat if len(flat) <= DETAIL_CHARS else flat[: DETAIL_CHARS - 1] + "…"


def parse_json_output(output: str) -> Any:
    """Return the JSON object an output holds, or raise `ValueError` when it holds none."""
    return json.loads(json_object_in(output))


def walk(value: Any, path: str) -> list[Any]:
    """Return every value a dotted path leads to, visiting all elements where the path says `*`.

    An empty path is the value itself. A segment that is a number indexes a list, a name reads a key,
    and `*` fans out over a list's elements (or a mapping's values). A segment that leads nowhere
    raises `PathError`.
    """
    found = [value]
    if path == "":
        return found
    for segment in path.split("."):
        next_found: list[Any] = []
        for item in found:
            next_found.extend(step_into(item, segment))
        found = next_found
    return found


def step_into(item: Any, segment: str) -> list[Any]:
    """Follow one path segment into one value."""
    if segment == "*":
        if isinstance(item, list):
            return list(item)
        if isinstance(item, dict):
            return list(item.values())
        raise PathError("`*` needs a list or an object")
    if isinstance(item, list):
        if not segment.isdigit() or int(segment) >= len(item):
            raise PathError(f"no element {segment}")
        return [item[int(segment)]]
    if isinstance(item, dict):
        if segment not in item:
            raise PathError(f"no field {segment}")
        return [item[segment]]
    raise PathError(f"nothing to read {segment} from")


def single(value: Any, path: str) -> Any:
    """Return the one value at a path, refusing a path that fans out."""
    found = walk(value, path)
    if len(found) != 1:
        raise PathError(f"{path} leads to {len(found)} values, not one")
    return found[0]


def same_scalar(found: Any, expected: JsonScalar) -> bool:
    """Compare a found value with an expected scalar: numbers by value, everything else exactly (a flag is not 1)."""
    if isinstance(expected, bool) or isinstance(found, bool):
        return found is expected
    if isinstance(expected, int | float) and isinstance(found, int | float):
        return math.isclose(float(found), float(expected), rel_tol=0.0, abs_tol=1e-9)
    return bool(found == expected)


def text_contains(output: str, value: str, case_sensitive: bool) -> bool:
    """Tell whether a value appears in the output, ignoring case unless asked not to."""
    if case_sensitive:
        return value in output
    return value.casefold() in output.casefold()


def grade_exact_match(grader: ExactMatch, output: str) -> GradeResult:
    """Compare the trimmed output with the expected text."""
    passed = output.strip() == grader.expected.strip()
    return GradeResult(grader.kind, passed, f"expected {shorten(grader.expected)!r}, got {shorten(output)!r}")


def grade_contains_all(grader: ContainsAll, output: str) -> GradeResult:
    """Require every value in the output."""
    missing = [value for value in grader.values if not text_contains(output, value, grader.case_sensitive)]
    if missing:
        return GradeResult(grader.kind, False, "missing: " + shorten(", ".join(missing)))
    return GradeResult(grader.kind, True, f"all {len(grader.values)} values present")


def grade_contains_none(grader: ContainsNone, output: str) -> GradeResult:
    """Forbid every value in the output."""
    present = [value for value in grader.values if text_contains(output, value, grader.case_sensitive)]
    if present:
        return GradeResult(grader.kind, False, "forbidden text present: " + shorten(", ".join(present)))
    return GradeResult(grader.kind, True, f"none of {len(grader.values)} forbidden values present")


def grade_json_schema(grader: JsonSchema, output: str) -> GradeResult:
    """Validate the output's JSON object against the pack's JSON Schema."""
    try:
        document = parse_json_output(output)
        jsonschema.Draft202012Validator(grader.schema_).validate(document)
    except ValueError as error:
        return GradeResult(grader.kind, False, f"no JSON object: {shorten(str(error))}")
    except jsonschema.ValidationError as error:
        where = "/".join(str(part) for part in error.absolute_path) or "the object"
        return GradeResult(grader.kind, False, f"{where}: {shorten(error.message)}")
    return GradeResult(grader.kind, True, "the JSON object fits the schema")


def grade_json_field_equals(grader: JsonFieldEquals, output: str) -> GradeResult:
    """Compare one field with the expected value."""
    try:
        found = single(parse_json_output(output), grader.path)
    except (ValueError, PathError) as error:
        return GradeResult(grader.kind, False, f"{grader.path}: {shorten(str(error))}")
    passed = same_scalar(found, grader.expected)
    return GradeResult(grader.kind, passed, f"{grader.path}: expected {grader.expected!r}, got {shorten(repr(found))}")


def grade_json_field_one_of(grader: JsonFieldOneOf, output: str) -> GradeResult:
    """Accept any of the options at the field."""
    try:
        found = single(parse_json_output(output), grader.path)
    except (ValueError, PathError) as error:
        return GradeResult(grader.kind, False, f"{grader.path}: {shorten(str(error))}")
    passed = any(same_scalar(found, option) for option in grader.options)
    options = ", ".join(repr(option) for option in grader.options)
    return GradeResult(grader.kind, passed, f"{grader.path}: one of {options} expected, got {shorten(repr(found))}")


def grade_json_path_contains_all(grader: JsonPathContainsAll, output: str) -> GradeResult:
    """Require every value among those found along the path."""
    try:
        found = walk(parse_json_output(output), grader.path)
    except (ValueError, PathError) as error:
        return GradeResult(grader.kind, False, f"{grader.path}: {shorten(str(error))}")
    missing = [value for value in grader.values if not any(same_scalar(item, value) for item in found)]
    if missing:
        return GradeResult(grader.kind, False, f"{grader.path} lacks " + shorten(", ".join(map(repr, missing))))
    return GradeResult(grader.kind, True, f"{grader.path} holds all {len(grader.values)} values")


def grade_number_within(grader: NumberWithin, output: str) -> GradeResult:
    """Compare the number at the path with the expected one, within the tolerance."""
    try:
        found = single(parse_json_output(output), grader.path)
    except (ValueError, PathError) as error:
        return GradeResult(grader.kind, False, f"{grader.path}: {shorten(str(error))}")
    if isinstance(found, bool) or not isinstance(found, int | float) or not math.isfinite(float(found)):
        return GradeResult(grader.kind, False, f"{grader.path}: not a number")
    allowed = abs(grader.expected) * grader.tolerance
    passed = abs(float(found) - grader.expected) <= allowed
    return GradeResult(grader.kind, passed, f"{grader.path}: expected {grader.expected} ± {allowed:g}, got {found}")


def grade_length_bounds(grader: LengthBounds, output: str) -> GradeResult:
    """Hold the output, or a text field of it, to a length."""
    text = output
    if grader.path is not None:
        try:
            found = single(parse_json_output(output), grader.path)
        except (ValueError, PathError) as error:
            return GradeResult(grader.kind, False, f"{grader.path}: {shorten(str(error))}")
        if not isinstance(found, str):
            return GradeResult(grader.kind, False, f"{grader.path}: not text")
        text = found
    passed = grader.min_chars <= len(text) <= grader.max_chars
    return GradeResult(grader.kind, passed, f"{len(text)} characters, {grader.min_chars} to {grader.max_chars} allowed")


def grade_citation_present(grader: CitationPresent, output: str) -> GradeResult:
    """Require every source ID to be cited in the lists the path leads to."""
    try:
        lists = walk(parse_json_output(output), grader.path)
    except (ValueError, PathError) as error:
        return GradeResult(grader.kind, False, f"{grader.path}: {shorten(str(error))}")
    cited = {str(item) for found in lists if isinstance(found, list) for item in found}
    missing = [source_id for source_id in grader.ids if source_id not in cited]
    if missing:
        return GradeResult(grader.kind, False, "not cited: " + shorten(", ".join(missing)))
    return GradeResult(grader.kind, True, f"all {len(grader.ids)} sources cited")


def sql_shape(tree: exp.Query) -> tuple[frozenset[str], frozenset[str]]:
    """Return the tables a query reads and the aggregate functions it applies, both lowercased."""
    tables = frozenset(table.name.lower() for table in tree.find_all(exp.Table) if table.name)
    aggregates = frozenset(function.key.lower() for function in tree.find_all(exp.AggFunc))
    return tables, aggregates


def parse_sql(sql: str, dialect: str) -> exp.Query:
    """Parse one query and normalise its identifiers, so case and quoting never decide a grade.

    sqlglot reads a stray word as a column, so a tree that is not a query is refused here.
    """
    tree = sqlglot.parse_one(sql, read=dialect)
    if not isinstance(tree, exp.Query):
        raise SqlglotError("not a query")
    return normalize_identifiers(tree, dialect=dialect)


def grade_sql_structural(grader: SqlStructural, output: str) -> GradeResult:
    """Compare the SQL at the path with the reference query by shape or by syntax tree."""
    try:
        found = single(parse_json_output(output), grader.path)
    except (ValueError, PathError) as error:
        return GradeResult(grader.kind, False, f"{grader.path}: {shorten(str(error))}")
    if not isinstance(found, str) or not found.strip():
        return GradeResult(grader.kind, False, f"{grader.path}: no SQL")
    try:
        written = parse_sql(found, grader.dialect)
        reference = parse_sql(grader.reference, grader.dialect)
    except SqlglotError:
        return GradeResult(grader.kind, False, "the SQL does not parse as a query")
    if grader.compare == "ast":
        passed = written == reference
        return GradeResult(grader.kind, passed, "same syntax tree" if passed else "the syntax trees differ")
    written_tables, written_aggregates = sql_shape(written)
    reference_tables, reference_aggregates = sql_shape(reference)
    passed = written_tables == reference_tables and written_aggregates == reference_aggregates
    detail = (
        f"tables {sorted(written_tables)} vs {sorted(reference_tables)}, "
        f"aggregates {sorted(written_aggregates)} vs {sorted(reference_aggregates)}"
    )
    return GradeResult(grader.kind, passed, shorten(detail))


def grade(grader: Grader, output: str) -> GradeResult:
    """Apply one grader to one output."""
    match grader:
        case ExactMatch():
            return grade_exact_match(grader, output)
        case ContainsAll():
            return grade_contains_all(grader, output)
        case ContainsNone():
            return grade_contains_none(grader, output)
        case JsonSchema():
            return grade_json_schema(grader, output)
        case JsonFieldEquals():
            return grade_json_field_equals(grader, output)
        case JsonFieldOneOf():
            return grade_json_field_one_of(grader, output)
        case JsonPathContainsAll():
            return grade_json_path_contains_all(grader, output)
        case NumberWithin():
            return grade_number_within(grader, output)
        case LengthBounds():
            return grade_length_bounds(grader, output)
        case CitationPresent():
            return grade_citation_present(grader, output)
        case SqlStructural():
            return grade_sql_structural(grader, output)


def grade_all(graders: Sequence[Grader], output: str) -> list[GradeResult]:
    """Apply every grader of a case to one output, in the pack's order."""
    return [grade(grader, output) for grader in graders]


def passed_all(results: Sequence[GradeResult]) -> bool:
    """Tell whether a case passed: every grader did."""
    return all(result.passed for result in results)
