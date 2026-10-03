"""LB-10's HTTP API, under /api/lb10: the targets, a visitor's runs, their quota, and the stored results.

Every route needs a visitor token minted for `lb-10` (core/visitors.py): visitors have no accounts, and the
only thing known about one is the hash of their session. A run is started with 202 and polled: the request
checks the prompt and the providers, admits the run against the visitor's one-a-day quota, and hands it to
the runner; the run's state and, once done, its report are read back by ID. A visitor reads only their own
runs. The targets, the quota, the baselines and the nightly results need no model and are served without one.

A refused prompt (too long, a variable dropped or added) is a 422 with a plain sentence naming the variables,
and costs nothing. Only a request the service can't take at all (no token, no quota left, the lab busy or
without a gateway) is an HTTP error; a run whose model calls failed is a finished run that says so.
"""

import logging
from datetime import datetime
from typing import Annotated, Any, Literal

from flask import Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from core.app import COMMON_RESPONSES
from core.data_files import DataFileError
from core.errors import ErrorOut, error_response
from core.openapi import APIBlueprint, Tag
from core.visitors import require_visitor, visitor_of_request
from lb10.baselines import BaselineEntry, read_baselines
from lb10.graders import GRADER_KINDS
from lb10.limits import (
    CASES_PER_RUN,
    CONCURRENCY,
    MAX_CALLS_PER_RUN,
    MAX_PROMPT_CHARS,
    MAX_PROVIDERS_PER_RUN,
    RUN_DEADLINE_SECONDS,
    RUNS_PER_DAY,
)
from lb10.packs import EvalPack, PackCase
from lb10.providers import Provider, providers_for
from lb10.report import ReportOut
from lb10.repository import StoredNightly, StoredRun
from lb10.sampling import sample_cases
from lb10.service import Lb10Service, Refusal

logger = logging.getLogger(__name__)

SYSTEM_KEY = "lb-10"
NOT_SERVING_MESSAGE = "The lab is not available right now."
# A prompt as the API accepts it: text up to the limit (the finer checks name what is wrong).
type PromptText = Annotated[str, StringConstraints(min_length=1, max_length=MAX_PROMPT_CHARS + 1_000)]
type ProviderId = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9-]{1,30}$")]
type TargetName = Annotated[str, StringConstraints(pattern=r"^[a-z0-9]+(?:[._-][a-z0-9]+)*$", max_length=80)]
type RunState = Literal["running", "done", "failed"]


class StartRunIn(BaseModel):
    """A visitor's request: which target, the prompt as they edited it, and the providers to run it on."""

    model_config = ConfigDict(extra="forbid")

    target: TargetName
    prompt: PromptText
    providers: list[ProviderId] = Field(min_length=1, max_length=MAX_PROVIDERS_PER_RUN)


class ProviderOut(BaseModel):
    """A provider a visitor may pin a run to, and what it does with inputs."""

    id: str
    name: str
    note: str
    trains_on_inputs: bool
    alias: str


class TargetCaseOut(BaseModel):
    """One case of the fixed sample a run uses: its inputs, so the board can show what the model was asked."""

    id: str
    difficulty: str
    inputs: dict[str, str]
    expected: dict[str, Any]
    grader_kinds: list[str]


class TargetOut(BaseModel):
    """One target: its pack, the production prompt, its variables, and the fixed sample."""

    pack: str
    version: str
    system: str
    name: str
    description: str
    source: str
    alias: str
    model_class: str
    output: str
    system_prompt: str
    user_template: str
    variables: list[str]
    tool_names: list[str]
    case_count: int
    hard_count: int
    common_grader_kinds: list[str]
    sample: list[TargetCaseOut]
    providers: list[ProviderOut]


class LabLimitsOut(BaseModel):
    """The limits LB-10 enforces, which are the ones its datasheet promises."""

    cases_per_run: int
    runs_per_day: int
    max_prompt_chars: int
    max_providers_per_run: int
    max_model_calls_per_run: int
    concurrency: int
    run_deadline_seconds: float
    grader_kinds: list[str]


class TargetsOut(BaseModel):
    """Every target the lab offers, and the limits."""

    targets: list[TargetOut]
    limits: LabLimitsOut
    can_run: bool


class RunOut(BaseModel):
    """A run's state: how far it has got, and its report once it is done."""

    run_id: str
    state: RunState
    pack: str
    pack_version: str
    providers: list[str]
    calls_done: int
    calls_total: int
    cached_calls: int
    started_at: datetime
    finished_at: datetime | None
    failure: str | None
    report: ReportOut | None


class StartedOut(BaseModel):
    """The answer to a run that was taken: the run, and the runs the visitor has left today."""

    run: RunOut
    remaining_runs: int


class RunsOut(BaseModel):
    """The visitor's runs of today, newest first."""

    runs: list[RunOut]


class LabQuotaOut(BaseModel):
    """A visitor's runs today, and the limits."""

    used: int
    remaining: int
    resets_at: datetime
    limits: LabLimitsOut


