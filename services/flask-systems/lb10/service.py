"""LB-10 as the running service holds it: the packs, the quota, the cache and runs, and the runner.

`build_service` loads each part and proves it before the service starts to serve: every pack in evals/packs
is read with its strict reader (a pack that fails stops LB-10 from serving, without stopping the other
systems), and the ledger and the repository get the system's own Postgres engine. With no gateway the
service still serves what needs none (the targets, the quota, old runs and the stored results) and says it
cannot run.

The `Lb10Service` methods are what the HTTP routes call; they return plain results or a `Refusal` that says
which status and code to answer with. This module knows nothing of Flask, and the routes nothing of Postgres.
"""

import logging
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Literal

from sqlalchemy.exc import SQLAlchemyError

from core.data_files import DataFileError
from core.databases import can_query
from core.errors import describe_failure
from core.platform import Platform
from lb10.chat import EvalChat, GatewayEvalChat
from lb10.limits import MAX_PROVIDERS_PER_RUN, RUN_DEADLINE_SECONDS
from lb10.packs import EvalPack, read_packs
from lb10.pipeline import FAILURE_INTERRUPTED, EvalPipeline, Offload, RunRequest
from lb10.prompt_check import PromptProblem, check_prompt, prompt_hash
from lb10.providers import ProviderNotAllowedError, alias_for, providers_for
from lb10.quota import Admission, PostgresLedger, Usage
from lb10.repository import EvalRepository, StoredNightly, StoredRun
from lb10.runner import EvalRunner, Job, RunnerBusyError, RunnerClosedError
from lb10.sampling import sample_cases
from lb10.spans import ThreadedSpanWriter
from lb_common.run import new_run_id
from lb_common.tracing import Tracer

logger = logging.getLogger(__name__)

# How long after its deadline a "running" run is taken for a dead worker's and ended when it is read.
STALE_AFTER = timedelta(seconds=RUN_DEADLINE_SECONDS + 60)


@dataclass(frozen=True)
class Refusal:
    """Why a request was not taken: the status and code to answer with, a sentence, and any detail."""

    status: int
    code: str
    message: str
    problems: tuple[PromptProblem, ...] = ()
    resets_at: datetime | None = None


@dataclass(frozen=True)
class Started:
    """A run that was taken: its ID and how many calls it will make at most."""

    run: StoredRun
    remaining_runs: int


