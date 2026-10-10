"""LB-05's pipeline: from a question to a checked and run query, a chart and an explanation.

    resolve metrics -> write SQL -> parse and allowlist -> EXPLAIN -> run read-only
    -> (self-correct, once) -> chart and explain

One question is one run of LB-05. Each step is a span of the run's trace, which holds metadata
only: counts, names of layers and rules, never the visitor's words. Every model call goes through
the gateway labelled with the run, so the run's quotas apply and the Scope shows the whole story.

A question makes two to four model calls: the SQL, a self-correction when a check or the database
refused the first query, and the explanation, plus a repair of any reply that is not the JSON object
asked for. Five is the hard cap: a SQL reply and its repair, a correction and its repair, and an
explanation that is never repaired. The question as a whole has 90 seconds, model waits included.

The model writes SQL and an explanation, and nothing else. The SQL is untrusted input: it passes
the parse-tree check, the plan check and the locked connection (lb05/sql_policy.py, lb05/warehouse.py),
and only the checked tree is run. The chart is built by code from the result's shape (lb05/chart.py).
"""

import logging
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import date
from enum import StrEnum
from typing import Literal

from openai import OpenAIError

from core.structured import ChatMessage, ChatModels, Completion, StructuredAnswer, StructuredOutputError, ask_for_json
from lb05.chart import Chart, NoChart, choose_chart, hints_of
from lb05.prompts import (
    EXPLAIN_ALIAS,
    EXPLAIN_MAX_TOKENS,
    SQL_ALIAS,
    SQL_MAX_TOKENS,
    Explanation,
    SqlAnswer,
    cell_text,
    correction_messages,
    explanation_messages,
    sql_messages,
    system_prompt,
)
from lb05.resolve import Resolution, resolve
from lb05.safety import (
    MAX_MODEL_CALLS,
    MAX_ROWS,
    QUESTION_DEADLINE_SECONDS,
    STATEMENT_TIMEOUT_SECONDS,
    Layer,
    Rule,
    SqlRejectedError,
)
from lb05.semantic_layer import SemanticLayer
from lb05.sql_policy import SqlPolicy, ValidatedQuery
from lb05.warehouse import PlanReport, QueryResult, Warehouse, WarehouseBusyError
from lb_common.run import DataClass, Run, new_run_id, run_scope
from lb_common.tracing import OpenSpan, Tracer

logger = logging.getLogger(__name__)

# How long one model call may take at most, and the least time worth starting a call or a query with.
CALL_TIMEOUT_SECONDS = 60.0
MIN_CALL_SECONDS = 2.0
# How much of a bad reply the repair request quotes back. The SQL writer's prompt has little room to spare.
SQL_ECHO_CHARS = 500
# What the gateway says when a budget or a quota is spent, as opposed to a failure.
BUDGET_CODES = frozenset({"quota_exceeded", "budget_exhausted"})
# Span details are labels of this length at most.
MAX_SPAN_TEXT = 200
# What a reason or an explanation may be, once cleaned.
MAX_REASON_CHARS = 300
MAX_EXPLANATION_CHARS = 700


class Outcome(StrEnum):
    """How a question ended."""

    # The query ran, and the answer carries its table, chart and explanation.
    ANSWERED = "answered"
    # The model said the data can't answer the question, and why.
    DECLINED = "declined"
    # A layer refused the model's query, and the one correction did not fix it (or it was no mistake).
    REFUSED = "refused"
    # A model, the gateway, the clock or the warehouse failed, so there is no answer now.
    UNAVAILABLE = "unavailable"


class Unavailable(StrEnum):
    """Why a question could not be answered right now."""

    MODEL_FAILED = "model_failed"
    MODEL_BUDGET = "model_budget"
    MODEL_OUTPUT = "model_output"
    TIME_LIMIT = "time_limit"
    CALL_LIMIT = "call_limit"
    WAREHOUSE_BUSY = "warehouse_busy"