class BaselineOut(BaseModel):
    """One committed baseline: a pack's score on an alias, with its interval, as evals/baselines records it."""

    pack: str
    pack_version: str
    alias: str
    score: float
    low: float
    high: float
    cases: int
    measured_on: str
    source: str


class BaselinesOut(BaseModel):
    """The committed baselines the CI gate compares fresh scores with."""

    baselines: list[BaselineOut]


class NightlyOut(BaseModel):
    """One stored nightly result."""

    run_on: str
    kind: str
    pack: str
    pack_version: str
    alias: str
    report: dict[str, Any]


class NightlyListOut(BaseModel):
    """The stored nightly results, newest first."""

    results: list[NightlyOut]


class PromptProblemOut(BaseModel):
    """One reason a prompt was refused."""

    code: str
    message: str


class InvalidPromptOut(BaseModel):
    """The error answer for a refused prompt: the platform's shape, with every problem listed."""

    error: dict[str, Any]
    problems: list[PromptProblemOut]


def limits() -> LabLimitsOut:
    """Return the limits the service enforces, from the constants the code enforces them with."""
    return LabLimitsOut(
        cases_per_run=CASES_PER_RUN,
        runs_per_day=RUNS_PER_DAY,
        max_prompt_chars=MAX_PROMPT_CHARS,
        max_providers_per_run=MAX_PROVIDERS_PER_RUN,
        max_model_calls_per_run=MAX_CALLS_PER_RUN,
        concurrency=CONCURRENCY,
        run_deadline_seconds=RUN_DEADLINE_SECONDS,
        grader_kinds=list(GRADER_KINDS),
    )


def provider_out(provider: Provider, pack: EvalPack) -> ProviderOut:
    """Describe a provider for one target, with the pinned alias its model class maps to."""
    return ProviderOut(
        id=provider.id,
        name=provider.name,
        note=provider.note,
        trains_on_inputs=provider.trains_on_inputs,
        alias=provider.aliases[pack.target.model_class],
    )


def case_out(pack: EvalPack, case: PackCase) -> TargetCaseOut:
    """Describe one sample case."""
    return TargetCaseOut(
        id=case.id,
        difficulty=case.difficulty,
        inputs=dict(case.inputs),
        expected=dict(case.expected),
        grader_kinds=[grader.kind for grader in pack.graders_of(case)],
    )


def target_out(pack: EvalPack) -> TargetOut:
    """Describe one target for the board."""
    return TargetOut(
        pack=pack.pack,
        version=pack.version(),
        system=pack.system,
        name=pack.target.name,
        description=pack.target.description,
        source=pack.target.source,
        alias=pack.target.alias,
        model_class=pack.target.model_class,
        output=pack.target.output,
        system_prompt=pack.prompt.system,
        user_template=pack.prompt.user,
        variables=list(pack.variables),
        tool_names=[tool.name for tool in pack.tools],
        case_count=len(pack.cases),
        hard_count=len(pack.hard_cases()),
        common_grader_kinds=[grader.kind for grader in pack.common_graders],
        sample=[case_out(pack, case) for case in sample_cases(pack)],
        providers=[provider_out(provider, pack) for provider in providers_for("visitor")],
    )


def run_out(run: StoredRun) -> RunOut:
    """Describe a run, with its report when it has one."""
    state: RunState = "running" if run.state == "running" else ("done" if run.state == "done" else "failed")
    return RunOut(
        run_id=run.run_id,
        state=state,
        pack=run.pack,
        pack_version=run.pack_version,
        providers=list(run.providers),
        calls_done=run.calls_done,
        calls_total=run.calls_total,
        cached_calls=run.cached_calls,
        started_at=run.started_at,
        finished_at=run.finished_at,
        failure=run.failure,
        report=ReportOut.model_validate(run.report) if run.report is not None else None,
    )


def baseline_out(entry: BaselineEntry) -> BaselineOut:
    """Describe one committed baseline."""
    return BaselineOut(
        pack=entry.pack,
        pack_version=entry.pack_version,
        alias=entry.alias,
        score=entry.score,
        low=entry.low,
        high=entry.high,
        cases=entry.cases,
        measured_on=entry.measured_on.isoformat(),
        source=entry.source,
    )


def nightly_out(result: StoredNightly) -> NightlyOut:
    """Describe one stored nightly result."""
    return NightlyOut(
        run_on=result.run_on.isoformat(),
        kind=result.kind,
        pack=result.pack,
        pack_version=result.pack_version,
        alias=result.alias,
        report=dict(result.report),
    )


def refused(refusal: Refusal) -> Response:
    """Answer a refusal in the platform's error shape, with the prompt's problems or the reset time when given."""
    extra: dict[str, str] = {}
    if refusal.resets_at is not None:
        extra["resets_at"] = refusal.resets_at.isoformat()
    response = error_response(refusal.status, refusal.code, refusal.message, **extra)
    if refusal.problems:
        body = response.get_json()
        body["problems"] = [{"code": problem.code, "message": problem.message} for problem in refusal.problems]
        response.set_data(InvalidPromptOut.model_validate(body).model_dump_json())
    return response


