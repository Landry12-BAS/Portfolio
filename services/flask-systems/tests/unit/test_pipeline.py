"""Tests for the pipeline (lb05/pipeline.py): the chain, the one self-correction, the call budget and the trace.

Everything runs against the real semantic layer, SQL checks and warehouse, with a scripted fake in place of the
gateway: no test calls a provider.
"""

import json
from collections.abc import Sequence
from dataclasses import dataclass, field

import pytest
from openai import OpenAIError

from core.structured import ChatMessage, Completion, StructuredOutputError
from lb05 import warehouse as warehouse_module
from lb05.pipeline import (
    CALL_TIMEOUT_SECONDS,
    AnalystPipeline,
    Answer,
    Attempt,
    Executed,
    Outcome,
    QuestionBudget,
    QuestionLimitError,
    Unavailable,
    clean_text,
    fallback_explanation,
    model_failure,
    was_cut_short,
)
from lb05.prompts import EXPLAIN_MAX_TOKENS, SQL_MAX_TOKENS
from lb05.safety import MAX_MODEL_CALLS, Layer, Rule
from lb05.semantic_layer import SemanticLayer
from lb05.sql_policy import SqlPolicy, ValidatedQuery
from lb05.warehouse import PlanReport, QueryResult, ResultColumn, Warehouse
from lb_common.tracing import Tracer
from tests.support import (
    EXPLANATION,
    QUESTION,
    REVENUE_SQL,
    SESSION,
    FakeChat,
    MemorySpanWriter,
    declined_reply,
    sql_reply,
    unavailable,
)

MONTHLY_SQL = (
    "SELECT DATE_TRUNC('month', orders.ordered_at) AS month, COUNT(*) AS orders FROM orders GROUP BY 1 ORDER BY 1"
)
BAD_COLUMN_SQL = "SELECT orders.revenue FROM orders"
LOOP_SQL = (
    "SELECT o.order_id, (SELECT COUNT(*) FROM orders AS p WHERE p.ordered_at < o.ordered_at) AS earlier "
    "FROM orders AS o"
)
RUNTIME_ERROR_SQL = "SELECT CAST(orders.status AS INTEGER) AS n FROM orders"


@dataclass
class FakeClock:
    """A clock a test moves by hand, in seconds."""

    now: float = 1_000.0

    def __call__(self) -> float:
        """Return the time now."""
        return self.now


@dataclass
class TickingChat:
    """Wraps a fake chat and moves a clock on after every call, so a slow model can be played out."""

    inner: FakeChat
    clock: FakeClock
    seconds: list[float]
    calls: int = field(default=0)

    def complete(
        self, alias: str, messages: Sequence[ChatMessage], max_tokens: int, timeout_seconds: float | None = None
    ) -> Completion:
        """Answer from the fake, then let the scripted number of seconds pass."""
        reply = self.inner.complete(alias, messages, max_tokens, timeout_seconds)
        self.clock.now += self.seconds[self.calls]
        self.calls += 1
        return reply


@dataclass
class Rig:
    """A pipeline with its fake chat and the spans it recorded, for a test to drive and inspect."""

    pipeline: AnalystPipeline
    chat: FakeChat
    writer: MemorySpanWriter


def make_rig(
    layer: SemanticLayer,
    policy: SqlPolicy,
    warehouse: Warehouse,
    sql_replies: list[str | Exception],
    explain_replies: list[str | Exception] | None = None,
    clock: FakeClock | None = None,
    seconds: list[float] | None = None,
) -> Rig:
    """Build a pipeline whose models answer from scripts."""
    chat = FakeChat({"lb-reason": list(sql_replies), "lb-fast": list(explain_replies or [EXPLANATION])})
    writer = MemorySpanWriter()
    clock = clock or FakeClock()
    models = TickingChat(chat, clock, seconds) if seconds is not None else chat
    pipeline = AnalystPipeline(layer, policy, warehouse, models, Tracer(writer), clock)
    return Rig(pipeline, chat, writer)


def ask(rig: Rig, question: str = QUESTION) -> Answer:
    """Put a question to the rig's pipeline as a visitor."""
    return rig.pipeline.answer(question, SESSION)


