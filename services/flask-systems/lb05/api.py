"""LB-05's HTTP API, under /api/lb05: ask a question, read the semantic layer, and see today's questions left.

Every route needs a visitor token minted for `lb-05` (core/visitors.py): visitors have no accounts, and
the only thing known about one is the hash of their session. A question is admitted by the quota
ledger first (25 a day, one at a time), answered synchronously by the pipeline, and then the ledger
is told how it ended; a question the service itself failed to answer is given back, up to a few a day.

An answer that is a refusal is a normal 200: a visitor who tries to make the model delete data is
supposed to see which layer stopped the query, and why. Only a request the service can't take at
all (no token, no quota left, a malformed body, the service not ready) is an HTTP error.
"""

import logging
from datetime import date, datetime
from typing import Annotated, Any, Literal

from flask import Response
from pydantic import BaseModel, ConfigDict, StringConstraints, field_validator
from sqlalchemy.exc import SQLAlchemyError

from core.app import COMMON_RESPONSES
from core.errors import ErrorOut, describe_failure, error_response
from core.openapi import APIBlueprint, Tag
from core.visitors import require_visitor, visitor_of_request
from lb05.chart import Chart, ChartKind
from lb05.pipeline import Answer, Outcome, Unavailable
from lb05.prompts import MAX_QUESTION_CHARS
from lb05.quota import Admission, Ledger, midnight_after
from lb05.safety import (
    MAX_MODEL_CALLS,
    MAX_REFUNDS_PER_DAY,
    MAX_ROWS,
    QUESTION_DEADLINE_SECONDS,
    QUESTIONS_PER_DAY,
    STATEMENT_TIMEOUT_SECONDS,
    Layer,
    Rule,
)
from lb05.semantic_layer import SemanticLayer
from lb05.service import Lb05Service
from lb05.timeranges import named_ranges
from lb05.warehouse import CellValue, ColumnKind

logger = logging.getLogger(__name__)

SYSTEM_KEY = "lb-05"
MIN_QUESTION_CHARS = 5

# What a visitor is told when there is no answer for a reason of the service's, by the code in `Answer.reason`.
UNAVAILABLE_REASONS: dict[str, str] = {
    Unavailable.MODEL_FAILED.value: "The language models are not answering right now",
    Unavailable.MODEL_BUDGET.value: "Today's free model capacity is used up",
    Unavailable.MODEL_OUTPUT.value: "The model's reply could not be read",
    Unavailable.TIME_LIMIT.value: "The question took longer than the 90 seconds it is given",
    Unavailable.CALL_LIMIT.value: "The question needed more model calls than it is given",
    Unavailable.WAREHOUSE_BUSY.value: "The data engine is busy with other questions",
}
# The reasons after which trying again is the right advice.
TRY_AGAIN = frozenset({Unavailable.MODEL_OUTPUT.value, Unavailable.WAREHOUSE_BUSY.value})
NOT_COUNTED = "so this question was not counted."
COUNTED = f"and this question was counted: a visitor is given back at most {MAX_REFUNDS_PER_DAY} such questions a day."
NOT_SERVING_MESSAGE = "The analyst is not available right now."
DAILY_LIMIT_MESSAGE = f"You have asked today's {QUESTIONS_PER_DAY} questions. The count starts again at midnight UTC."
BUSY_MESSAGE = "Your last question is still being answered. Wait for it, then ask again."

type Question = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=MIN_QUESTION_CHARS, max_length=MAX_QUESTION_CHARS)
]


class AskIn(BaseModel):
    """A visitor's question, in their own words. Nothing else is accepted next to it."""

    model_config = ConfigDict(extra="forbid")

    question: Question

    @field_validator("question")
    @classmethod
    def _check_printable(cls, question: str) -> str:
        """Refuse control characters other than line breaks and tabs: a question is text."""
        if any(not character.isprintable() and character not in "\n\r\t" for character in question):
            raise ValueError("A question is plain text.")
        return question


class ColumnOut(BaseModel):
    """One column of a result: its name and the kind of value it holds."""

    name: str
    kind: ColumnKind


class AttemptOut(BaseModel):
    """One query the model wrote, and the layer and rule that stopped it, or none when it ran.

    `sql` is the model's own text: untrusted, to be shown as text and never run or rendered as markup.
    """

    sql: str
    stopped_by: Layer | None
    rule: Rule | None
    message: str | None


class ResultOut(BaseModel):
    """The table a query returned, and the checked SQL that produced it."""

    sql: str
    columns: list[ColumnOut]
    rows: list[list[CellValue]]
    row_count: int
    truncated: bool
    elapsed_ms: int
    tables: list[str]
    joins: int


class ChartOut(BaseModel):
    """A chart, as a Vega-Lite 5 spec built by this service from the result (never by the model)."""

    kind: ChartKind
    spec: dict[str, Any]
    omitted_rows: int


