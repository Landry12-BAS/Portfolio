"""LB-10's pipeline: one eval run, from a prompt and a sample of cases to a graded, compared report.

    pick the sample -> read the cache -> fan out the misses through the gateway, a few at a time
    -> grade each answer by the pack's rules -> store it -> compute the report

One run is one trace. Every model call is a span with its alias, case, variant, latency, tokens and grade;
the prompt's text is never in a span, only its hash names the variant. The calls fan out with `asyncio`
under a semaphore (docs/STACK.md): the gateway client is synchronous, so each call runs on a thread of the
pool with a copy of the task's context, which is how the call still knows its run and its span. A reply is
graded as it is and never repaired; a call that fails is a failed case with the gateway's code, and a run
in which no call at all answered fails as a whole, since it measured nothing.

Results are cached by (pack version, prompt hash, alias, case id), so the production prompt's baseline is
computed once and every later run reads it; a visitor's own run usually spends ten calls a provider.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from openai import OpenAIError

from core.errors import describe_failure
from core.structured import ChatMessage
from lb10.chat import EvalChat, EvalCompletion
from lb10.graders import grade_all, passed_all
from lb10.limits import CALL_TIMEOUT_SECONDS, CONCURRENCY, MAX_CALLS_PER_RUN
from lb10.packs import EvalPack, PackCase
from lb10.prompt_check import is_production_prompt, production_prompt_hash, prompt_hash
from lb10.providers import DataClass, alias_for
from lb10.report import ReportOut, Variant, build_report, variant_out
from lb10.repository import ResultKey, ResultStore, StoredResult
from lb10.templates import render
from lb_common.gateway import GatewayCode
from lb_common.run import Run, run_scope
from lb_common.tracing import OpenSpan, Tracer

logger = logging.getLogger(__name__)

# What the gateway says when a budget or a quota is spent, as opposed to a failure.
BUDGET_CODES = frozenset({GatewayCode.QUOTA_EXCEEDED.value, GatewayCode.BUDGET_EXHAUSTED.value})
# The error a result carries when the gateway failed in a way it did not name.
UNNAMED_FAILURE = "model_failed"
# Why a run failed as a whole.
FAILURE_NO_ANSWERS = "no_answers"
FAILURE_BUDGET = "model_budget"
FAILURE_TIME_LIMIT = "time_limit"
FAILURE_CALL_LIMIT = "call_limit"
FAILURE_INTERRUPTED = "interrupted"

# Runs a blocking function on a thread with the task's context, and awaits its result.
type Offload = Callable[..., Awaitable[Any]]
# Told how many calls are done and how many came from the cache, as the run goes.
type Progress = Callable[[int, int], None]


class RunFailedError(Exception):
    """The run measured nothing, for the reason its code names."""

    def __init__(self, failure: str) -> None:
        """Fail the run for `failure`."""
        super().__init__(failure)
        self.failure = failure


@dataclass(frozen=True)
class RunRequest:
    """What one run measures: a pack's sample, a prompt, on some providers, for a visitor or for nobody."""

    run_id: str
    pack: EvalPack
    cases: Sequence[PackCase]
    prompt: str
    providers: Sequence[str]
    data_class: DataClass
    session_key: str | None = None
    # Whether the production prompt is run too (a visitor run always compares with it; a nightly run of the
    # production prompt itself has nothing to compare with).
    compare_with_production: bool = True


@dataclass(frozen=True)
class VariantPlan:
    """One prompt on one alias: what to run."""

    variant: Variant
    provider: str
    alias: str
    prompt: str
    prompt_hash: str


def plan_variants(request: RunRequest) -> list[VariantPlan]:
    """Decide which prompts run on which aliases: production first, then the edited prompt when it differs."""
    pack = request.pack
    edited_is_production = is_production_prompt(request.prompt, pack)
    plans: list[VariantPlan] = []
    for provider in request.providers:
        alias = alias_for(provider, pack.target.model_class, request.data_class)
        if request.compare_with_production or edited_is_production:
            plans.append(VariantPlan("production", provider, alias, pack.prompt.system, production_prompt_hash(pack)))
        if not edited_is_production:
            plans.append(VariantPlan("edited", provider, alias, request.prompt, prompt_hash(request.prompt)))
    return plans