def test_a_question_is_answered_in_two_model_calls(
    layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse
) -> None:
    """The plain path: one call for the SQL, one for the explanation, and a table the query really produced."""
    rig = make_rig(layer, policy, warehouse, [sql_reply(REVENUE_SQL)])
    answer = ask(rig)
    assert answer.outcome is Outcome.ANSWERED
    assert answer.model_calls == 2
    assert [alias for alias, _ in rig.chat.requests] == ["lb-reason", "lb-fast"]
    assert answer.attempts == (Attempt(REVENUE_SQL),)
    assert answer.executed is not None
    assert answer.executed.result.rows == [(8766862,)]
    assert "LIMIT 1000" in answer.executed.sql
    assert answer.executed.tables == ("order_lines", "orders")
    assert answer.explanation == "Revenue last quarter was 8,766,862 CZK."
    assert answer.explanation_source == "model"
    assert answer.chart is None
    assert answer.as_of == warehouse.meta.as_of


def test_every_step_is_a_span_and_the_run_is_their_parent(
    layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse
) -> None:
    """The trace has a span for each step of the chain, in order, all under the run's own span."""
    rig = make_rig(layer, policy, warehouse, [sql_reply(REVENUE_SQL)])
    answer = ask(rig)
    assert rig.writer.names() == [
        "resolve metrics",
        "write SQL",
        "parse and allowlist",
        "explain plan",
        "run read-only",
        "build chart",
        "explain result",
        "data question",
    ]
    run_span = rig.writer.named("data question")
    assert run_span.kind == "system.run"
    assert run_span.run_id == answer.run_id
    assert all(span.parent_id == run_span.span_id for span in rig.writer.spans if span is not run_span)
    assert run_span.attrs == {"outcome": "answered", "model_calls": 2, "queries": 1, "rows": 1}
    assert rig.writer.named("resolve metrics").attrs == {
        "metrics": "revenue",
        "dimensions": "",
        "ranges": "last_quarter",
    }
    assert rig.writer.named("run read-only").attrs["rows"] == 1
    assert rig.writer.named("parse and allowlist").attrs["tables"] == "order_lines,orders"


def test_no_span_holds_the_visitors_words_or_the_sql(
    layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse
) -> None:
    """A trace is metadata: neither the question, nor a query, nor an answer is in any span, whatever the path."""
    scripts: list[tuple[list[str | Exception], list[str | Exception]]] = [
        ([sql_reply(REVENUE_SQL)], [EXPLANATION]),
        ([sql_reply(BAD_COLUMN_SQL), sql_reply(REVENUE_SQL)], [EXPLANATION]),
        ([sql_reply("DROP TABLE orders")], []),
        ([declined_reply("There is no zebrapotato data.")], []),
    ]
    for sql_replies, explain_replies in scripts:
        rig = make_rig(layer, policy, warehouse, sql_replies, explain_replies)
        ask(rig)
        for span in rig.writer.spans:
            text = json.dumps(span.attrs).lower()
            assert "zebrapotato" not in text
            assert "drop table" not in text
            assert "from orders" not in text
            assert "sum(" not in text
            assert "revenue was" not in text


def test_the_calls_carry_the_run_and_the_visitors_session(
    layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse
) -> None:
    """Every call is made inside the run, as a visitor's, so the gateway can count it against the visitor's quota."""
    rig = make_rig(layer, policy, warehouse, [sql_reply(REVENUE_SQL)])
    answer = ask(rig)
    assert len(rig.chat.runs) == 2
    for run in rig.chat.runs:
        assert run is not None
        assert (run.system, run.data_class, run.session, run.run_id) == ("lb-05", "visitor", SESSION, answer.run_id)
    assert rig.chat.output_caps == {"lb-reason": SQL_MAX_TOKENS, "lb-fast": EXPLAIN_MAX_TOKENS}
    assert all(timeout is not None and timeout <= CALL_TIMEOUT_SECONDS for timeout in rig.chat.timeouts)


def test_an_eval_question_runs_as_synthetic_data_with_no_session(
    layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse
) -> None:
    """A golden case is synthetic, and spends no visitor's quota."""
    rig = make_rig(layer, policy, warehouse, [sql_reply(REVENUE_SQL)])
    rig.pipeline.answer(QUESTION, SESSION, data_class="synthetic")
    assert {(run.data_class, run.session) for run in rig.chat.runs if run is not None} == {("synthetic", None)}


