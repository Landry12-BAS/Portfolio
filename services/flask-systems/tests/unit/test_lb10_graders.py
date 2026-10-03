"""Tests for the closed set of graders: each is a pure function of the output and its pack's fixed values."""

import pytest
from lb10.graders import GRADER_KINDS, Grader, PathError, grade, grade_all, passed_all, walk
from pydantic import TypeAdapter, ValidationError

GRADER: TypeAdapter[Grader] = TypeAdapter(Grader)


def make(**spec: object) -> Grader:
    """Build a grader from its YAML form."""
    return GRADER.validate_python(spec)


def test_every_kind_is_listed_once() -> None:
    """The README and the board name the kinds from this tuple, which must match the union."""
    assert len(set(GRADER_KINDS)) == len(GRADER_KINDS) == 11
    for kind in GRADER_KINDS:
        with pytest.raises(ValidationError) as refused:
            GRADER.validate_python({"kind": kind})
        assert all(issue["type"] != "union_tag_invalid" for issue in refused.value.errors())
    with pytest.raises(ValidationError) as unknown:
        GRADER.validate_python({"kind": "model_judgement"})
    assert unknown.value.errors()[0]["type"] == "union_tag_invalid"


def test_exact_match_trims_but_does_not_fold_case() -> None:
    """An exact match is exact: only surrounding space is forgiven."""
    grader = make(kind="exact_match", expected="damaged")
    assert grade(grader, " damaged\n").passed
    assert not grade(grader, "Damaged").passed


def test_contains_all_and_none_ignore_case_by_default() -> None:
    """Mentions are found whatever their case; forbidden text is found the same way."""
    text = "Your order BB-1040 ships with Zásilkovna."
    assert grade(make(kind="contains_all", values=["bb-1040", "zásilkovna"]), text).passed
    forbidden = grade(make(kind="contains_none", values=["Hand Grinder", "zásilkovna"]), text)
    assert not forbidden.passed
    assert "zásilkovna" in forbidden.detail
    assert grade(make(kind="contains_none", values=["zásilkovna"], case_sensitive=True), text).passed


def test_json_schema_reads_a_fenced_object_and_names_the_bad_field() -> None:
    """The JSON graders accept what production accepts: one object, bare or fenced."""
    schema = {"type": "object", "required": ["category"], "properties": {"category": {"enum": ["late", "damaged"]}}}
    grader = make(kind="json_schema", schema=schema)
    assert grade(grader, '```json\n{"category": "late"}\n```').passed
    failed = grade(grader, '{"category": "lost"}')
    assert not failed.passed
    assert failed.detail.startswith("category:")
    assert "no JSON object" in grade(grader, "no json here").detail


def test_walk_follows_names_indexes_and_stars() -> None:
    """A dotted path reads keys and list indexes, and `*` fans out over a list."""
    document = {"nodes": [{"connector": "email"}, {"connector": "slack"}], "name": "x"}
    assert walk(document, "nodes.*.connector") == ["email", "slack"]
    assert walk(document, "nodes.1.connector") == ["slack"]
    assert walk(document, "") == [document]
    with pytest.raises(PathError):
        walk(document, "nodes.5")
    with pytest.raises(PathError):
        walk(document, "name.*")


def test_json_field_equals_tells_a_flag_from_a_number() -> None:
    """`true` is not 1 and 1 is not `true`, as JSON readers everywhere agree."""
    assert grade(make(kind="json_field_equals", path="a", expected=True), '{"a": true}').passed
    assert not grade(make(kind="json_field_equals", path="a", expected=True), '{"a": 1}').passed
    assert grade(make(kind="json_field_equals", path="a.b", expected=None), '{"a": {"b": null}}').passed
    assert not grade(make(kind="json_field_equals", path="a.c", expected=None), '{"a": {"b": null}}').passed


def test_json_field_one_of_and_path_contains_all() -> None:
    """Two acceptable categories, and a set of connectors a workflow must use."""
    assert grade(
        make(kind="json_field_one_of", path="category", options=["late", "other"]), '{"category":"other"}'
    ).passed
    graph = (
        '{"nodes": [{"kind": "connector", "connector": "stock_check"}, {"kind": "connector", "connector": "email"}]}'
    )
    assert grade(
        make(kind="json_path_contains_all", path="nodes.*.connector", values=["email", "stock_check"]), graph
    ).passed
    missing = grade(make(kind="json_path_contains_all", path="nodes.*.connector", values=["webhook"]), graph)
    assert not missing.passed


def test_number_within_uses_a_share_of_the_expected_value() -> None:
    """A tolerance of one percent on 200 allows 2 either way."""
    grader = make(kind="number_within", path="total", expected=200, tolerance=0.01)
    assert grade(grader, '{"total": 201.5}').passed
    assert not grade(grader, '{"total": 203}').passed
    assert not grade(grader, '{"total": "200"}').passed


def test_length_bounds_on_the_whole_output_or_a_field() -> None:
    """Length is counted in characters, on the output or on one text field of it."""
    assert grade(make(kind="length_bounds", max_chars=5), "abc").passed
    assert not grade(make(kind="length_bounds", min_chars=4, max_chars=5), "abc").passed
    assert grade(make(kind="length_bounds", path="answer", max_chars=10), '{"answer": "short"}').passed


def test_citation_present_looks_in_every_sentence() -> None:
    """A cited passage may be cited by any sentence of the draft."""
    draft = (
        '{"sentences": [{"text": "a", "sources": ["order:BB-1040"]}, '
        '{"text": "b", "sources": ["passage:late.parcels"]}]}'
    )
    assert grade(make(kind="citation_present", path="sentences.*.sources", ids=["passage:late.parcels"]), draft).passed
    missing = grade(make(kind="citation_present", path="sentences.*.sources", ids=["passage:returns"]), draft)
    assert not missing.passed
    assert "passage:returns" in missing.detail


def test_sql_structural_compares_shape_and_tree() -> None:
    """Shape: the same tables and aggregates. Tree: the same normalised statement."""
    reference = (
        "SELECT SUM(order_lines.line_total_czk) FROM orders JOIN order_lines ON order_lines.order_id = orders.order_id"
    )
    same_shape = (
        '{"sql": "select sum(ol.line_total_czk) as revenue from ORDERS o '
        "join order_lines ol on ol.order_id = o.order_id where o.status = 'paid'\"}"
    )
    assert grade(make(kind="sql_structural", path="sql", reference=reference), same_shape).passed
    other_shape = '{"sql": "SELECT COUNT(*) FROM orders"}'
    result = grade(make(kind="sql_structural", path="sql", reference=reference), other_shape)
    assert not result.passed
    assert "tables" in result.detail
    assert grade(
        make(kind="sql_structural", path="sql", reference=reference, compare="ast"), f'{{"sql": "{reference}"}}'
    ).passed
    assert not grade(make(kind="sql_structural", path="sql", reference=reference, compare="ast"), same_shape).passed
    assert "not parse" in grade(make(kind="sql_structural", path="sql", reference=reference), '{"sql": "SELEC"}').detail
    assert not grade(make(kind="sql_structural", path="sql", reference=reference), '{"sql": null}').passed


def test_a_case_passes_only_when_every_grader_does() -> None:
    """The lab's unit of score is the case, and a case is all of its graders."""
    graders = [make(kind="contains_all", values=["a"]), make(kind="contains_none", values=["b"])]
    assert passed_all(grade_all(graders, "a"))
    assert not passed_all(grade_all(graders, "a b"))