def result_key(pack: EvalPack, plan: VariantPlan, case: PackCase) -> ResultKey:
    """Name the cached result of one case under one plan."""
    return ResultKey(pack.pack, pack.version(), plan.prompt_hash, plan.alias, case.id)


def failure_code(error: OpenAIError) -> str:
    """Name why a call failed: the gateway's code when it gave one, else a plain failure."""
    code = getattr(error, "code", None)
    return str(code) if isinstance(code, str) and code else UNNAMED_FAILURE


def messages_for(plan: VariantPlan, pack: EvalPack, case: PackCase) -> list[ChatMessage]:
    """Fill the plan's prompt and the pack's user template with the case's inputs."""
    return [
        ChatMessage("system", render(plan.prompt, case.inputs)),
        ChatMessage("user", render(pack.prompt.user, case.inputs)),
    ]


def graded_result(
    key: ResultKey, pack: EvalPack, case: PackCase, completion: EvalCompletion, now: datetime
) -> StoredResult:
    """Grade a completion by the case's rules and shape it for the cache."""
    output = completion.output(pack.target.output)
    grades = grade_all(pack.graders_of(case), output)
    return StoredResult(
        key=key,
        output=output,
        passed=passed_all(grades),
        grades=[{"kind": grade.kind, "passed": grade.passed, "detail": grade.detail} for grade in grades],
        model=completion.model,
        input_tokens=completion.input_tokens,
        output_tokens=completion.output_tokens,
        latency_ms=completion.latency_ms,
        error=None,
        created_at=now,
    )


def failed_result(key: ResultKey, error: str, latency_ms: int, now: datetime) -> StoredResult:
    """Shape a call that got no answer for the cache: a failed case that names the gateway's code."""
    return StoredResult(
        key=key,
        output="",
        passed=False,
        grades=[],
        model="",
        input_tokens=0,
        output_tokens=0,
        latency_ms=latency_ms,
        error=error,
        created_at=now,
    )


def note_result(span: OpenSpan, result: StoredResult) -> None:
    """Record a call's outcome on its span: numbers and codes, never the prompt or the answer."""
    span.set("passed", result.passed)
    span.set("latency_ms", result.latency_ms)
    span.set("input_tokens", result.input_tokens)
    span.set("output_tokens", result.output_tokens)
    if result.model:
        span.set("model", result.model[:120])
    if result.error is not None:
        span.set("error_code", result.error)


