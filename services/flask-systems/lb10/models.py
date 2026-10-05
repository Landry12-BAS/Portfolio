"""LB-10's tables in its own Postgres schema, `lb10`.

Postgres holds what every worker process must share and what must survive a restart: the result cache,
keyed by pack version, prompt hash, alias and case, so the production prompt's baseline is computed once
for everybody; each visitor run's state and report, which the visitor's page polls for; the stored
nightly results; and how many runs each visitor has started today, which is a quota the service enforces
itself. Visitors have no accounts, so a visitor is the hash of their session (the subject of their token),
never a name. A visitor's edited prompt is stored by its hash only, never as text; the outputs cached
are the model's, on synthetic cases.

The tables carry no schema name: every connection of this system has a search_path of `lb10` only
(core/databases.py), so they are created and read there, and the models work unchanged on a role that is
granted nothing else.
"""

from datetime import date, datetime

from sqlalchemy import Boolean, CheckConstraint, Date, DateTime, Index, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# The most a counter may hold, which a CHECK constraint keeps even if a bug tried to pass it.
MAX_COUNTER = 1_000
# The states a run passes through.
RUN_STATES = ("running", "done", "failed")


class Base(DeclarativeBase):
    """The base of LB-10's tables; its metadata is what the migrations are checked against."""


class QuotaUsage(Base):
    """How many runs one visitor has started on one day, and until when one is running.

    `busy_until` is set while a run is going and cleared when it ends, so a visitor has one run at a
    time; if the process dies mid-run, the flag expires. `refunds` counts the runs given back today.
    """

    __tablename__ = "quota_usage"
    __table_args__ = (
        CheckConstraint(f"used >= 0 AND used <= {MAX_COUNTER}", name="quota_usage_used_range"),
        CheckConstraint(f"refunds >= 0 AND refunds <= {MAX_COUNTER}", name="quota_usage_refunds_range"),
    )

    session_key: Mapped[str] = mapped_column(String(128), primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    used: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    busy_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    refunds: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")


class CaseResult(Base):
    """One model answer to one case under one prompt on one alias, graded: the cache every run reads first.

    `prompt_hash` is the SHA-256 of the system prompt (the production prompt's, or a visitor's edit); the
    text of a visitor's prompt is never stored. `output` is the model's reply (or the JSON of its tool
    calls), untrusted text to be shown as text. `error` names why there is no answer (a gateway code), and
    such a row is not reused: the next run asks again.
    """

    __tablename__ = "case_results"

    pack: Mapped[str] = mapped_column(String(80), primary_key=True)
    pack_version: Mapped[str] = mapped_column(String(16), primary_key=True)
    prompt_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    alias: Mapped[str] = mapped_column(String(40), primary_key=True)
    case_id: Mapped[str] = mapped_column(String(80), primary_key=True)
    output: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    passed: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    grades: Mapped[list[dict[str, object]]] = mapped_column(JSONB, nullable=False, server_default="[]")
    model: Mapped[str] = mapped_column(String(120), nullable=False, server_default="")
    input_tokens: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    output_tokens: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    latency_ms: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    error: Mapped[str | None] = mapped_column(String(40), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class EvalRun(Base):
    """One visitor run: what it measures, how far it has got, and its report once it is done.

    The report is the whole comparison (lb10/report.py) as JSON, written once at the end; while the run
    goes, `calls_done` of `calls_total` is what the visitor's page shows. A run that outlives its deadline
    is ended as failed by whoever reads it next, so a dead worker never leaves a run "running" for good.
    """

    __tablename__ = "runs"
    __table_args__ = (
        CheckConstraint("state IN ('running', 'done', 'failed')", name="runs_state"),
        Index("runs_session_day", "session_key", "day"),
    )

    run_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_key: Mapped[str] = mapped_column(String(128), nullable=False)
    day: Mapped[date] = mapped_column(Date, nullable=False)
    pack: Mapped[str] = mapped_column(String(80), nullable=False)
    pack_version: Mapped[str] = mapped_column(String(16), nullable=False)
    prompt_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    providers: Mapped[list[str]] = mapped_column(JSONB, nullable=False, server_default="[]")
    state: Mapped[str] = mapped_column(String(16), nullable=False, server_default="running")
    calls_done: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    calls_total: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    cached_calls: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    failure: Mapped[str | None] = mapped_column(String(40), nullable=True)
    report: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)


class NightlyResult(Base):
    """One stored result of a nightly command: an eval of a pack on an alias, or the judge's scores on it."""

    __tablename__ = "nightly_results"
    __table_args__ = (
        CheckConstraint("kind IN ('eval', 'judge')", name="nightly_results_kind"),
        Index("nightly_results_pack_day", "pack", "run_on"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_on: Mapped[date] = mapped_column(Date, nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    pack: Mapped[str] = mapped_column(String(80), nullable=False)
    pack_version: Mapped[str] = mapped_column(String(16), nullable=False)
    alias: Mapped[str] = mapped_column(String(40), nullable=False)
    report: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
