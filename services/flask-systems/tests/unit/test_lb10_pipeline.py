"""Tests for the eval pipeline on fakes: the cache, the fan-out, the grades, the report and the spans."""

import asyncio
from collections.abc import Callable, Sequence
from typing import Any

import pytest
from openai import OpenAIError
from pydantic import ValidationError

from core.structured import ChatMessage
from lb10.pipeline import FAILURE_BUDGET, FAILURE_NO_ANSWERS, EvalPipeline, RunFailedError, RunRequest, plan_variants
from lb10.prompt_check import production_prompt_hash
from lb10.report import ReportOut
from lb10.sampling import sample_cases
from lb10.templates import render
from lb_common.gateway import GatewayResponseError
from lb_common.tracing import Tracer
from tests.lb10_support import CLASSIFIER, FakeEvalChat, MemoryResultStore, classification, committed_pack, right_answer
from tests.support import TODAY, MemorySpanWriter

PACK = committed_pack(CLASSIFIER)
SAMPLE = sample_cases(PACK)
EDITED = PACK.prompt.system + "\nBe brief."


async def run_in_thread(function: Callable[..., Any], *arguments: Any) -> Any:
    """Stand in for the runner's offload: the fakes block for no time, so a thread is not needed."""
    return function(*arguments)


class SpentError(OpenAIError):
    """A gateway answer saying the day's budget is used up, as the client raises it."""

    code = "budget_exhausted"


def budget_error() -> OpenAIError:
    """Make the error the gateway client raises when a budget is spent."""
    return SpentError("spent")


def answer_by_case(_alias: str, messages: Sequence[ChatMessage]) -> str:
    """Answer each case rightly, whatever the alias: the user message names the ticket of exactly one case."""
    for case in PACK.cases:
        if render(PACK.prompt.user, case.inputs) == messages[1].content:
            return right_answer(PACK, case.id)
    raise AssertionError("the pipeline asked about a ticket no case has")


def make_pipeline(
    chat: FakeEvalChat, store: MemoryResultStore | None = None
) -> tuple[EvalPipeline, MemorySpanWriter, MemoryResultStore]:
    """Build a pipeline on fakes."""
    spans = MemorySpanWriter()
    memory = store or MemoryResultStore()
    return EvalPipeline(chat, memory, Tracer(spans), run_in_thread, lambda: TODAY), spans, memory


def request(prompt: str = EDITED, providers: Sequence[str] = ("groq",), run_id: str = "run-0000000001") -> RunRequest:
    """Build a visitor's request on the classifier's sample."""
    return RunRequest(
        run_id=run_id,
        pack=PACK,
        cases=SAMPLE,
        prompt=prompt,
        providers=providers,
        data_class="visitor",
        session_key="session-of-sam-visitor-0001",
    )


def test_the_plan_runs_production_and_the_edit_on_each_provider_and_skips_an_unchanged_prompt() -> None:
    """Two prompts on two providers is four variants; the production prompt alone is two."""
    plans = plan_variants(request(providers=("groq", "workers-ai")))
    assert [(plan.variant, plan.alias) for plan in plans] == [
        ("production", "lb-eval-groq-20b"),
        ("edited", "lb-eval-groq-20b"),
        ("production", "lb-eval-cf-20b"),
        ("edited", "lb-eval-cf-20b"),
    ]
    assert plans[0].prompt_hash == production_prompt_hash(PACK)
    assert [plan.variant for plan in plan_variants(request(prompt=PACK.prompt.system))] == ["production"]


def test_a_run_grades_every_case_compares_with_production_and_reports_its_cost() -> None:
    """Twenty calls on one provider, every case passing on both prompts: no detectable difference, and a trace."""
    chat = FakeEvalChat(answer_by_case)
    pipeline, spans, store = make_pipeline(chat)
    progress: list[tuple[int, int]] = []

    report = asyncio.run(pipeline.run(request(), lambda done, cached: progress.append((done, cached))))

    assert isinstance(report, ReportOut)
    assert len(chat.calls) == 20
    assert report.total_model_calls == 20
    assert report.total_cached_calls == 0
    assert [variant.variant for variant in report.variants] == ["production", "edited"]
    assert all(variant.score.mean == 1.0 for variant in report.variants)
    assert report.comparisons[0].verdict == "no_detectable_difference"
    assert report.comparisons[0].changed == []
    assert report.sample_size == 10
    assert len(report.case_ids) == 10
    assert progress[-1] == (20, 0)
    assert len(store.rows) == 20
    # The run's spans: the root, the cache read and one span per call, none of them holding the prompt or an answer.
    assert spans.names().count("model call") == 20
    assert spans.names()[-1] == "eval run"
    root = spans.named("eval run")
    assert root.attrs["outcome"] == "done"
    assert root.attrs["model_calls"] == 20
    for span in spans.spans:
        for value in span.attrs.values():
            assert "Be brief" not in str(value)
            assert "ticket" not in str(value).lower()
    assert all(run is not None and run.system == "lb-10" and run.data_class == "visitor" for run in chat.runs)
    assert all(timeout == 60.0 for timeout in chat.timeouts)
    assert all(
        call[1][0].content.endswith("Be brief.") for call in chat.calls if call[1][0].content != PACK.prompt.system
    )