def test_the_question_reaches_the_model_quoted_with_what_was_resolved(
    layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse
) -> None:
    """The SQL writer is given the dates and the definitions, and the question as quoted data."""
    rig = make_rig(layer, policy, warehouse, [sql_reply(REVENUE_SQL)])
    ask(rig)
    system, user = rig.chat.asked("lb-reason")[0]
    assert system.role == "system"
    assert "last quarter = 2026-07-01 to 2026-09-30" in user.content
    assert "- revenue = SUM(" in user.content
    assert user.content.rstrip().endswith('"""')
    assert "zebrapotato" in user.content


def test_a_question_the_data_cannot_answer_is_declined_with_one_call(
    layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse
) -> None:
    """The model says what is missing; nothing runs, and there is no explanation to write."""
    rig = make_rig(layer, policy, warehouse, [declined_reply("The data has no  salaries.\n")], [])
    answer = ask(rig, "What is the average salary of our employees?")
    assert answer.outcome is Outcome.DECLINED
    assert answer.reason == "The data has no salaries."
    assert answer.model_calls == 1
    assert answer.executed is None
    assert answer.attempts == ()


def test_a_mistake_is_corrected_once(layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse) -> None:
    """A query the allowlist refuses gets one more try, with the refusal's reason, and the second query runs."""
    rig = make_rig(layer, policy, warehouse, [sql_reply(BAD_COLUMN_SQL), sql_reply(REVENUE_SQL)])
    answer = ask(rig)
    assert answer.outcome is Outcome.ANSWERED
    assert answer.model_calls == 3
    first, second = answer.attempts
    assert (first.stopped_by, first.rule) == (Layer.ALLOWLIST, Rule.UNKNOWN_COLUMN)
    assert first.sql == BAD_COLUMN_SQL
    assert first.message is not None
    assert "revenue" in first.message
    assert second == Attempt(REVENUE_SQL)
    correction = rig.chat.asked("lb-reason")[1]
    assert [message.role for message in correction] == ["system", "user", "assistant", "user"]
    assert "allowlist check (unknown_column)" in correction[3].content
    assert "self-correct" in rig.writer.names()
    assert rig.writer.names().count("write SQL again") == 1
    refused_span = rig.writer.spans[rig.writer.names().index("parse and allowlist")]
    assert refused_span.status == "error"
    assert refused_span.attrs["layer"] == "allowlist"
    assert refused_span.attrs["rule"] == "unknown_column"


@pytest.mark.parametrize(
    ("first_sql", "layer_name", "rule"),
    [
        (LOOP_SQL, Layer.EXPLAIN, Rule.CROSS_PRODUCT),
        (RUNTIME_ERROR_SQL, Layer.CONNECTION, Rule.RUNTIME_ERROR),
        ("SELECT * FROM", Layer.PARSE, Rule.SYNTAX_ERROR),
    ],
    ids=["plan-check", "database-error", "syntax"],
)
def test_the_plan_check_and_the_database_can_also_send_a_query_back(
    layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse, first_sql: str, layer_name: Layer, rule: Rule
) -> None:
    """A refusal by the plan check, a database error or a syntax error is a mistake, and is corrected once too."""
    rig = make_rig(layer, policy, warehouse, [sql_reply(first_sql), sql_reply(REVENUE_SQL)])
    answer = ask(rig)
    assert answer.outcome is Outcome.ANSWERED
    assert (answer.attempts[0].stopped_by, answer.attempts[0].rule) == (layer_name, rule)


def test_an_attack_is_refused_at_once_and_never_retried(
    layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse
) -> None:
    """A destructive statement ends the question: no second try, no explanation, and the layer and rule are named."""
    rig = make_rig(layer, policy, warehouse, [sql_reply("DROP TABLE orders")], [])
    answer = ask(rig, "Drop the orders table.")
    assert answer.outcome is Outcome.REFUSED
    assert answer.model_calls == 1
    assert answer.executed is None
    (attempt,) = answer.attempts
    assert (attempt.stopped_by, attempt.rule, attempt.sql) == (Layer.PARSE, Rule.NOT_SELECT, "DROP TABLE orders")
    assert rig.chat.calls() == 1
    assert warehouse.run("SELECT COUNT(*) FROM orders").rows == [(28435,)]


