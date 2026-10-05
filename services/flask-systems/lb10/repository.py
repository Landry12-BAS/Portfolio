"""LB-10's reads and writes of Postgres: the result cache, the runs and the nightly results.

Every statement is Core SQL built from the models, inside `engine.begin()`; nothing here knows Flask or the
pipeline. The cache is keyed by (pack, pack version, prompt hash, alias, case), so a result written by one
run is read by every later one, and the production prompt's baseline is computed once. A visitor's run is
read by its ID and the visitor's session together: another visitor's ID is simply not found.
"""

import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any, Protocol

from sqlalchemy import Engine, delete, select, tuple_, update
from sqlalchemy.dialects.postgresql import insert

from lb10.limits import RUN_KEEP_DAYS
from lb10.models import CaseResult, EvalRun, NightlyResult

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ResultKey:
    """What names one cached result."""

    pack: str
    pack_version: str
    prompt_hash: str
    alias: str
    case_id: str


@dataclass(frozen=True)
class StoredResult:
    """One graded answer, as the cache holds it."""

    key: ResultKey
    output: str
    passed: bool
    grades: list[dict[str, Any]]
    model: str
    input_tokens: int
    output_tokens: int
    latency_ms: int
    error: str | None
    created_at: datetime

    @property
    def usable(self) -> bool:
        """Tell whether a later run may reuse this result: it has an answer, not an error."""
        return self.error is None


@dataclass(frozen=True)
class StoredRun:
    """One visitor run, as the runs table holds it."""

    run_id: str
    session_key: str
    day: date
    pack: str
    pack_version: str
    prompt_hash: str
    providers: list[str]
    state: str
    calls_done: int
    calls_total: int
    cached_calls: int
    started_at: datetime
    finished_at: datetime | None
    failure: str | None
    report: dict[str, Any] | None


@dataclass(frozen=True)
class StoredNightly:
    """One stored nightly result."""

    run_on: date
    kind: str
    pack: str
    pack_version: str
    alias: str
    report: dict[str, Any]
    created_at: datetime


class ResultStore(Protocol):
    """What the pipeline needs of the cache: read the results it has, and keep the ones it makes."""

    def cached_results(self, keys: Sequence[ResultKey]) -> dict[ResultKey, StoredResult]:
        """Read every usable cached result among `keys`, by key."""
        ...

    def store_result(self, result: StoredResult) -> None:
        """Write one result, replacing an earlier row of the same key."""
        ...


def result_from_row(row: Any) -> StoredResult:
    """Turn a row of case_results into a result."""
    return StoredResult(
        key=ResultKey(row.pack, row.pack_version, row.prompt_hash, row.alias, row.case_id),
        output=row.output,
        passed=row.passed,
        grades=list(row.grades),
        model=row.model,
        input_tokens=row.input_tokens,
        output_tokens=row.output_tokens,
        latency_ms=row.latency_ms,
        error=row.error,
        created_at=row.created_at,
    )


def run_from_row(row: Any) -> StoredRun:
    """Turn a row of runs into a run."""
    return StoredRun(
        run_id=row.run_id,
        session_key=row.session_key,
        day=row.day,
        pack=row.pack,
        pack_version=row.pack_version,
        prompt_hash=row.prompt_hash,
        providers=list(row.providers),
        state=row.state,
        calls_done=row.calls_done,
        calls_total=row.calls_total,
        cached_calls=row.cached_calls,
        started_at=row.started_at,
        finished_at=row.finished_at,
        failure=row.failure,
        report=row.report,
    )