def build_blueprint(service: Lb10Service | None, web_token_key: str | None) -> APIBlueprint:
    """Build LB-10's routes. With no `service` (it could not start) every route answers 503 after the token check."""
    blueprint = APIBlueprint(
        "lb10",
        __name__,
        url_prefix="/api/lb10",
        abp_tags=[Tag(name="lb-10")],
        abp_security=[{"visitor": []}],
        abp_responses={**COMMON_RESPONSES, 401: ErrorOut, 503: ErrorOut},
    )
    blueprint.before_request(require_visitor(SYSTEM_KEY, web_token_key))
    targets_document: dict[str, Any] | None = None
    if service is not None:
        targets_document = TargetsOut(
            targets=[target_out(pack) for pack in service.packs.values()], limits=limits(), can_run=service.can_run()
        ).model_dump(mode="json")

    @blueprint.get("/targets", responses={200: TargetsOut})
    def targets() -> Response | dict[str, Any]:
        """List the targets: each pack's production prompt, variables, fixed sample and the providers offered."""
        if targets_document is None:
            return error_response(503, "unavailable", NOT_SERVING_MESSAGE)
        return targets_document

    @blueprint.post("/runs", responses={202: StartedOut, 404: ErrorOut, 422: InvalidPromptOut, 429: ErrorOut})
    def start_run(body: StartRunIn) -> Response | tuple[dict[str, Any], int]:
        """Start a run: the edited prompt on the target's fixed sample, on the chosen providers, against production.

        Counts against the visitor's one run a day, which the service enforces itself. A prompt that drops a
        variable or adds an unknown one is refused with 422 and costs nothing. The run goes on in the
        background; poll its state at /runs/{run_id}.
        """
        if service is None:
            return error_response(503, "unavailable", NOT_SERVING_MESSAGE)
        visitor = visitor_of_request()
        started = service.start_run(visitor.session_key, body.target, body.prompt, body.providers)
        if isinstance(started, Refusal):
            return refused(started)
        return StartedOut(run=run_out(started.run), remaining_runs=started.remaining_runs).model_dump(mode="json"), 202

    @blueprint.get("/runs/<string:run_id>", responses={200: RunOut, 404: ErrorOut})
    def run_state(path: RunPath) -> Response | dict[str, Any]:
        """Read one of the visitor's runs: its progress while it goes, its report once it is done."""
        if service is None:
            return error_response(503, "unavailable", NOT_SERVING_MESSAGE)
        run = service.run_of(path.run_id, visitor_of_request().session_key)
        if run is None:
            return error_response(404, "not_found", "There is no run of yours with that ID.")
        return run_out(run).model_dump(mode="json")

    @blueprint.get("/runs", responses={200: RunsOut})
    def runs_today() -> Response | dict[str, Any]:
        """List the visitor's runs of today, newest first."""
        if service is None:
            return error_response(503, "unavailable", NOT_SERVING_MESSAGE)
        runs = service.runs_today(visitor_of_request().session_key)
        return RunsOut(runs=[run_out(run) for run in runs]).model_dump(mode="json")

    @blueprint.get("/quota", responses={200: LabQuotaOut})
    def quota() -> Response | dict[str, Any]:
        """Read how many runs the visitor has left today, and the limits LB-10 enforces."""
        if service is None:
            return error_response(503, "unavailable", NOT_SERVING_MESSAGE)
        usage = service.usage(visitor_of_request().session_key)
        return LabQuotaOut(
            used=usage.used, remaining=usage.remaining, resets_at=usage.resets_at, limits=limits()
        ).model_dump(mode="json")

    @blueprint.get("/baselines", responses={200: BaselinesOut})
    def baselines() -> Response | dict[str, Any]:
        """Read the committed baselines (evals/baselines): the scores the CI gate holds every pack to."""
        if service is None:
            return error_response(503, "unavailable", NOT_SERVING_MESSAGE)
        try:
            entries = read_baselines(service.evals_directory / "baselines")
        except DataFileError:
            return error_response(503, "unavailable", "The baselines can't be read right now.")
        return BaselinesOut(baselines=[baseline_out(entry) for entry in entries]).model_dump(mode="json")

    @blueprint.get("/nightly", responses={200: NightlyListOut})
    def nightly() -> Response | dict[str, Any]:
        """Read the stored results of the nightly runs: the evals on every provider and the judge's scores."""
        if service is None:
            return error_response(503, "unavailable", NOT_SERVING_MESSAGE)
        return NightlyListOut(results=[nightly_out(result) for result in service.nightly()]).model_dump(mode="json")

    return blueprint


class RunPath(BaseModel):
    """The path of one run."""

    run_id: Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{8,64}$")]