def test_a_second_refusal_ends_the_question(layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse) -> None:
    """The model gets one correction and no more: if that is refused too, the question is refused."""
    rig = make_rig(
        layer, policy, warehouse, [sql_reply(BAD_COLUMN_SQL), sql_reply("SELECT orders.nothing FROM orders")], []
    )
    answer = ask(rig)
    assert answer.outcome is Outcome.REFUSED
    assert answer.model_calls == 2
    assert [attempt.rule for attempt in answer.attempts] == [Rule.UNKNOWN_COLUMN, Rule.UNKNOWN_COLUMN]


def test_the_model_may_decline_after_a_refusal(layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse) -> None:
    """Told its query was refused, a model that sees the data isn't there says so, which is a decline."""
    rig = make_rig(
        layer, policy, warehouse, [sql_reply("SELECT orders.cost FROM orders"), declined_reply("No cost data.")], []
    )
    answer = ask(rig, "What was our profit margin?")
    assert answer.outcome is Outcome.DECLINED
    assert answer.reason == "No cost data."
    assert len(answer.attempts) == 1


def test_a_reply_that_is_not_the_json_asked_for_is_repaired_once(
    layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse
) -> None:
    """A bad reply costs a call: the repair names what was wrong, and its answer is used."""
    rig = make_rig(layer, policy, warehouse, ["Here you go: SELECT 1", sql_reply(REVENUE_SQL)])
    answer = ask(rig)
    assert answer.outcome is Outcome.ANSWERED
    assert answer.model_calls == 3
    assert rig.writer.named("write SQL").attrs["attempts"] == 2


def test_the_worst_case_is_exactly_five_calls(layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse) -> None:
    """A repaired SQL reply, a correction and its repair, and the explanation: five calls, and no more are possible."""
    rig = make_rig(
        layer,
        policy,
        warehouse,
        ["not json", sql_reply(BAD_COLUMN_SQL), "still not json", sql_reply(REVENUE_SQL)],
    )
    answer = ask(rig)
    assert answer.outcome is Outcome.ANSWERED
    assert answer.model_calls == MAX_MODEL_CALLS == 5
    assert rig.chat.calls() == 5


def test_a_reply_that_stays_malformed_leaves_no_answer(
    layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse
) -> None:
    """After one repair, a reply that still isn't the JSON object is a failure to answer, not a guess."""
    rig = make_rig(layer, policy, warehouse, ["nope", "still nope"], [])
    answer = ask(rig)
    assert (answer.outcome, answer.reason, answer.model_calls) == (Outcome.UNAVAILABLE, "model_output", 2)
    assert rig.writer.named("data question").attrs["reason"] == "model_output"


def test_a_failed_explanation_never_fails_the_question(
    layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse
) -> None:
    """The explainer gets one call and no repair, and a plain sentence stands in when it can't be used."""
    for bad in ("no json at all", unavailable()):
        rig = make_rig(layer, policy, warehouse, [sql_reply(MONTHLY_SQL)], [bad, EXPLANATION])
        answer = ask(rig)
        assert answer.outcome is Outcome.ANSWERED
        assert answer.explanation_source == "fallback"
        assert answer.explanation is not None
        assert "columns month, orders" in answer.explanation
        assert answer.model_calls == 2
        assert rig.writer.named("explain result").attrs["source"] == "fallback"


def test_the_gateways_failures_are_told_from_its_budgets(
    layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse
) -> None:
    """A spent budget or quota is not a breakage, and says so."""

    class SpentError(OpenAIError):
        """A gateway answer saying the day's budget is used up."""

        code = "budget_exhausted"

    for error, reason in ((unavailable(), "model_failed"), (SpentError("spent"), "model_budget")):
        rig = make_rig(layer, policy, warehouse, [error], [])
        answer = ask(rig)
        assert (answer.outcome, answer.reason, answer.model_calls) == (Outcome.UNAVAILABLE, reason, 1)
    assert model_failure(SpentError("x")) is Unavailable.MODEL_BUDGET
    assert model_failure(unavailable()) is Unavailable.MODEL_FAILED


