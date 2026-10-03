"""Tests for the eval pack reader: its rules, the committed packs, and the LB-05 exporter's drift check."""

from pathlib import Path
from typing import Any

import pytest
import yaml
from pydantic import ValidationError

from core.data_files import DataFileError
from core.platform import REPOSITORY_ROOT
from lb05.pack import MADE_BY, PACK_FILE, SOURCE, export_pack
from lb10.pack_writer import render_pack
from lb10.packs import MIN_CASES, EvalPack, pack_version, read_pack, read_packs
from lb10.sampling import MIN_HARD, SAMPLE_SIZE, sample_cases
from lb10.templates import render

SEED_DIRECTORY = REPOSITORY_ROOT / "data" / "seed"


def small_pack(**changes: Any) -> dict[str, Any]:
    """Build a valid pack of twelve cases in its YAML form, with `changes` applied on top."""
    cases = [
        {
            "id": f"case-{number}",
            "difficulty": "hard" if number < 4 else "easy",
            "inputs": {"ticket": f"ticket {number}", "language": "English"},
            "expected": {"category": "late"},
            "graders": [{"kind": "json_field_equals", "path": "category", "expected": "late"}],
        }
        for number in range(12)
    ]
    pack: dict[str, Any] = {
        "pack": "test-pack",
        "system": "lb-01",
        "target": {
            "name": "A test target",
            "description": "A prompt that exists only in this test.",
            "source": "tests/unit/test_lb10_packs.py",
            "alias": "lb-fast",
            "model_class": "fast",
            "max_output_tokens": 200,
            "output": "json",
        },
        "prompt": {"system": "Write in {{language}}.", "user": "<ticket>\n{{ticket}}\n</ticket>"},
        "variables": ["language"],
        "cases": cases,
    }
    pack.update(changes)
    return pack


def test_a_valid_pack_is_read_and_versioned_by_content() -> None:
    """The version is a hash of the content: the same pack gives the same version, a changed case another."""
    pack = EvalPack.model_validate(small_pack())
    again = EvalPack.model_validate(small_pack())
    assert pack.version() == again.version() == pack_version(pack)
    changed = small_pack()
    changed["cases"][0]["inputs"]["ticket"] = "another ticket"
    assert EvalPack.model_validate(changed).version() != pack.version()
    assert len(pack.version()) == 16


def test_variables_must_be_the_system_templates_placeholders() -> None:
    """A pack that lists a variable the prompt doesn't use, or misses one it does, is refused."""
    with pytest.raises(ValidationError, match="placeholders"):
        EvalPack.model_validate(small_pack(variables=[]))
    with pytest.raises(ValidationError, match="placeholders"):
        EvalPack.model_validate(small_pack(variables=["language", "today"]))


def test_every_case_fills_both_templates_and_nothing_more() -> None:
    """An input the templates don't use, or a placeholder no input fills, names the case."""
    pack = small_pack()
    pack["cases"][3]["inputs"] = {"ticket": "t"}
    with pytest.raises(ValidationError, match=r"case 'case-3'.*missing \['language'\]"):
        EvalPack.model_validate(pack)
    pack = small_pack()
    pack["cases"][5]["inputs"]["extra"] = "x"
    with pytest.raises(ValidationError, match="unknown \\['extra'\\]"):
        EvalPack.model_validate(pack)


def test_tools_go_with_tool_calls_and_nowhere_else() -> None:
    """A tool-calling pack needs tools; a JSON pack must not carry any."""
    tool = {"name": "update_details", "description": "Record details.", "parameters": {"type": "object"}}
    with pytest.raises(ValidationError, match="only a tool-calling pack"):
        EvalPack.model_validate(small_pack(tools=[tool]))
    target = {**small_pack()["target"], "output": "tool_calls"}
    with pytest.raises(ValidationError, match="needs its tools"):
        EvalPack.model_validate(small_pack(target=target))
    assert EvalPack.model_validate(small_pack(target=target, tools=[tool])).tools[0].name == "update_details"