@dataclass(frozen=True)
class Lb10Service:
    """LB-10's parts, built once per process."""

    packs: dict[str, EvalPack]
    ledger: PostgresLedger
    repository: EvalRepository
    runner: EvalRunner | None
    database_check: Callable[[], bool]
    clock: Callable[[], datetime]
    evals_directory: Path

    def is_ready(self) -> bool:
        """Tell whether the service can serve: its database answers."""
        return self.database_check()

    def start(self) -> None:
        """Start the runner's loop as the worker boots, so the first run doesn't wait for it."""
        if self.runner is not None:
            self.runner.start()

    def can_run(self) -> bool:
        """Tell whether the service can start a run: it has a gateway."""
        return self.runner is not None

    def start_run(self, session_key: str, pack_name: str, prompt: str, providers: list[str]) -> Started | Refusal:
        """Check a visitor's request, admit it against their quota, and hand the run to the runner.

        The checks come before the quota, so a refused prompt costs nothing; the runner's refusals give
        the place straight back.
        """
        pack = self.packs.get(pack_name)
        if pack is None:
            return Refusal(404, "unknown_target", "There is no target of that name.")
        problems = check_prompt(prompt, pack)
        if problems:
            return Refusal(422, "invalid_prompt", problems[0].message, problems=tuple(problems))
        chosen = list(dict.fromkeys(providers))
        if not chosen or len(chosen) > MAX_PROVIDERS_PER_RUN:
            return Refusal(422, "invalid_providers", f"Choose one or {MAX_PROVIDERS_PER_RUN} providers.")
        try:
            for provider in chosen:
                alias_for(provider, pack.target.model_class, "visitor")
        except ProviderNotAllowedError:
            return Refusal(422, "invalid_providers", "A visitor's prompt may run only on the providers offered.")
        runner = self.runner
        if runner is None:
            return Refusal(503, "unavailable", "The lab is not available right now.")
        admission = self.ledger.admit(session_key)
        if not admission.allowed:
            return self.not_admitted(admission)
        request = RunRequest(
            run_id=new_run_id(),
            pack=pack,
            cases=sample_cases(pack),
            prompt=prompt,
            providers=chosen,
            data_class="visitor",
            session_key=session_key,
        )
        stored = StoredRun(
            run_id=request.run_id,
            session_key=session_key,
            day=admission.day,
            pack=pack.pack,
            pack_version=pack.version(),
            prompt_hash=prompt_hash(prompt),
            providers=chosen,
            state="running",
            calls_done=0,
            calls_total=len(request.cases) * len(chosen) * 2,
            cached_calls=0,
            started_at=self.clock(),
            finished_at=None,
            failure=None,
            report=None,
        )
        try:
            self.repository.create_run(stored)
            runner.submit(Job(request, admission))
        except RunnerBusyError:
            self.give_back(admission, stored.run_id, "busy")
            return Refusal(503, "lab_busy", "The lab is running as many evals as it can; try again in a minute.")
        except (RunnerClosedError, SQLAlchemyError) as error:
            logger.error("Could not start a run: %s", describe_failure(error))
            self.give_back(admission, stored.run_id, FAILURE_INTERRUPTED)
            return Refusal(503, "unavailable", "The lab is not available right now.")
        return Started(stored, admission.remaining)

    def give_back(self, admission: Admission, run_id: str, failure: str) -> None:
        """Undo an admission whose run never started: end the run row and refund the place."""
        try:
            self.repository.fail_run(run_id, failure)
            self.ledger.finish(admission, refund=True)
        except SQLAlchemyError as error:
            logger.error("Could not give a run back: %s", describe_failure(error))

    def not_admitted(self, admission: Admission) -> Refusal:
        """Describe a run the ledger did not admit: the day's run used, or one still going."""
        if admission.reason == "busy":
            return Refusal(429, "run_running", "Your run is still going. Wait for it, then start another.")
        from lb10.quota import midnight_after

        return Refusal(
            429,
            "daily_limit",
            "You have started today's run. The count starts again at midnight UTC.",
            resets_at=midnight_after(admission.day),
        )

    def run_of(self, run_id: str, session_key: str) -> StoredRun | None:
        """Read a visitor's run, ending it as failed first when a dead worker left it running past its deadline."""
        run = self.repository.run_of(run_id, session_key)
        if run is not None and run.state == "running" and run.started_at < self.clock() - STALE_AFTER:
            self.repository.end_stale_runs(self.clock() - STALE_AFTER, FAILURE_INTERRUPTED)
            run = self.repository.run_of(run_id, session_key)
        return run

    def runs_today(self, session_key: str) -> list[StoredRun]:
        """Read the visitor's runs of today."""
        return self.repository.runs_of(session_key, self.ledger.today())

    def usage(self, session_key: str) -> Usage:
        """Read the visitor's quota."""
        return self.ledger.usage(session_key)

    def nightly(self) -> list[StoredNightly]:
        """Read the stored nightly results."""
        return self.repository.nightly_results()

    def visitor_providers(self) -> list[str]:
        """List the providers a visitor may choose."""
        return [provider.id for provider in providers_for("visitor")]


type StartMode = Literal["serve", "command"]


def build_pipeline_factory(
    chat: EvalChat, repository: EvalRepository, platform: Platform
) -> Callable[[Offload, ThreadPoolExecutor], EvalPipeline]:
    """Make the function the runner calls to build the pipeline, once the worker has forked."""

    def build(offload: Offload, executor: ThreadPoolExecutor) -> EvalPipeline:
        """Build the pipeline on the runner's pool, with spans written off the loop's thread."""
        writer = platform.span_writer
        tracer = Tracer(ThreadedSpanWriter(writer, executor)) if writer is not None else platform.tracer
        return EvalPipeline(chat, repository, tracer, offload, platform.clock)

    return build


def build_service(platform: Platform, chat: EvalChat | None = None) -> Lb10Service | None:
    """Build LB-10 from the platform, or return None (and log why) when a part can't be built.

    `chat` replaces the gateway's chat in tests; without it, the gateway is used when configured.
    """
    try:
        packs = read_packs(platform.evals_directory() / "packs")
    except DataFileError as error:
        logger.error("LB-10 can't start: %s", error)
        return None
    if not packs:
        logger.error("LB-10 can't start: no eval packs in %s", platform.evals_directory() / "packs")
        return None
    engine = platform.engines.get("lb10")
    if engine is None:
        logger.error("LB-10 can't start: the platform has no database engine for its schema.")
        return None
    ledger = PostgresLedger(engine, platform.clock)
    repository = EvalRepository(engine, platform.clock)
    eval_chat = chat
    if eval_chat is None and platform.chat is not None and hasattr(platform.chat, "gateway"):
        eval_chat = GatewayEvalChat(platform.chat.gateway)
    runner = None
    if eval_chat is not None:
        runner = EvalRunner(build_pipeline_factory(eval_chat, repository, platform), repository, ledger)
    else:
        logger.warning("LB-10 has no gateway: it serves the targets and the stored results, but runs nothing.")
    return Lb10Service(
        packs=packs,
        ledger=ledger,
        repository=repository,
        runner=runner,
        database_check=lambda: can_query(engine),
        clock=platform.clock,
        evals_directory=platform.evals_directory(),
    )