def test_an_unexpected_error_is_not_hidden(layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse) -> None:
    """A bug is not turned into an answer: it propagates, so the API can log it, refund the question and say 500."""
    rig = make_rig(layer, policy, warehouse, [RuntimeError("a bug")], [])
    with pytest.raises(RuntimeError, match="a bug"):
        ask(rig)
    assert rig.writer.named("data question").status == "error"


def test_a_slow_model_is_given_the_time_the_question_has_left(
    layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse
) -> None:
    """Each call waits at most the 60 seconds it is allowed, or what is left of the question's 90, whichever is less."""
    clock = FakeClock()
    rig = make_rig(layer, policy, warehouse, [sql_reply(REVENUE_SQL)], clock=clock, seconds=[50.0, 1.0])
    answer = ask(rig)
    assert answer.outcome is Outcome.ANSWERED
    assert rig.chat.timeouts == [CALL_TIMEOUT_SECONDS, 40.0]
    assert answer.elapsed_ms == 51_000


def test_a_question_that_runs_out_of_time_before_the_explanation_is_still_answered(
    layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A slow query leaves under two seconds: no call is made, and the table and chart stand with a plain sentence."""
    clock = FakeClock()
    rig = make_rig(layer, policy, warehouse, [sql_reply(MONTHLY_SQL)], clock=clock)
    real_run = warehouse.run

    def slow_run(sql: str, max_rows: int = 1000, timeout_seconds: float = 5.0) -> QueryResult:
        """Run the query, and let the clock say it took almost all the question's time."""
        clock.now += 89.0
        return real_run(sql, max_rows, timeout_seconds)

    monkeypatch.setattr(warehouse, "run", slow_run)
    answer = ask(rig)
    assert answer.outcome is Outcome.ANSWERED
    assert answer.explanation_source == "fallback"
    assert answer.model_calls == 1
    assert answer.chart is not None
    assert answer.chart.kind == "line"


def test_a_question_that_runs_out_of_time_before_the_query_is_unavailable(
    layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse
) -> None:
    """A query is not started with no time to run it in."""
    rig = make_rig(layer, policy, warehouse, [sql_reply(REVENUE_SQL)], clock=FakeClock(), seconds=[89.5])
    answer = ask(rig)
    assert (answer.outcome, answer.reason) == (Outcome.UNAVAILABLE, "time_limit")


def test_a_busy_warehouse_is_unavailable_and_not_an_error(
    layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When every place to run a query is taken, the question can't be answered now, and says why."""
    monkeypatch.setattr(warehouse_module, "SLOT_WAIT_SECONDS", 0.05)
    rig = make_rig(layer, policy, warehouse, [sql_reply(REVENUE_SQL)], [])
    with warehouse.slot(), warehouse.slot(), warehouse.slot():
        answer = ask(rig)
    assert (answer.outcome, answer.reason) == (Outcome.UNAVAILABLE, "warehouse_busy")


def test_a_result_cut_by_the_row_cap_says_so_to_the_explainer(
    layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse
) -> None:
    """A table of every order is cut to 1,000 rows, and the answer and the explainer are told."""
    rig = make_rig(layer, policy, warehouse, [sql_reply("SELECT orders.order_id FROM orders")])
    answer = ask(rig, "Give me every order.")
    assert answer.executed is not None
    assert len(answer.executed.result.rows) == 1000
    assert answer.executed.truncated is True
    assert "cut at 1,000 rows" in rig.chat.asked("lb-fast")[0][1].content


def test_a_chart_is_chosen_from_the_result(layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse) -> None:
    """Orders by month come back with a line chart, and the span says which kind."""
    rig = make_rig(layer, policy, warehouse, [sql_reply(MONTHLY_SQL)])
    answer = ask(rig)
    assert answer.chart is not None
    assert answer.chart.kind == "line"
    assert rig.writer.named("build chart").attrs["kind"] == "line"


def test_the_budget_counts_calls_and_refuses_the_sixth() -> None:
    """No code behind the budget can make a sixth call."""
    chat = FakeChat({"lb-fast": ["a"] * 6})
    budget = QuestionBudget(chat)
    for _ in range(MAX_MODEL_CALLS):
        budget.complete("lb-fast", [ChatMessage("user", "hi")], 10)
    with pytest.raises(QuestionLimitError) as stopped:
        budget.complete("lb-fast", [ChatMessage("user", "hi")], 10)
    assert stopped.value.reason is Unavailable.CALL_LIMIT
    assert budget.calls == 5
    assert chat.calls() == 5


def test_the_budget_refuses_a_call_when_time_is_short_and_counts_a_failed_call() -> None:
    """Under two seconds left, no call; and a call that fails still counts, as the gateway counts it."""
    clock = FakeClock()
    failing = FakeChat({"lb-fast": [unavailable()]})
    budget = QuestionBudget(failing, clock, deadline_seconds=10.0)
    with pytest.raises(OpenAIError):
        budget.complete("lb-fast", [ChatMessage("user", "hi")], 10)
    assert budget.calls == 1
    clock.now += 9.0
    with pytest.raises(QuestionLimitError) as stopped:
        budget.complete("lb-fast", [ChatMessage("user", "hi")], 10)
    assert stopped.value.reason is Unavailable.TIME_LIMIT
    assert budget.calls == 1


def test_the_budget_passes_the_smaller_of_the_two_timeouts() -> None:
    """A caller's own timeout is honoured, and never more than the time left."""
    clock = FakeClock()
    chat = FakeChat({"lb-fast": ["a", "b"]})
    budget = QuestionBudget(chat, clock, deadline_seconds=30.0)
    budget.complete("lb-fast", [ChatMessage("user", "hi")], 10, timeout_seconds=5.0)
    budget.complete("lb-fast", [ChatMessage("user", "hi")], 10, timeout_seconds=500.0)
    assert chat.timeouts == [5.0, 30.0]


def test_a_structured_output_error_names_no_content() -> None:
    """The error a bad reply raises is a type and a schema name, which is what reaches a log."""
    assert str(StructuredOutputError("SqlAnswer didn't validate")) == "SqlAnswer didn't validate"


@pytest.mark.parametrize(
    ("columns", "rows", "truncated", "expected"),
    [
        ([("revenue_czk", "integer")], [(5,)], False, "revenue czk: 5."),
        ([("a", "text"), ("n", "integer")], [], False, "No rows matched the question."),
        (
            [("a", "text"), ("n", "integer")],
            [("x", 1), ("y", 2)],
            False,
            "The query returned 2 rows with the columns a, n.",
        ),
        (
            [("a", "text"), ("n", "integer")],
            [("x", 1), ("y", 2)],
            True,
            "The query returned 2 rows with the columns a, n. The result was cut at 1,000 rows.",
        ),
    ],
)
def test_the_stand_in_explanation_for_each_shape_of_result(
    columns: list[tuple[str, str]], rows: list[tuple[object, ...]], truncated: bool, expected: str
) -> None:
    """Without a model, a result is still described in a plain sentence."""
    result = QueryResult(
        tuple(ResultColumn(name, kind) for name, kind in columns),  # type: ignore[arg-type]
        rows,  # type: ignore[arg-type]
        capped=False,
        elapsed_ms=1,
    )
    executed = Executed("SELECT 1", result, truncated, (), 0, PlanReport((), 0))
    assert fallback_explanation(executed) == expected


def test_model_text_is_made_fit_to_show() -> None:
    """Control characters and runs of spaces go, and the text is cut to its limit."""
    assert clean_text("a\x00b \n\t  c\x07", 100) == "a b c"
    assert clean_text("x" * 50, 10) == "x" * 10


def test_a_result_is_cut_short_only_when_the_cap_applied_and_filled() -> None:
    """A query that asked for fewer rows than the cap, or a result with room to spare, was not cut."""
    result = QueryResult((ResultColumn("n", "integer"),), [(n,) for n in range(1000)], capped=False, elapsed_ms=1)
    applied = ValidatedQuery("SELECT 1", (), 0, 1000, True)
    own = ValidatedQuery("SELECT 1", (), 0, 1000, False)
    assert was_cut_short(applied, result) is True
    assert was_cut_short(own, result) is False
    assert was_cut_short(applied, QueryResult(result.columns, result.rows[:10], capped=False, elapsed_ms=1)) is False
    assert was_cut_short(own, QueryResult(result.columns, result.rows, capped=True, elapsed_ms=1)) is True
