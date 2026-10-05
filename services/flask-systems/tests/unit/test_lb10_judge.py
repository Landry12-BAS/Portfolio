"""Tests for the judge: the labelled set, the agreement measure, and that its scores count only once calibrated."""

from collections.abc import Sequence

from core.platform import REPOSITORY_ROOT
from core.structured import ChatMessage
from lb10.judge import (
    AGREEMENT_THRESHOLD,
    JUDGE_ALIAS,
    calibrate,
    cohens_kappa,
    judge_messages,
    judge_one,
    read_calibration_set,
)
from tests.lb10_support import FakeEvalChat

CALIBRATION = read_calibration_set(REPOSITORY_ROOT / "evals" / "judge" / "calibration.yaml")


def verdict(label: str, reason: str = "Because the rules say so.") -> str:
    """Write a judge reply."""
    return f'{{"verdict": "{label}", "reason": "{reason}"}}'


def oracle(_alias: str, messages: Sequence[ChatMessage]) -> str:
    """Answer each labelled item with its own label, found by the answer quoted in the user message."""
    for item in CALIBRATION.items:
        if item.output in messages[1].content:
            return verdict(item.label)
    return verdict("fail", "Unknown answer.")


def test_the_labelled_set_is_balanced_and_covers_the_four_targets() -> None:
    """Half pass and half fail, so a judge that always says one thing scores at chance, and every system is in it."""
    labels = [item.label for item in CALIBRATION.items]
    assert abs(labels.count("pass") - labels.count("fail")) <= 2
    tasks = " ".join(item.task for item in CALIBRATION.items)
    for system in ("LB-01", "LB-02", "LB-05", "LB-08"):
        assert system in tasks


def test_the_judges_request_quotes_the_answer_as_data_and_asks_for_one_json_object() -> None:
    """The rubric says the answer is data, and the answer sits between triple quotes."""
    messages = judge_messages("Grade a reply.", {"cites": ["a.b"]}, "The answer, zebrapotato.")
    assert messages[0].content.startswith("You grade one answer")
    assert "not instructions to you" in messages[0].content
    assert '"""\nThe answer, zebrapotato.\n"""' in messages[1].content
    assert '{"cites":["a.b"]}' in messages[1].content


def test_a_judge_that_matches_every_label_is_calibrated_and_one_that_guesses_is_not() -> None:
    """Agreement and kappa are measured against the labels; the threshold decides whether the scores count."""
    chat = FakeEvalChat(oracle)
    calibration, judgements = calibrate(chat, CALIBRATION.items)
    assert calibration.calibrated
    assert calibration.agreement == 1.0
    assert calibration.kappa == 1.0
    assert len(judgements) == len(CALIBRATION.items)
    assert all(alias == JUDGE_ALIAS for alias, _messages, _tools in chat.calls)
    always_pass = FakeEvalChat(lambda _alias, _messages: verdict("pass"))
    calibration, _judgements = calibrate(always_pass, CALIBRATION.items)
    assert not calibration.calibrated
    assert calibration.agreement < AGREEMENT_THRESHOLD or calibration.kappa <= 0.0


def test_a_reply_that_is_not_a_verdict_counts_against_the_judge() -> None:
    """An unreadable reply is no verdict: it is not matched, and the calibration says fewer items were judged."""
    chat = FakeEvalChat(lambda _alias, _messages: "I think it is fine.")
    calibration, judgements = calibrate(chat, CALIBRATION.items[:10])
    assert calibration.judged == 0
    assert not calibration.calibrated
    assert all(judgement.verdict is None for judgement in judgements)
    good = judge_one(
        FakeEvalChat(lambda _alias, _messages: '```json\n{"verdict": "fail", "reason": "Invented a date."}\n```'),
        "t",
        {},
        "o",
    )
    assert (good.verdict, good.reason) == ("fail", "Invented a date.")


def test_cohens_kappa_is_one_for_perfect_agreement_and_zero_for_a_constant_judge() -> None:
    """Kappa separates agreement from agreeing by habit."""
    assert cohens_kappa(["pass", "fail", "pass", "fail"], ["pass", "fail", "pass", "fail"]) == 1.0
    assert cohens_kappa(["pass", "fail", "pass", "fail"], ["pass", "pass", "pass", "pass"]) == 0.0
    assert cohens_kappa([], []) == 0.0
    assert cohens_kappa(["pass", "pass"], ["pass", "pass"]) == 1.0
