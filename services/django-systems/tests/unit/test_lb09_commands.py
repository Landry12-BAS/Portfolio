"""Unit tests for LB-09's live commands, driven by fakes: the golden eval and the word-error-rate run.

Neither has been run against a real model here. These prove that the commands do what they say when the
gateway is replaced by a script: the eval prints each case and fails under the gate, and the WER run decodes the
committed audio, transcribes it with the chosen mode and reports the rate.
"""

import io
from pathlib import Path

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from lb09.golden import read_golden_set
from lb09.management.commands import eval_lb09, wer_lb09
from lb09.scripts import read_scripts
from lb09.storage import AudioStore
from lb09.textnorm import words_of
from lb09.timeline import estimate_turn_spans
from lb09.transcript import Segment

from tests.lb09_support import (
    StubTranscriber,
    build_pipeline,
    oracle_extract_reply,
    oracle_label_reply,
    script_transcript_segments,
)
from tests.support import FakeChat


def test_the_eval_command_runs_the_chosen_cases_and_reports_the_scores(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """With a model that answers as expected, the samples pass the gate and the output names each case."""
    golden, scripts = read_golden_set(), read_scripts()
    samples = golden.samples()
    chat = FakeChat(
        replies={
            "lb-fast": [oracle_label_reply(case, scripts[case.meeting]) for case in samples],
            "lb-tools": [oracle_extract_reply(case) for case in samples],
        }
    )
    pipeline, _ = build_pipeline(chat, AudioStore(tmp_path))
    monkeypatch.setattr(eval_lb09, "connect_pipeline", lambda: pipeline)
    out = io.StringIO()
    call_command("eval_lb09", "--samples", stdout=out)
    printed = out.getvalue()
    assert all(f"ok    {case.id}" in printed for case in samples)
    assert "recall 1.00" in printed
    assert f"{len(samples)} cases pass the gate." in printed
    assert len(chat.requests) == 2 * len(samples)


def test_the_eval_command_fails_under_the_gate(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """A model that finds nothing fails recall, and the command says so."""
    chat = FakeChat(
        replies={
            "lb-fast": ['{"speakers": [{"id": 0, "name": null}], "turns": [{"segment": 0, "speaker": 0}]}'],
            "lb-tools": ['{"decisions": [], "actions": []}'],
        }
    )
    pipeline, _ = build_pipeline(chat, AudioStore(tmp_path))
    monkeypatch.setattr(eval_lb09, "connect_pipeline", lambda: pipeline)
    with pytest.raises(CommandError, match=r"recall 0\.00 is under the gate"):
        call_command("eval_lb09", "--case", "monday-roasting-plan", stdout=io.StringIO())


def test_the_eval_command_refuses_an_unknown_case() -> None:
    """A typo in a case ID is an error before any call is made."""
    with pytest.raises(CommandError, match="No golden case has the ID"):
        call_command("eval_lb09", "--case", "no-such-case", stdout=io.StringIO())


def test_the_wer_command_transcribes_the_committed_audio_and_reports_the_rate(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The stub hears the script of the grinder meeting with one word wrong: the rate is one over its words."""
    script = read_scripts()["grinder-repair"]
    heard: list[Segment] = script_transcript_segments(script, estimate_turn_spans(script))
    heard[0] = Segment(0, heard[0].start, heard[0].end, heard[0].text.replace("grinder", "grander", 1))
    transcriber = StubTranscriber(segments=heard, mode="private", model="local/faster-whisper/stub")
    pipeline, _ = build_pipeline(FakeChat(replies={}), AudioStore(tmp_path), transcriber=transcriber)
    monkeypatch.setattr(wer_lb09, "connect_pipeline", lambda: pipeline)
    out = io.StringIO()
    call_command("wer_lb09", "--mode", "private", "--meeting", "grinder-repair", stdout=out)
    printed = out.getvalue()
    words = len(words_of(" ".join(turn.text for turn in script.turns)))
    assert f"grinder-repair: WER {1 / words:.3f} (1 edits over {words} words, local/faster-whisper/stub)" in printed
    assert "Overall WER" in printed
    assert "private mode" in printed
    # The committed audio was decoded and handed over as 16 kHz PCM, in English.
    assert transcriber.heard[0][1] == "en"
    assert transcriber.heard[0][0] > 20 * 32_000