class AnswerOut(BaseModel):
    """What a question came to: how it ended, every query tried, and the table, chart and explanation when it ran."""

    run_id: str
    outcome: Outcome
    as_of: date
    model_calls: int
    elapsed_ms: int
    attempts: list[AttemptOut]
    message: str | None
    result: ResultOut | None
    chart: ChartOut | None
    explanation: str | None
    explanation_source: Literal["model", "fallback"] | None
    remaining_questions: int


class LimitsOut(BaseModel):
    """The limits LB-05 enforces, which are the ones its datasheet promises."""

    questions_per_day: int
    query_timeout_seconds: float
    row_cap: int
    max_model_calls_per_question: int
    question_deadline_seconds: float


class QuotaOut(BaseModel):
    """A visitor's questions today, and the limits."""

    used: int
    remaining: int
    resets_at: datetime
    limits: LimitsOut


class ColumnDescriptionOut(BaseModel):
    """A column of the semantic layer, as the model is told of it."""

    name: str
    type: str
    description: str
    values: list[str | int]
    nullable: bool


class TableOut(BaseModel):
    """A table of the semantic layer."""

    name: str
    description: str
    columns: list[ColumnDescriptionOut]


class JoinOut(BaseModel):
    """An allowed join: two columns that may be set equal."""

    left: str
    right: str


class MetricOut(BaseModel):
    """A metric: what it means, and the exact definition a question that names it is given."""

    name: str
    label: str
    description: str
    kind: Literal["expression", "worked_example"]
    definition: str
    needs: list[str]
    synonyms: list[str]


class DimensionOut(BaseModel):
    """A way to slice a metric, with its exact definition."""

    name: str
    description: str
    expression: str
    needs: list[str]
    synonyms: list[str]


class RangeOut(BaseModel):
    """A date phrase the resolver understands, and the dates it means counted from the data's last day."""

    name: str
    label: str
    start: date
    end: date


class SemanticLayerOut(BaseModel):
    """The semantic layer: everything the model is told about the data, and so everything a query may use."""

    version: int
    as_of: date
    tables: list[TableOut]
    joins: list[JoinOut]
    metrics: list[MetricOut]
    dimensions: list[DimensionOut]
    ranges: list[RangeOut]


def semantic_layer_document(layer: SemanticLayer, as_of: date) -> SemanticLayerOut:
    """Describe the semantic layer, and the date phrases counted from the data's last day, for the API."""
    return SemanticLayerOut(
        version=layer.version,
        as_of=as_of,
        tables=[
            TableOut(
                name=table.name,
                description=table.description,
                columns=[
                    ColumnDescriptionOut(
                        name=column.name,
                        type=column.type,
                        description=column.description,
                        values=list(column.values),
                        nullable=column.nullable,
                    )
                    for column in table.columns
                ],
            )
            for table in layer.tables
        ],
        joins=[JoinOut(left=join.left, right=join.right) for join in layer.joins],
        metrics=[
            MetricOut(
                name=metric.name,
                label=metric.label,
                description=metric.description,
                kind="expression" if metric.expression is not None else "worked_example",
                definition=metric.expression or metric.pattern or "",
                needs=list(metric.needs),
                synonyms=list(metric.synonyms),
            )
            for metric in layer.metrics
        ],
        dimensions=[
            DimensionOut(
                name=dimension.name,
                description=dimension.description,
                expression=dimension.expression,
                needs=list(dimension.needs),
                synonyms=list(dimension.synonyms),
            )
            for dimension in layer.dimensions
        ],
        ranges=[
            RangeOut(name=item.name, label=item.label, start=item.start, end=item.end)
            for item in named_ranges(as_of).values()
        ],
    )


def limits() -> LimitsOut:
    """Return the limits the service enforces: the datasheet's, from the constants the code enforces them with."""
    return LimitsOut(
        questions_per_day=QUESTIONS_PER_DAY,
        query_timeout_seconds=STATEMENT_TIMEOUT_SECONDS,
        row_cap=MAX_ROWS,
        max_model_calls_per_question=MAX_MODEL_CALLS,
        question_deadline_seconds=QUESTION_DEADLINE_SECONDS,
    )


def chart_out(chart: Chart | None) -> ChartOut | None:
    """Describe a chart for the API."""
    if chart is None:
        return None
    return ChartOut(kind=chart.kind, spec=chart.spec, omitted_rows=chart.omitted_rows)


def unavailable_message(reason: str | None, given_back: bool) -> str:
    """Say why a question could not be answered, and whether it still cost the visitor one of their questions."""
    sentence = UNAVAILABLE_REASONS.get(reason or "")
    if sentence is None:
        return NOT_SERVING_MESSAGE
    advice = " Try it again." if reason in TRY_AGAIN else ""
    return f"{sentence}, {NOT_COUNTED if given_back else COUNTED}{advice}"


def message_for(answer: Answer, given_back: bool) -> str | None:
    """Write the sentence for people that goes with an answer that has no table: why not, in plain words."""
    if answer.outcome is Outcome.DECLINED:
        return answer.reason
    if answer.outcome is Outcome.REFUSED and answer.attempts:
        last = answer.attempts[-1]
        return f"Stopped by the {last.stopped_by} check ({last.rule}): {last.message}"
    if answer.outcome is Outcome.UNAVAILABLE:
        return unavailable_message(answer.reason, given_back)
    return None