class EvalRepository:
    """LB-10's rows: the cache, the runs and the nightly results, on the system's own engine."""

    def __init__(self, engine: Engine, clock: Callable[[], datetime]) -> None:
        """Read and write on `engine`, stamping rows by `clock` (aware, in UTC)."""
        self._engine = engine
        self._clock = clock

    def cached_results(self, keys: Sequence[ResultKey]) -> dict[ResultKey, StoredResult]:
        """Read every usable cached result among `keys`, by key."""
        if not keys:
            return {}
        wanted = [(key.pack, key.pack_version, key.prompt_hash, key.alias, key.case_id) for key in keys]
        columns = tuple_(
            CaseResult.pack, CaseResult.pack_version, CaseResult.prompt_hash, CaseResult.alias, CaseResult.case_id
        )
        statement = select(CaseResult).where(columns.in_(wanted), CaseResult.error.is_(None))
        with self._engine.connect() as connection:
            rows = connection.execute(statement).all()
        return {result.key: result for result in (result_from_row(row) for row in rows)}

    def results_of(self, pack: str, pack_version: str, prompt_hash: str, alias: str) -> list[StoredResult]:
        """Read every result of one prompt on one alias for one pack version, errors included."""
        statement = select(CaseResult).where(
            CaseResult.pack == pack,
            CaseResult.pack_version == pack_version,
            CaseResult.prompt_hash == prompt_hash,
            CaseResult.alias == alias,
        )
        with self._engine.connect() as connection:
            return [result_from_row(row) for row in connection.execute(statement).all()]

    def store_result(self, result: StoredResult) -> None:
        """Write one result, replacing an earlier row of the same key (an error row gives way to an answer)."""
        values = {
            "pack": result.key.pack,
            "pack_version": result.key.pack_version,
            "prompt_hash": result.key.prompt_hash,
            "alias": result.key.alias,
            "case_id": result.key.case_id,
            "output": result.output,
            "passed": result.passed,
            "grades": result.grades,
            "model": result.model,
            "input_tokens": result.input_tokens,
            "output_tokens": result.output_tokens,
            "latency_ms": result.latency_ms,
            "error": result.error,
            "created_at": result.created_at,
        }
        statement = insert(CaseResult).values(**values)
        statement = statement.on_conflict_do_update(
            index_elements=[
                CaseResult.pack,
                CaseResult.pack_version,
                CaseResult.prompt_hash,
                CaseResult.alias,
                CaseResult.case_id,
            ],
            set_={
                name: values[name]
                for name in values
                if name not in {"pack", "pack_version", "prompt_hash", "alias", "case_id"}
            },
        )
        with self._engine.begin() as connection:
            connection.execute(statement)

    def create_run(self, run: StoredRun) -> None:
        """Write a new run, as it starts."""
        with self._engine.begin() as connection:
            connection.execute(
                insert(EvalRun).values(
                    run_id=run.run_id,
                    session_key=run.session_key,
                    day=run.day,
                    pack=run.pack,
                    pack_version=run.pack_version,
                    prompt_hash=run.prompt_hash,
                    providers=run.providers,
                    state=run.state,
                    calls_done=run.calls_done,
                    calls_total=run.calls_total,
                    cached_calls=run.cached_calls,
                    started_at=run.started_at,
                )
            )

    def note_progress(self, run_id: str, calls_done: int, cached_calls: int) -> None:
        """Record how far a run has got, for the visitor's page."""
        with self._engine.begin() as connection:
            connection.execute(
                update(EvalRun)
                .where(EvalRun.run_id == run_id, EvalRun.state == "running")
                .values(calls_done=calls_done, cached_calls=cached_calls)
            )

    def finish_run(self, run_id: str, report: dict[str, Any], calls_done: int, cached_calls: int) -> bool:
        """End a run with its report. Return whether this call was the one that ended it."""
        with self._engine.begin() as connection:
            changed = connection.execute(
                update(EvalRun)
                .where(EvalRun.run_id == run_id, EvalRun.state == "running")
                .values(
                    state="done",
                    report=report,
                    calls_done=calls_done,
                    cached_calls=cached_calls,
                    finished_at=self._clock(),
                )
            ).rowcount
        return changed == 1

    def fail_run(self, run_id: str, failure: str) -> bool:
        """End a run as failed, naming why in a code. Return whether this call was the one that ended it."""
        with self._engine.begin() as connection:
            changed = connection.execute(
                update(EvalRun)
                .where(EvalRun.run_id == run_id, EvalRun.state == "running")
                .values(state="failed", failure=failure, finished_at=self._clock())
            ).rowcount
        return changed == 1

    def run_of(self, run_id: str, session_key: str) -> StoredRun | None:
        """Read one run of one visitor, or None when they have no run of that ID."""
        statement = select(EvalRun).where(EvalRun.run_id == run_id, EvalRun.session_key == session_key)
        with self._engine.connect() as connection:
            row = connection.execute(statement).one_or_none()
        return run_from_row(row) if row is not None else None

    def runs_of(self, session_key: str, day: date) -> list[StoredRun]:
        """Read a visitor's runs of one day, newest first."""
        statement = (
            select(EvalRun)
            .where(EvalRun.session_key == session_key, EvalRun.day == day)
            .order_by(EvalRun.started_at.desc())
        )
        with self._engine.connect() as connection:
            return [run_from_row(row) for row in connection.execute(statement).all()]

    def end_stale_runs(self, deadline: datetime, failure: str) -> int:
        """End every run still "running" that started before `deadline` (a dead worker's), and say how many."""
        with self._engine.begin() as connection:
            return connection.execute(
                update(EvalRun)
                .where(EvalRun.state == "running", EvalRun.started_at < deadline)
                .values(state="failed", failure=failure, finished_at=self._clock())
            ).rowcount

    def delete_old_runs(self) -> int:
        """Delete the runs older than the days they are kept, and say how many went."""
        oldest = self._clock().date() - timedelta(days=RUN_KEEP_DAYS)
        with self._engine.begin() as connection:
            return connection.execute(delete(EvalRun).where(EvalRun.day < oldest)).rowcount

    def store_nightly(self, result: StoredNightly) -> None:
        """Write one nightly result."""
        with self._engine.begin() as connection:
            connection.execute(
                insert(NightlyResult).values(
                    run_on=result.run_on,
                    kind=result.kind,
                    pack=result.pack,
                    pack_version=result.pack_version,
                    alias=result.alias,
                    report=result.report,
                    created_at=result.created_at,
                )
            )

    def nightly_results(self, limit: int = 200) -> list[StoredNightly]:
        """Read the stored nightly results, newest first, at most `limit`."""
        statement = select(NightlyResult).order_by(NightlyResult.run_on.desc(), NightlyResult.id.desc()).limit(limit)
        with self._engine.connect() as connection:
            rows = connection.execute(statement).all()
        return [
            StoredNightly(row.run_on, row.kind, row.pack, row.pack_version, row.alias, row.report, row.created_at)
            for row in rows
        ]