def test_the_production_baseline_is_read_from_the_cache_on_the_next_run() -> None:
    """A second visitor on the same pack spends calls on their own prompt only."""
    first_chat = FakeEvalChat(answer_by_case)
    pipeline, _spans, store = make_pipeline(first_chat)
    asyncio.run(pipeline.run(request(), lambda _done, _cached: None))
    second_chat = FakeEvalChat(answer_by_case)
    pipeline, _spans, store = make_pipeline(second_chat, store)

    again = request(prompt=EDITED + " Really.", run_id="run-0000000002")
    report = asyncio.run(pipeline.run(again, lambda _done, _cached: None))

    assert len(second_chat.calls) == 10
    assert report.total_cached_calls == 10
    assert report.total_model_calls == 10
    production = next(variant for variant in report.variants if variant.variant == "production")
    assert production.cached_calls == 10
    assert all(case.cached for case in production.cases)


def test_a_changed_case_is_listed_with_both_outputs_and_a_regression_is_a_regression() -> None:
    """An edited prompt that makes the model answer `other` on every case regresses, and the cases say why."""

    def worse_when_edited(alias: str, messages: Sequence[ChatMessage]) -> str:
        """Answer rightly under the production prompt and wrongly under the edited one."""
        if messages[0].content == PACK.prompt.system:
            return answer_by_case(alias, messages)
        return classification("other", "BB-9999")

    pipeline, _spans, _store = make_pipeline(FakeEvalChat(worse_when_edited))

    report = asyncio.run(pipeline.run(request(), lambda _done, _cached: None))

    comparison = report.comparisons[0]
    assert comparison.verdict == "worse"
    assert comparison.regressed == len(comparison.changed) > 0
    changed = comparison.changed[0]
    assert changed.change == "regressed"
    assert changed.production.passed
    assert not changed.edited.passed
    assert "BB-9999" in changed.edited.output
    assert any(not grade.passed for grade in changed.edited.grades)
    assert changed.inputs == dict(PACK.case_by_id(changed.case_id).inputs)


def test_a_malformed_reply_is_a_failed_case_and_never_a_repair_call() -> None:
    """The reply is graded as it is: one call a case, and the schema grader names what was wrong."""
    pipeline, _spans, _store = make_pipeline(FakeEvalChat(lambda _alias, _messages: "I cannot classify this."))

    report = asyncio.run(pipeline.run(request(prompt=PACK.prompt.system), lambda _done, _cached: None))

    assert len(report.variants) == 1
    assert report.variants[0].score.mean == 0.0
    assert report.variants[0].model_calls == 10
    assert report.variants[0].cases[0].grades[0].kind == "json_schema"
    assert not report.variants[0].cases[0].grades[0].passed


def test_a_failed_call_is_a_failed_case_with_the_gateways_code_and_is_not_cached() -> None:
    """One call that fails is stored as an error row, counted as failed, and asked again next time."""
    calls = {"count": 0}

    def fail_once(alias: str, messages: Sequence[ChatMessage]) -> str | Exception:
        """Fail the first call and answer the rest."""
        calls["count"] += 1
        if calls["count"] == 1:
            return GatewayResponseError("the gateway answered oddly")
        return answer_by_case(alias, messages)

    pipeline, spans, store = make_pipeline(FakeEvalChat(fail_once))
    report = asyncio.run(pipeline.run(request(prompt=PACK.prompt.system), lambda _done, _cached: None))

    variant = report.variants[0]
    assert variant.failed_calls == 1
    failed = next(case for case in variant.cases if case.error is not None)
    assert failed.error == "model_failed"
    assert not failed.passed
    assert failed.output == ""
    assert any(span.attrs.get("error_code") == "model_failed" for span in spans.spans)
    assert len(store.cached_results(list(store.rows))) == 9


def test_a_run_in_which_nothing_answered_fails_as_a_whole_naming_the_budget() -> None:
    """Every call refused for a spent budget: the run measured nothing and is failed as `model_budget`."""
    pipeline, spans, _store = make_pipeline(FakeEvalChat(lambda _alias, _messages: budget_error()))

    with pytest.raises(RunFailedError) as failed:
        asyncio.run(pipeline.run(request(prompt=PACK.prompt.system), lambda _done, _cached: None))

    assert failed.value.failure == FAILURE_BUDGET
    assert spans.named("eval run").attrs["outcome"] == FAILURE_BUDGET
    pipeline, _spans, _store = make_pipeline(FakeEvalChat(lambda _alias, _messages: GatewayResponseError("down")))
    with pytest.raises(RunFailedError) as failed:
        asyncio.run(pipeline.run(request(prompt=PACK.prompt.system), lambda _done, _cached: None))
    assert failed.value.failure == FAILURE_NO_ANSWERS


def test_a_visitor_request_never_plans_an_openrouter_alias() -> None:
    """The provider rule holds in the pipeline's plan: a visitor run on OpenRouter is refused before any call."""
    from lb10.providers import ProviderNotAllowedError

    with pytest.raises(ProviderNotAllowedError):
        plan_variants(request(providers=("openrouter",)))
    with pytest.raises(ValidationError):
        ReportOut.model_validate({"pack": "x"})
