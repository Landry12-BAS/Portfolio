"""Tests for the nightly eval, the gate, the judge command and the advisor, on a fake model and a results file."""

from collections.abc import Sequence
from pathlib import Path

import pytest
import yaml

from core.data_files import DataFileError
from core.structured import ChatMessage
from lb10.baselines import read_baselines
from lb10.evals import (
    GATE_SAMPLE,
    ResultsFile,
    VariantRecord,
    advice_lines,
    advise_lb10,
    baseline_of,
    read_results,
    run_gate,
    run_judge,
    run_nightly,
)
from lb10.packs import read_packs
from lb10.templates import render
from tests.lb10_support import CLASSIFIER, FakeEvalChat, classification, right_answer
from tests.support import TODAY, make_platform

PACKS = read_packs()


def answer_rightly(_alias: str, messages: Sequence[ChatMessage]) -> str:
    """Answer every case of every pack as the golden set expects, from the user message; the judge agrees."""
    if messages[0].content.startswith("You grade one answer"):
        return '{"verdict": "pass", "reason": "Meets the requirements."}'
    for pack in PACKS.values():
        for case in pack.cases:
            if messages[1].content == render(pack.prompt.user, case.inputs):
                if pack.pack == CLASSIFIER:
                    return right_answer(pack, case.id)
                return classification("late")
    raise AssertionError("asked about a case no pack has")


def nightly(tmp_path: Path, chat: FakeEvalChat | None = None, *extra: str) -> tuple[int, Path]:
    """Run the nightly on the classifier pack on Groq into `tmp_path`, and return the status and the results file."""
    status = run_nightly(
        ["--pack", CLASSIFIER, "--provider", "groq", "--out", str(tmp_path), *extra],
        make_platform(),
        chat or FakeEvalChat(answer_rightly),
    )
    return status, tmp_path / f"nightly-{TODAY.date().isoformat()}.json"


