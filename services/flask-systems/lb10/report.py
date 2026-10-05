"""A run's report: what a visitor is shown once the run is done, built from graded case results by rules alone.

For each variant (the production prompt, the edited prompt) on each alias: the score as a share of passing
cases with its bootstrap interval, the latency percentiles, the tokens spent and how many answers came from
the cache. For each alias, the paired comparison of the edited prompt with production on the same cases, with
its plain verdict, and the cases that changed (regressed and improved) with both outputs, so a person can read
why. The report says in words that ten cases is a small sample.

The report is a Pydantic model: it is stored as JSON on the run and served by the API as it is.
"""

from collections.abc import Sequence
from typing import Any, Literal

from pydantic import BaseModel

from lb10.packs import EvalPack, PackCase
from lb10.repository import StoredResult
from lb10.stats import Interval, Verdict, bootstrap_interval, latency_percentiles, paired_comparison

# Which prompt a result belongs to.
type Variant = Literal["production", "edited"]
# What the report says about its sample, in one sentence the board shows next to every interval.
SMALL_SAMPLE_NOTE = (
    "Ten cases is a small sample: the intervals are wide on purpose, and a difference whose interval spans zero "
    "is not a difference this run can show."
)
# How much of an output a changed case shows.
MAX_OUTPUT_CHARS = 2_000


class IntervalOut(BaseModel):
    """A share with its confidence interval."""

    mean: float
    low: float
    high: float
    cases: int


class GradeOut(BaseModel):
    """One grader's verdict on one case."""

    kind: str
    passed: bool
    detail: str


class CaseOutcomeOut(BaseModel):
    """One case under one variant: whether it passed, what the model wrote, and what each rule said."""

    case_id: str
    passed: bool
    output: str
    grades: list[GradeOut]
    error: str | None
    latency_ms: int
    model: str
    cached: bool


class VariantOut(BaseModel):
    """One prompt on one alias: its score, its cost and every case."""

    variant: Variant
    provider: str
    alias: str
    score: IntervalOut
    latency_p50_ms: int
    latency_p95_ms: int
    input_tokens: int
    output_tokens: int
    model_calls: int
    cached_calls: int
    failed_calls: int
    cases: list[CaseOutcomeOut]


class ChangedCaseOut(BaseModel):
    """A case whose grade changed between production and the edited prompt, with both outputs."""

    case_id: str
    difficulty: str
    change: Literal["improved", "regressed"]
    inputs: dict[str, str]
    expected: dict[str, Any]
    production: CaseOutcomeOut
    edited: CaseOutcomeOut


class ComparisonOut(BaseModel):
    """The edited prompt against production on one alias, on the same cases."""

    provider: str
    alias: str
    difference: float
    low: float
    high: float
    verdict: Verdict
    improved: int
    regressed: int
    cases: int
    changed: list[ChangedCaseOut]


class ReportOut(BaseModel):
    """The whole report of a finished run."""

    pack: str
    pack_version: str
    sample_size: int
    case_ids: list[str]
    edited_is_production: bool
    variants: list[VariantOut]
    comparisons: list[ComparisonOut]
    total_model_calls: int
    total_cached_calls: int
    total_input_tokens: int
    total_output_tokens: int
    sample_note: str = SMALL_SAMPLE_NOTE


def interval_out(interval: Interval) -> IntervalOut:
    """Describe an interval for the report."""
    return IntervalOut(mean=interval.mean, low=interval.low, high=interval.high, cases=interval.cases)


def outcome_out(result: StoredResult, cached: bool) -> CaseOutcomeOut:
    """Describe one case's outcome for the report."""
    return CaseOutcomeOut(
        case_id=result.key.case_id,
        passed=result.passed,
        output=result.output[:MAX_OUTPUT_CHARS],
        grades=[
            GradeOut(
                kind=str(grade.get("kind", "")),
                passed=bool(grade.get("passed", False)),
                detail=str(grade.get("detail", "")),
            )
            for grade in result.grades
        ],
        error=result.error,
        latency_ms=result.latency_ms,
        model=result.model,
        cached=cached,
    )


def variant_out(
    variant: Variant,
    provider: str,
    alias: str,
    cases: Sequence[PackCase],
    results: dict[str, StoredResult],
    cached_ids: set[str],
) -> VariantOut:
    """Build one variant's part of the report from its results, in the cases' order."""
    ordered = [results[case.id] for case in cases]
    answered = [result for result in ordered if result.error is None]
    p50, p95 = latency_percentiles([result.latency_ms for result in answered])
    return VariantOut(
        variant=variant,
        provider=provider,
        alias=alias,
        score=interval_out(bootstrap_interval([result.passed for result in ordered])),
        latency_p50_ms=p50,
        latency_p95_ms=p95,
        input_tokens=sum(result.input_tokens for result in ordered),
        output_tokens=sum(result.output_tokens for result in ordered),
        model_calls=sum(1 for result in ordered if result.key.case_id not in cached_ids),
        cached_calls=sum(1 for result in ordered if result.key.case_id in cached_ids),
        failed_calls=sum(1 for result in ordered if result.error is not None),
        cases=[outcome_out(result, result.key.case_id in cached_ids) for result in ordered],
    )


def comparison_out(production: VariantOut, edited: VariantOut, cases: Sequence[PackCase]) -> ComparisonOut:
    """Compare the edited prompt with production on one alias, listing the cases that changed."""
    before = {outcome.case_id: outcome for outcome in production.cases}
    after = {outcome.case_id: outcome for outcome in edited.cases}
    paired = paired_comparison([after[case.id].passed for case in cases], [before[case.id].passed for case in cases])
    changed: list[ChangedCaseOut] = []
    for case in cases:
        if before[case.id].passed == after[case.id].passed:
            continue
        changed.append(
            ChangedCaseOut(
                case_id=case.id,
                difficulty=case.difficulty,
                change="improved" if after[case.id].passed else "regressed",
                inputs=dict(case.inputs),
                expected=dict(case.expected),
                production=before[case.id],
                edited=after[case.id],
            )
        )
    return ComparisonOut(
        provider=edited.provider,
        alias=edited.alias,
        difference=paired.difference,
        low=paired.low,
        high=paired.high,
        verdict=paired.verdict,
        improved=paired.improved,
        regressed=paired.regressed,
        cases=paired.cases,
        changed=changed,
    )


def build_report(
    pack: EvalPack,
    cases: Sequence[PackCase],
    variants: Sequence[VariantOut],
    edited_is_production: bool,
) -> ReportOut:
    """Assemble the report: the variants, and a comparison for every alias that has both prompts."""
    comparisons: list[ComparisonOut] = []
    for edited in (variant for variant in variants if variant.variant == "edited"):
        production = next(
            (variant for variant in variants if variant.variant == "production" and variant.alias == edited.alias), None
        )
        if production is not None:
            comparisons.append(comparison_out(production, edited, cases))
    return ReportOut(
        pack=pack.pack,
        pack_version=pack.version(),
        sample_size=len(cases),
        case_ids=[case.id for case in cases],
        edited_is_production=edited_is_production,
        variants=list(variants),
        comparisons=comparisons,
        total_model_calls=sum(variant.model_calls for variant in variants),
        total_cached_calls=sum(variant.cached_calls for variant in variants),
        total_input_tokens=sum(variant.input_tokens for variant in variants),
        total_output_tokens=sum(variant.output_tokens for variant in variants),
    )