def answer_out(answer: Answer, remaining: int, given_back: bool = False) -> AnswerOut:
    """Turn the pipeline's answer into the API's, with the questions left and whether this one was given back."""
    executed = answer.executed
    result = None
    if executed is not None:
        result = ResultOut(
            sql=executed.sql,
            columns=[ColumnOut(name=column.name, kind=column.kind) for column in executed.result.columns],
            rows=[list(row) for row in executed.result.rows],
            row_count=len(executed.result.rows),
            truncated=executed.truncated,
            elapsed_ms=executed.result.elapsed_ms,
            tables=list(executed.tables),
            joins=executed.joins,
        )
    return AnswerOut(
        run_id=answer.run_id,
        outcome=answer.outcome,
        as_of=answer.as_of,
        model_calls=answer.model_calls,
        elapsed_ms=answer.elapsed_ms,
        attempts=[
            AttemptOut(sql=attempt.sql, stopped_by=attempt.stopped_by, rule=attempt.rule, message=attempt.message)
            for attempt in answer.attempts
        ],
        message=message_for(answer, given_back),
        result=result,
        chart=chart_out(answer.chart),
        explanation=answer.explanation,
        explanation_source=answer.explanation_source,
        remaining_questions=remaining,
    )


def not_admitted(admission: Admission) -> Response:
    """Answer a question the ledger did not admit: 429, for the day's questions used or one still running."""
    if admission.reason == "busy":
        return error_response(429, "question_running", BUSY_MESSAGE)
    return error_response(429, "daily_limit", DAILY_LIMIT_MESSAGE, resets_at=midnight_after(admission.day).isoformat())


def end_question(ledger: Ledger, admission: Admission, refund: bool) -> bool:
    """Tell the ledger a question ended, and say whether the visitor got their place back.

    A ledger that can't be reached must not lose the visitor their answer; the place is then not given back.
    """
    try:
        return ledger.finish(admission, refund)
    except SQLAlchemyError as error:
        logger.error("Could not end a question's quota entry: %s", describe_failure(error))
        return False


def build_blueprint(service: Lb05Service | None, web_token_key: str | None) -> APIBlueprint:
    """Build LB-05's routes. With no `service` (it could not start) every route answers 503 after the token check."""
    blueprint = APIBlueprint(
        "lb05",
        __name__,
        url_prefix="/api/lb05",
        abp_tags=[Tag(name="lb-05")],
        abp_security=[{"visitor": []}],
        abp_responses={**COMMON_RESPONSES, 401: ErrorOut, 503: ErrorOut},
    )
    blueprint.before_request(require_visitor(SYSTEM_KEY, web_token_key))
    layer_document: dict[str, Any] | None = None
    if service is not None:
        layer_document = semantic_layer_document(service.layer, service.warehouse.meta.as_of).model_dump(mode="json")

    @blueprint.post("/ask", responses={200: AnswerOut, 429: ErrorOut})
    def ask(body: AskIn) -> Response | dict[str, Any]:
        """Answer a question about the sales data, synchronously: the SQL, the table, a chart and an explanation.

        Counts against the visitor's 25 questions a day, which the service enforces itself, and a
        visitor has one question running at a time. A question the service itself fails to answer is not
        counted, for up to five such questions a day: after that a failed question counts too.
        """
        if service is None or service.pipeline is None:
            return error_response(503, "unavailable", NOT_SERVING_MESSAGE)
        visitor = visitor_of_request()
        admission = service.ledger.admit(visitor.session_key)
        if not admission.allowed:
            return not_admitted(admission)
        try:
            answer = service.pipeline.answer(body.question, visitor.session_key)
        except BaseException:
            end_question(service.ledger, admission, refund=True)
            raise
        given_back = end_question(service.ledger, admission, refund=answer.outcome is Outcome.UNAVAILABLE)
        return answer_out(answer, admission.remaining + int(given_back), given_back).model_dump(mode="json")

    @blueprint.get("/semantic-layer", responses={200: SemanticLayerOut})
    def semantic_layer() -> Response | dict[str, Any]:
        """Read the semantic layer: the tables, joins, metrics and slices a question may use, and what each means."""
        if layer_document is None:
            return error_response(503, "unavailable", NOT_SERVING_MESSAGE)
        return layer_document

    @blueprint.get("/quota", responses={200: QuotaOut})
    def quota() -> Response | dict[str, Any]:
        """Read how many questions the visitor has left today, and the limits LB-05 enforces."""
        if service is None:
            return error_response(503, "unavailable", NOT_SERVING_MESSAGE)
        usage = service.ledger.usage(visitor_of_request().session_key)
        return QuotaOut(
            used=usage.used, remaining=usage.remaining, resets_at=usage.resets_at, limits=limits()
        ).model_dump(mode="json")

    return blueprint