def test_the_nightly_writes_a_results_file_of_the_production_prompt_on_each_provider(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Ten cases of the pack on Groq, the production prompt only, with the score and every case, as a file."""
    status, path = nightly(tmp_path)
    assert status == 0
    results = read_results(path)
    assert results.sample_size == 10
    assert [record.alias for record in results.results] == ["lb-eval-groq-20b"]
    record = results.results[0]
    assert (record.pack, record.model_class, record.provider) == (CLASSIFIER, "fast", "groq")
    assert record.score.mean == 1.0
    assert len(record.cases) == 10
    assert record.model_calls == 10
    assert record.cached_calls == 0
    out = capsys.readouterr().out
    assert "lb01-classifier" in out
    assert "No lb10 database" in out


def test_the_nightly_refuses_an_unknown_pack_or_provider_and_needs_a_gateway(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Each mistake is named, and nothing runs without the gateway."""
    assert run_nightly(["--pack", "lb99-nothing"], make_platform(), FakeEvalChat(answer_rightly)) == 2
    assert run_nightly(["--provider", "nvidia"], make_platform(), FakeEvalChat(answer_rightly)) == 2
    assert run_nightly([], make_platform(), None) == 1
    assert "needs the gateway" in capsys.readouterr().err


def test_the_gate_reports_a_pack_with_no_baseline_writes_one_when_asked_and_then_passes(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Offline on the nightly's file: NO BASELINE first, a baseline written, then PASS against it."""
    _status, results = nightly(tmp_path)
    baselines = tmp_path / "baselines"
    assert run_gate(["--results", str(results), "--baselines", str(baselines)], make_platform(), None) == 0
    out = capsys.readouterr().out
    assert "NO BASELINE" in out
    assert "only reported" in out
    assert run_gate(["--results", str(results), "--baselines", str(baselines), "--strict"], make_platform(), None) == 1
    assert (
        run_gate(["--results", str(results), "--baselines", str(baselines), "--write-baselines"], make_platform(), None)
        == 0
    )
    written = read_baselines(baselines)
    assert [(entry.pack, entry.alias, entry.score, entry.source) for entry in written] == [
        (CLASSIFIER, "lb-eval-groq-20b", 1.0, "offline")
    ]
    assert (baselines / f"{CLASSIFIER}.yaml").read_text().startswith("# The baselines of lb01-classifier")
    assert run_gate(["--results", str(results), "--baselines", str(baselines), "--strict"], make_platform(), None) == 0
    assert "PASS " in capsys.readouterr().out


def test_the_gate_fails_on_a_score_below_the_baselines_margin_and_not_on_noise(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """A fresh score inside the baseline's interval passes; one below its lower bound is a regression."""
    _status, results = nightly(tmp_path)
    baselines = tmp_path / "baselines"
    baselines.mkdir()
    record = read_results(results).results[0]
    entry = {
        "pack": record.pack,
        "pack_version": record.pack_version,
        "alias": record.alias,
        "score": 0.9,
        "low": 0.7,
        "high": 1.0,
        "cases": 10,
        "measured_on": "2026-10-01",
        "source": "live",
    }
    (baselines / f"{CLASSIFIER}.yaml").write_text(yaml.safe_dump({"baselines": [entry]}))
    assert run_gate(["--results", str(results), "--baselines", str(baselines)], make_platform(), None) == 0

    def worse(_alias: str, messages: Sequence[ChatMessage]) -> str:
        """Fail every case."""
        return classification("other", "BB-0000") if not messages[0].content.startswith("You grade") else ""

    _status, bad = nightly(tmp_path / "bad", FakeEvalChat(worse))
    assert run_gate(["--results", str(bad), "--baselines", str(baselines)], make_platform(), None) == 1
    assert "REGRESSION" in capsys.readouterr().out
    other = VariantRecord.model_validate({**record.model_dump(mode="json"), "pack_version": "ffffffffffffffff"})
    assert baseline_of(read_baselines(baselines), other)[0] == "other_version"


def test_the_gate_live_uses_the_visitor_providers_and_twenty_cases(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Without a results file the gate runs the packs itself: on Groq and Workers AI, 20 cases each, synthetic."""
    chat = FakeEvalChat(answer_rightly)
    status = run_gate(["--baselines", str(tmp_path / "none"), "--provider", "groq"], make_platform(), chat)
    assert status == 0
    assert len(chat.calls) == sum(min(GATE_SAMPLE, len(pack.cases)) for pack in PACKS.values())
    assert all(alias.startswith("lb-eval-groq-") for alias, _messages, _tools in chat.calls)
    assert all(run is not None and run.data_class == "synthetic" for run in chat.runs)
    assert run_gate([], make_platform(), None) == 1
    assert "needs the gateway" in capsys.readouterr().err


def test_the_judge_calibrates_then_grades_the_nightlys_answers_and_says_whether_it_counts(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """A judge that agrees with the labels counts; one that cannot read them does not, and the report says so."""
    _status, results = nightly(tmp_path)
    from tests.unit.test_lb10_judge import CALIBRATION

    def agreeable(_alias: str, messages: Sequence[ChatMessage]) -> str:
        """Label the calibration items rightly, and pass every case."""
        for item in CALIBRATION.items:
            if item.output in messages[1].content:
                return f'{{"verdict": "{item.label}", "reason": "As labelled."}}'
        return '{"verdict": "pass", "reason": "Fine."}'

    status = run_judge(["--results", str(results), "--out", str(tmp_path)], make_platform(), FakeEvalChat(agreeable))
    assert status == 0
    out = capsys.readouterr().out
    assert "its scores count" in out
    assert "judge 100.0%" in out
    assert "agreement 100.0%" in out
    assert (tmp_path / f"judge-{TODAY.date().isoformat()}.json").exists()
    blind = FakeEvalChat(lambda _alias, _messages: '{"verdict": "pass", "reason": "Always."}')
    assert run_judge(["--results", str(results)], make_platform(), blind) == 0
    assert "DOES NOT COUNT" in capsys.readouterr().out
    assert run_judge(["--results", str(results)], make_platform(), None) == 1


def test_the_advisor_names_the_fallbacks_that_pass_on_every_pack_of_a_route(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Advice per route from the results, and the reminder that it changes nothing."""
    _status, results = nightly(tmp_path)
    file = read_results(results)
    lines = advice_lines(file, 0.8)
    assert lines[0].startswith("lb-fast (lb01-classifier)")
    assert any("lb-eval-groq-20b" in line and "may serve" in line for line in lines)
    assert "lb-tools: no results in the file." in lines
    assert advise_lb10(["--results", str(results)], make_platform()) == 0
    assert "changes nothing in services/gateway/routing.yaml" in capsys.readouterr().out
    assert advise_lb10(["--results", str(tmp_path / "missing.json")], make_platform()) == 1
    (tmp_path / "bad.json").write_text("{}")
    with pytest.raises(DataFileError, match="results file"):
        read_results(tmp_path / "bad.json")
    assert ResultsFile.model_validate_json(results.read_text()).format == 1