def test_cases_need_distinct_ids_a_hard_case_and_a_grader() -> None:
    """The sampler relies on hard cases, and a case with no rule would always pass."""
    pack = small_pack()
    pack["cases"][1]["id"] = "case-0"
    with pytest.raises(ValidationError, match="more than once"):
        EvalPack.model_validate(pack)
    pack = small_pack()
    for case in pack["cases"]:
        case["difficulty"] = "easy"
    with pytest.raises(ValidationError, match="hard case"):
        EvalPack.model_validate(pack)
    pack = small_pack()
    pack["cases"][2]["graders"] = []
    with pytest.raises(ValidationError, match="no grader: case-2"):
        EvalPack.model_validate(pack)
    pack["common_graders"] = [{"kind": "length_bounds", "max_chars": 500}]
    read = EvalPack.model_validate(pack)
    assert [grader.kind for grader in read.graders_of(read.cases[2])] == ["length_bounds"]
    assert [grader.kind for grader in read.graders_of(read.cases[0])] == ["length_bounds", "json_field_equals"]


def test_too_few_cases_or_an_unknown_field_is_refused() -> None:
    """Ten cases is the least a sample of ten can be drawn from, and the reader is strict."""
    pack = small_pack()
    pack["cases"] = pack["cases"][: MIN_CASES - 1]
    with pytest.raises(ValidationError):
        EvalPack.model_validate(pack)
    with pytest.raises(ValidationError, match="extra"):
        EvalPack.model_validate(small_pack(notes="hand-written"))


def test_read_packs_refuses_a_file_named_after_another_pack(tmp_path: Path) -> None:
    """A pack file is named after its pack, so the board and the cache name the same thing."""
    (tmp_path / "wrong-name.yaml").write_text(yaml.safe_dump(small_pack()), encoding="utf-8")
    with pytest.raises(DataFileError, match="named after a different pack"):
        read_packs(tmp_path)
    (tmp_path / "wrong-name.yaml").unlink()
    (tmp_path / "test-pack.yaml").write_text(yaml.safe_dump(small_pack()), encoding="utf-8")
    assert list(read_packs(tmp_path)) == ["test-pack"]


def test_every_committed_pack_is_valid_and_names_its_system() -> None:
    """The four systems' exporters write files this reader accepts, each at least ten cases with hard ones."""
    packs = read_packs()
    assert set(packs) >= {"lb01-classifier", "lb01-drafter", "lb02-planner", "lb05-sql-writer", "lb08-generator"}
    for name, pack in packs.items():
        assert name == pack.pack
        assert len(pack.cases) >= MIN_CASES
        assert pack.hard_cases()
        for case in pack.cases:
            render(pack.prompt.system, case.inputs)
            render(pack.prompt.user, case.inputs)


def test_the_committed_lb05_pack_is_what_the_exporter_writes_today() -> None:
    """The drift check: the file in evals/packs is the production prompt and golden set, materialised now."""
    content, pack = export_pack(SEED_DIRECTORY)
    assert render_pack(content, MADE_BY, SOURCE) == PACK_FILE.read_text(encoding="utf-8")
    assert read_pack(PACK_FILE).version() == pack.version()
    assert pack.target.alias == "lb-reason"
    assert [grader.kind for grader in pack.common_graders] == ["json_schema", "json_field_equals"]


def test_the_sample_is_fixed_stratified_and_keeps_the_hard_cases() -> None:
    """Ten cases, the same ten every time for one version, with at least the minimum of hard ones."""
    pack = EvalPack.model_validate(small_pack())
    sample = sample_cases(pack)
    assert len(sample) == SAMPLE_SIZE
    assert [case.id for case in sample] == [case.id for case in sample_cases(pack)]
    assert sum(case.difficulty == "hard" for case in sample) >= MIN_HARD
    assert [case.id for case in sample] == [case.id for case in pack.cases if case.id in {c.id for c in sample}]
    for committed in read_packs().values():
        drawn = sample_cases(committed)
        assert len(drawn) == min(SAMPLE_SIZE, len(committed.cases))
        assert sum(case.difficulty == "hard" for case in drawn) >= min(MIN_HARD, len(committed.hard_cases()))


def test_a_small_pack_is_sampled_whole() -> None:
    """A pack of ten cases is its own sample."""
    pack = small_pack()
    pack["cases"] = pack["cases"][:10]
    read = EvalPack.model_validate(pack)
    assert [case.id for case in sample_cases(read)] == [case.id for case in read.cases]