class QuestionLimitError(Exception):
    """A question used up its model calls or its time, so it may make no more calls."""

    def __init__(self, reason: Unavailable) -> None:
        """Stop the question, for `reason`."""
        super().__init__(reason.value)
        self.reason = reason


class QuestionBudget:
    """The model calls one question may make: at most five, each held to the time the question has left.

    It stands between the pipeline and the gateway's chat, so no code of the pipeline can spend a
    call it was not allowed, and no call can outlast the question's deadline.
    """

    def __init__(
        self,
        models: ChatModels,
        clock: Callable[[], float] = time.monotonic,
        max_calls: int = MAX_MODEL_CALLS,
        deadline_seconds: float = QUESTION_DEADLINE_SECONDS,
    ) -> None:
        """Count the calls made through `models`, with the question's clock starting now."""
        self._models = models
        self._clock = clock
        self._max_calls = max_calls
        self._deadline = clock() + deadline_seconds
        self.calls = 0

    def seconds_left(self) -> float:
        """Return how long the question has left, which may be below zero."""
        return self._deadline - self._clock()

    def complete(
        self, alias: str, messages: Sequence[ChatMessage], max_tokens: int, timeout_seconds: float | None = None
    ) -> Completion:
        """Make one model call if the question may still make one, waiting no longer than it has time for."""
        if self.calls >= self._max_calls:
            raise QuestionLimitError(Unavailable.CALL_LIMIT)
        left = self.seconds_left()
        if left < MIN_CALL_SECONDS:
            raise QuestionLimitError(Unavailable.TIME_LIMIT)
        self.calls += 1
        allowed = CALL_TIMEOUT_SECONDS if timeout_seconds is None else timeout_seconds
        return self._models.complete(alias, messages, max_tokens, min(allowed, left))


@dataclass(frozen=True)
class Attempt:
    """One query the model wrote, and what became of it: the layer and rule that stopped it, or nothing when it ran."""

    sql: str
    stopped_by: Layer | None = None
    rule: Rule | None = None
    message: str | None = None


@dataclass(frozen=True)
class Executed:
    """A query that passed every check and ran: the checked SQL that ran, its result, and what it touched."""

    sql: str
    result: QueryResult
    truncated: bool
    tables: tuple[str, ...]
    joins: int
    plan: PlanReport


@dataclass(frozen=True)
class Answer:
    """What a question came to: how it ended, the queries tried, and, when it ran, the table, chart and explanation.

    `reason` is the model's own sentence when it declined, and a code from `Unavailable` when
    there is no answer right now.
    """

    run_id: str
    outcome: Outcome
    as_of: date
    attempts: tuple[Attempt, ...]
    model_calls: int
    elapsed_ms: int
    reason: str | None = None
    executed: Executed | None = None
    chart: Chart | None = None
    explanation: str | None = None
    explanation_source: Literal["model", "fallback"] | None = None


@dataclass
class Work:
    """One question while it is being worked on: its budget, the queries tried so far, and when it started."""

    question: str
    run_id: str
    budget: QuestionBudget
    as_of: date
    started: float
    attempts: list[Attempt] = field(default_factory=list)


def clean_text(text: str, limit: int) -> str:
    """Make model text fit to show: control characters and runs of spaces gone, and no longer than `limit`."""
    printable = "".join(character if character.isprintable() else " " for character in text)
    return " ".join(printable.split())[:limit]


def model_failure(error: OpenAIError) -> Unavailable:
    """Say why a model call failed: the gateway's budget or quota is spent, or something went wrong."""
    code = getattr(error, "code", None)
    return Unavailable.MODEL_BUDGET if code in BUDGET_CODES else Unavailable.MODEL_FAILED


def note_refusal(span: OpenSpan, refusal: SqlRejectedError) -> None:
    """Record on a span which layer refused a query and for which rule: names only, never the query."""
    span.set("layer", refusal.layer.value)
    span.set("rule", refusal.rule.value)
    span.set("retryable", refusal.retryable)