class EvalPipeline:
    """Runs evals: the whole chain, safe to share between runs on one event loop."""

    def __init__(
        self,
        chat: EvalChat,
        repository: ResultStore,
        tracer: Tracer,
        offload: Offload,
        clock: Callable[[], datetime],
        concurrency: int = CONCURRENCY,
        call_timeout_seconds: float = CALL_TIMEOUT_SECONDS,
        max_calls: int = MAX_CALLS_PER_RUN,
    ) -> None:
        """Call models through `chat`, cache in `repository`, record spans with `tracer`, block on `offload`."""
        self.chat = chat
        self.repository = repository
        self.tracer = tracer
        self.offload = offload
        self.clock = clock
        self.concurrency = concurrency
        self.call_timeout_seconds = call_timeout_seconds
        self.max_calls = max_calls

    async def run(self, request: RunRequest, progress: Progress) -> ReportOut:
        """Run one eval as one run of LB-10, and return its report; raise `RunFailedError` when it measured nothing."""
        run = Run(system="lb-10", run_id=request.run_id, data_class=request.data_class, session=request.session_key)
        with run_scope(run), self.tracer.span("eval run", kind="system.run") as span:
            span.set("pack", request.pack.pack)
            span.set("pack_version", request.pack.version())
            span.set("cases", len(request.cases))
            span.set("providers", len(request.providers))
            try:
                report = await self.work_through(request, progress)
            except RunFailedError as error:
                span.set("outcome", error.failure)
                raise
            span.set("outcome", "done")
            span.set("model_calls", report.total_model_calls)
            span.set("cached_calls", report.total_cached_calls)
        return report

    async def work_through(self, request: RunRequest, progress: Progress) -> ReportOut:
        """Plan the variants, read the cache, fan out the misses, then build the report."""
        pack = request.pack
        plans = plan_variants(request)
        keys = [result_key(pack, plan, case) for plan in plans for case in request.cases]
        with self.tracer.span("read cache") as span:
            cached = await self.offload(self.repository.cached_results, keys)
            span.set("wanted", len(keys))
            span.set("found", len(cached))
        misses = [
            (plan, case) for plan in plans for case in request.cases if result_key(pack, plan, case) not in cached
        ]
        if len(misses) > self.max_calls:
            raise RunFailedError(FAILURE_CALL_LIMIT)
        progress(len(cached), len(cached))
        fresh = await self.fan_out(request, misses, len(cached), progress)
        results = {**cached, **fresh}
        require_answers(results)
        cached_ids = set(cached)
        variants = [
            variant_out(
                plan.variant,
                plan.provider,
                plan.alias,
                request.cases,
                {case.id: results[result_key(pack, plan, case)] for case in request.cases},
                {case.id for case in request.cases if result_key(pack, plan, case) in cached_ids},
            )
            for plan in plans
        ]
        return build_report(pack, request.cases, variants, is_production_prompt(request.prompt, pack))

    async def fan_out(
        self,
        request: RunRequest,
        misses: Sequence[tuple[VariantPlan, PackCase]],
        cached_count: int,
        progress: Progress,
    ) -> dict[ResultKey, StoredResult]:
        """Make every missing call, a few at a time, reporting progress as each ends."""
        slots = asyncio.Semaphore(self.concurrency)
        done = cached_count
        results: dict[ResultKey, StoredResult] = {}

        async def one(plan: VariantPlan, case: PackCase) -> None:
            """Make one call when a slot is free, store its result, and count it."""
            nonlocal done
            async with slots:
                result = await self.call_and_grade(request.pack, plan, case)
            results[result.key] = result
            done += 1
            progress(done, cached_count)

        await asyncio.gather(*(one(plan, case) for plan, case in misses))
        return results

    async def call_and_grade(self, pack: EvalPack, plan: VariantPlan, case: PackCase) -> StoredResult:
        """Ask the model for one case under one plan, grade the answer, and store it; a failure is stored too."""
        key = result_key(pack, plan, case)
        with self.tracer.span("model call") as span:
            span.set("alias", plan.alias)
            span.set("variant", plan.variant)
            span.set("case", case.id)
            span.set("difficulty", case.difficulty)
            started = self.clock()
            try:
                completion = await self.offload(
                    self.chat.complete,
                    plan.alias,
                    messages_for(plan, pack, case),
                    pack.tools,
                    pack.target.max_output_tokens,
                    self.call_timeout_seconds,
                )
                result = graded_result(key, pack, case, completion, self.clock())
            except OpenAIError as error:
                elapsed = round((self.clock() - started).total_seconds() * 1000)
                result = failed_result(key, failure_code(error), elapsed, self.clock())
            note_result(span, result)
        try:
            await self.offload(self.repository.store_result, result)
        except Exception as error:  # noqa: BLE001 - a cache that can't be written costs a later call, never this run
            logger.error("Could not cache a result: %s", describe_failure(error))
        return result


def require_answers(results: dict[ResultKey, StoredResult]) -> None:
    """Fail a run in which no call answered: it measured nothing, and the visitor's place is given back."""
    if not results or any(result.error is None for result in results.values()):
        return
    codes = {result.error for result in results.values()}
    raise RunFailedError(FAILURE_BUDGET if codes <= BUDGET_CODES else FAILURE_NO_ANSWERS)
