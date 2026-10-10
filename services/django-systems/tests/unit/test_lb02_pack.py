"""Tests for LB-02's eval pack: the planner's first turn, with the tools, as production sends it."""

from django.conf import settings

from core.packs import packs_directory, render, render_pack
from lb02.golden import read_golden_set
from lb02.pack import MADE_BY, PACK_NAME, SOURCE, export_pack, gradable_cases
from lb02.states import Step, tools_offered

SEED = settings.SEED_DIR / "lb02"


def test_the_pack_offers_the_details_steps_tools_and_a_fresh_state() -> None:
    """A conversation starts at the details step with nothing recorded, and the model sees those tools only."""
    pack = export_pack(SEED)
    assert [tool["name"] for tool in pack["tools"]] == [tool.value for tool in tools_offered(Step.DETAILS)]
    assert pack["target"]["output"] == "tool_calls"
    first = pack["cases"][0]
    system = render(pack["prompt"]["system"], first["inputs"])
    assert "- Step: details" in system
    assert "- Options: none on offer" in system
    assert "Thursday 2026-10-01" in system
    assert set(pack["variables"]) == {"language", "offerings", "today", "first_day", "last_day", "party_limit"}


def test_every_gradable_first_turn_is_in_the_pack_with_its_rules() -> None:
    """The cases are the conversations whose first turn names a tool, arguments or forbidden text."""
    pack = export_pack(SEED)
    golden = read_golden_set()
    assert [case["id"] for case in pack["cases"]] == [case.id for case in gradable_cases(golden)]
    assert all(case["graders"] for case in pack["cases"])
    booking = next(case for case in pack["cases"] if case["id"] == "book-cupping-en")
    kinds = [(grader["kind"], grader.get("path")) for grader in booking["graders"]]
    assert ("json_field_equals", "tool_calls.0.name") in kinds
    assert ("json_field_equals", "tool_calls.0.arguments.offering") in kinds
    assert "@" not in booking["inputs"]["message"]


def test_the_committed_lb02_pack_is_what_the_exporter_writes_today() -> None:
    """The drift check: the file in evals/packs is the production prompt and golden set, materialised now."""
    path = packs_directory() / f"{PACK_NAME}.yaml"
    assert path.read_text(encoding="utf-8") == render_pack(export_pack(SEED), MADE_BY, SOURCE)