def was_cut_short(checked: ValidatedQuery, result: QueryResult) -> bool:
    """Tell whether the row cap cut a result: the cap was applied and the result is as long as it allows."""
    return result.capped or (checked.limit_applied and len(result.rows) >= checked.row_limit)


def fallback_explanation(executed: Executed) -> str:
    """Write a plain sentence about a result without a model, for when the explainer can't be used."""
    result = executed.result
    if not result.rows:
        return "No rows matched the question."
    if len(result.rows) == 1 and len(result.columns) == 1:
        return f"{result.columns[0].name.replace('_', ' ')}: {cell_text(result.rows[0][0])}."
    names = ", ".join(column.name for column in result.columns)
    sentence = f"The query returned {len(result.rows)} rows with the columns {names}."
    if executed.truncated:
        sentence += f" The result was cut at {MAX_ROWS:,} rows."
    return sentence


class AnalystPipeline:
    """Answers questions about the sales data: the whole chain, safe to share between threads."""

    def __init__(
        self,
        layer: SemanticLayer,
        policy: SqlPolicy,
        warehouse: Warehouse,
        chat: ChatModels,
        tracer: Tracer,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """Answer from `warehouse` through `chat`, checking SQL with `policy` and recording spans with `tracer`."""
        self.layer = layer
        self.policy = policy
        self.warehouse = warehouse
        self.chat = chat
        self.tracer = tracer
        self.clock = clock
        self.system = system_prompt(layer)
        self.chart_hints = hints_of(layer)

    def answer(self, question: str, session_key: str | None, data_class: DataClass = "visitor") -> Answer:
        """Answer a question as one run of LB-05.

        A visitor's question runs on their session's quota at the gateway; a golden case or an
        adversarial attempt runs as synthetic data, which has no session.
        """
        session = session_key if data_class == "visitor" else None
        run = Run(system="lb-05", run_id=new_run_id(), data_class=data_class, session=session)
        with run_scope(run), self.tracer.span("data question", kind="system.run") as span:
            answer = self.work_through(question, run.run_id)
            span.set("outcome", answer.outcome.value)
            span.set("model_calls", answer.model_calls)
            span.set("queries", len(answer.attempts))
            if answer.executed is not None:
                span.set("rows", len(answer.executed.result.rows))
            if answer.outcome is Outcome.UNAVAILABLE and answer.reason is not None:
                span.set("reason", answer.reason)
        return answer

    def work_through(self, question: str, run_id: str) -> Answer:
        """Take the question through the chain, ending early, with an outcome, at the first step that can't go on."""
        work = Work(
            question=question,
            run_id=run_id,
            budget=QuestionBudget(self.chat, self.clock),
            as_of=self.warehouse.meta.as_of,
            started=self.clock(),
        )
        try:
            resolution = self.resolve(question)
            return self.write_and_run(work, sql_messages(self.system, question, resolution))
        except QuestionLimitError as error:
            return self.unavailable(work, error.reason)
        except WarehouseBusyError:
            return self.unavailable(work, Unavailable.WAREHOUSE_BUSY)
        except StructuredOutputError:
            return self.unavailable(work, Unavailable.MODEL_OUTPUT)
        except OpenAIError as error:
            return self.unavailable(work, model_failure(error))

    def resolve(self, question: str) -> Resolution:
        """Resolve the metrics, slices and dates the question names, with no model."""
        with self.tracer.span("resolve metrics") as span:
            resolution = resolve(question, self.layer, self.warehouse.meta.as_of)
            span.set("metrics", resolution.metric_names()[:MAX_SPAN_TEXT])
            span.set("dimensions", resolution.dimension_names()[:MAX_SPAN_TEXT])
            span.set("ranges", resolution.range_names()[:MAX_SPAN_TEXT])
        return resolution

    def write_sql(self, work: Work, messages: Sequence[ChatMessage], step: str) -> StructuredAnswer[SqlAnswer]:
        """Ask the SQL writer for a query, or for the reason the data can't answer, with one repair of a bad reply."""
        with self.tracer.span(step) as span:
            answer = ask_for_json(
                work.budget, SQL_ALIAS, messages, SqlAnswer, SQL_MAX_TOKENS, echo_chars=SQL_ECHO_CHARS
            )
            span.set("attempts", answer.attempts)
            span.set("answerable", answer.value.answerable)
            span.set("sql_chars", len(answer.value.sql or ""))
        return answer

    def write_and_run(self, work: Work, request: Sequence[ChatMessage]) -> Answer:
        """Write the query and run it, correcting it once when a check or the database refused it."""
        first = self.write_sql(work, request, "write SQL")
        if not first.value.answerable:
            return self.declined(work, first.value.reason)
        try:
            executed = self.execute(work, first.value.sql or "")
        except SqlRejectedError as refusal:
            if not refusal.retryable:
                return self.refused(work)
            return self.correct(work, request, first.reply, refusal)
        return self.finish(work, executed)

    def correct(
        self, work: Work, request: Sequence[ChatMessage], previous_reply: str, refusal: SqlRejectedError
    ) -> Answer:
        """Give the model what refused its query, once, and run what it writes next."""
        with self.tracer.span("self-correct") as span:
            note_refusal(span, refusal)
            second = self.write_sql(work, correction_messages(request, previous_reply, refusal), "write SQL again")
        if not second.value.answerable:
            return self.declined(work, second.value.reason)
        try:
            executed = self.execute(work, second.value.sql or "")
        except SqlRejectedError:
            return self.refused(work)
        return self.finish(work, executed)

    def execute(self, work: Work, sql: str) -> Executed:
        """Run a query through every layer: parse and allowlist, plan, then run. A refusal is recorded and raised."""
        try:
            checked = self.check(sql)
            plan = self.plan(checked)
            result = self.run_query(checked, work)
        except SqlRejectedError as refusal:
            work.attempts.append(Attempt(sql, refusal.layer, refusal.rule, refusal.message))
            raise
        work.attempts.append(Attempt(sql))
        return Executed(
            sql=checked.sql,
            result=result,
            truncated=was_cut_short(checked, result),
            tables=checked.tables,
            joins=checked.joins,
            plan=plan,
        )

    def check(self, sql: str) -> ValidatedQuery:
        """Hold the query to the parse-tree check: one SELECT, listed tables, columns, joins and functions, the cap."""
        with self.tracer.span("parse and allowlist") as span:
            try:
                checked = self.policy.validate(sql)
            except SqlRejectedError as refusal:
                note_refusal(span, refusal)
                raise
            span.set("tables", ",".join(checked.tables))
            span.set("joins", checked.joins)
            span.set("row_limit", checked.row_limit)
            span.set("limit_applied", checked.limit_applied)
        return checked

    def plan(self, checked: ValidatedQuery) -> PlanReport:
        """Plan the checked query without running it, and refuse a cross product or an enormous step."""
        with self.tracer.span("explain plan", kind="system.tool") as span:
            try:
                report = self.warehouse.explain(checked.sql)
            except SqlRejectedError as refusal:
                note_refusal(span, refusal)
                raise
            span.set("operators", len(report.operators))
            span.set("estimated_rows", report.max_estimated_rows)
        return report

    def run_query(self, checked: ValidatedQuery, work: Work) -> QueryResult:
        """Run the checked query on the read-only connection, for at most five seconds and the question's time left."""
        with self.tracer.span("run read-only", kind="system.tool") as span:
            timeout = min(STATEMENT_TIMEOUT_SECONDS, work.budget.seconds_left())
            if timeout < MIN_CALL_SECONDS:
                raise QuestionLimitError(Unavailable.TIME_LIMIT)
            try:
                result = self.warehouse.run(checked.sql, timeout_seconds=timeout)
            except SqlRejectedError as refusal:
                note_refusal(span, refusal)
                raise
            span.set("rows", len(result.rows))
            span.set("columns", len(result.columns))
            span.set("elapsed_ms", result.elapsed_ms)
            span.set("capped", result.capped)
        return result

    def finish(self, work: Work, executed: Executed) -> Answer:
        """Draw the chart and explain the result: the last two steps, neither of which can fail the question."""
        chart = self.chart(executed.result)
        explanation, source = self.explain_result(work, executed)
        return self.answered(work, executed, chart, explanation, source)

    def chart(self, result: QueryResult) -> Chart | None:
        """Choose a chart from the result's shape, in code, and record why there is none when there is none."""
        with self.tracer.span("build chart") as span:
            chosen = choose_chart(result, self.chart_hints)
            chart = chosen if isinstance(chosen, Chart) else None
            span.set("kind", chart.kind if chart is not None else "none")
            if isinstance(chosen, NoChart):
                span.set("reason", chosen.value)
            if chart is not None:
                span.set("omitted_rows", chart.omitted_rows)
        return chart

    def explain_result(self, work: Work, executed: Executed) -> tuple[str, Literal["model", "fallback"]]:
        """Ask the explainer for a few sentences about the result, once; a plain sentence stands in when it fails."""
        with self.tracer.span("explain result") as span:
            messages = explanation_messages(work.question, executed.sql, executed.result, executed.truncated)
            try:
                reply = ask_for_json(
                    work.budget, EXPLAIN_ALIAS, messages, Explanation, EXPLAIN_MAX_TOKENS, repair=False
                )
            except (OpenAIError, StructuredOutputError, QuestionLimitError):
                span.set("source", "fallback")
                return fallback_explanation(executed), "fallback"
            span.set("source", "model")
        return clean_text(reply.value.answer, MAX_EXPLANATION_CHARS), "model"

    def conclude(
        self,
        work: Work,
        outcome: Outcome,
        *,
        reason: str | None = None,
        executed: Executed | None = None,
        chart: Chart | None = None,
        explanation: str | None = None,
        source: Literal["model", "fallback"] | None = None,
    ) -> Answer:
        """Build the answer to a question from what the work found, adding how many calls and how long it took."""
        return Answer(
            run_id=work.run_id,
            outcome=outcome,
            as_of=work.as_of,
            attempts=tuple(work.attempts),
            model_calls=work.budget.calls,
            elapsed_ms=round((self.clock() - work.started) * 1000),
            reason=reason,
            executed=executed,
            chart=chart,
            explanation=explanation,
            explanation_source=source,
        )

    def answered(
        self,
        work: Work,
        executed: Executed,
        chart: Chart | None,
        explanation: str,
        source: Literal["model", "fallback"],
    ) -> Answer:
        """Conclude a question whose query ran."""
        return self.conclude(
            work, Outcome.ANSWERED, executed=executed, chart=chart, explanation=explanation, source=source
        )

    def declined(self, work: Work, reason: str | None) -> Answer:
        """Conclude a question the model says the data can't answer, with the model's reason cleaned up."""
        return self.conclude(work, Outcome.DECLINED, reason=clean_text(reason or "", MAX_REASON_CHARS))

    def refused(self, work: Work) -> Answer:
        """Conclude a question whose query a layer refused and that was not, or could not be, corrected."""
        return self.conclude(work, Outcome.REFUSED)

    def unavailable(self, work: Work, reason: Unavailable) -> Answer:
        """Conclude a question that can't be answered right now, saying why by a code."""
        logger.warning("A question could not be answered: %s.", reason.value)
        return self.conclude(work, Outcome.UNAVAILABLE, reason=reason.value)
