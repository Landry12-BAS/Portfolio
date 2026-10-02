"""Tests for LB-05's HTTP API (lb05/api.py): the visitor guard, a question's whole way, the daily limit and refunds.

The API is served through the real app factory over the real semantic layer, SQL checks and warehouse, with a
scripted fake in place of the gateway and an in-memory ledger in place of Postgres. The ledger's own rules, against a
real Postgres, are tested in tests/integration/test_quota.py, and the API on that ledger in test_api.py there.
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime

import pytest
from flask import Flask
from flask.testing import FlaskClient
from sqlalchemy.exc import OperationalError
from werkzeug.test import TestResponse

from core.app import create_app
from core.platform import Platform
from core.registry import SystemModule, SystemRuntime
from lb05.api import BUSY_MESSAGE, DAILY_LIMIT_MESSAGE, SYSTEM_KEY, build_blueprint
from lb05.golden import read_adversarial_set
from lb05.pipeline import AnalystPipeline
from lb05.prompts import MAX_QUESTION_CHARS
from lb05.quota import Admission, Ledger, Usage, midnight_after
from lb05.safety import (
    MAX_MODEL_CALLS,
    MAX_REFUNDS_PER_DAY,
    MAX_ROWS,
    QUESTION_DEADLINE_SECONDS,
    QUESTIONS_PER_DAY,
)
from lb05.semantic_layer import SemanticLayer
from lb05.service import Lb05Service
from lb05.sql_policy import SqlPolicy
from lb05.warehouse import Warehouse
from lb_common.tracing import Tracer
from tests.support import (
    EXPLANATION,
    QUESTION,
    REVENUE_SQL,
    SESSION,
    TODAY,
    FakeChat,
    MemorySpanWriter,
    SiteKey,
    declined_reply,
    make_platform,
    sql_reply,
    unavailable,
)

OTHER_SESSION = "session-of-kim-visitor-0002"
SECRET_WORDS = "words-that-must-not-reach-a-log"
ROUTES = [("post", "/api/lb05/ask"), ("get", "/api/lb05/semantic-layer"), ("get", "/api/lb05/quota")]


@dataclass
class MemoryLedger:
    """A ledger kept in memory with the Postgres one's rules: a limit a day, one question at a time, capped refunds."""

    limit: int = QUESTIONS_PER_DAY
    max_refunds: int = MAX_REFUNDS_PER_DAY
    used: dict[str, int] = field(default_factory=dict)
    refunds: dict[str, int] = field(default_factory=dict)
    running: set[str] = field(default_factory=set)
    ended: list[tuple[str, bool]] = field(default_factory=list)

    def now(self) -> datetime:
        """Return the moment the tests treat as now."""
        return TODAY

    def admit(self, session_key: str) -> Admission:
        """Let a question in when the visitor has one left and none running."""
        day = self.now().date()
        used = self.used.get(session_key, 0)
        if used >= self.limit:
            return Admission(False, "daily_limit", session_key, day, used, self.limit)
        if session_key in self.running:
            return Admission(False, "busy", session_key, day, used, self.limit)
        self.used[session_key] = used + 1
        self.running.add(session_key)
        return Admission(True, "ok", session_key, day, used + 1, self.limit)

    def finish(self, admission: Admission, refund: bool) -> bool:
        """End a question: the visitor can ask again, and gets the place back if a refund is asked for and allowed."""
        if not admission.allowed:
            return False
        key = admission.session_key
        self.running.discard(key)
        given_back = refund and self.refunds.get(key, 0) < self.max_refunds
        if given_back:
            self.used[key] -= 1
            self.refunds[key] = self.refunds.get(key, 0) + 1
        self.ended.append((key, given_back))
        return given_back

    def usage(self, session_key: str) -> Usage:
        """Return a visitor's count for today."""
        return Usage(self.used.get(session_key, 0), self.limit, midnight_after(self.now().date()))


class LedgerThatCannotFinish(MemoryLedger):
    """A ledger whose database goes away while a question runs, so ending the question fails."""

    def finish(self, admission: Admission, refund: bool) -> bool:  # noqa: ARG002 - the Ledger signature
        """Fail as a lost connection does, with a message that quotes a visitor."""
        raise OperationalError(SECRET_WORDS, {}, Exception(SECRET_WORDS))


@dataclass
class Rig:
    """The API served over the real parts, with the fakes a test scripts and inspects."""

    client: FlaskClient
    site_key: SiteKey
    chat: FakeChat
    ledger: MemoryLedger
    writer: MemorySpanWriter

    def ask(self, question: str = QUESTION, session: str = SESSION) -> TestResponse:
        """Post a question as a visitor with a valid token."""
        return self.client.post(
            "/api/lb05/ask", json={"question": question}, headers=self.site_key.headers(SYSTEM_KEY, session)
        )

    def get(self, path: str, session: str = SESSION) -> TestResponse:
        """Get a route as a visitor with a valid token."""
        return self.client.get(path, headers=self.site_key.headers(SYSTEM_KEY, session))


def serve(service: Lb05Service | None, site_key: SiteKey) -> Flask:
    """Serve LB-05's blueprint on its own through the real app factory."""

    def build(platform: Platform) -> SystemRuntime:  # noqa: ARG001 - the registry's signature
        """Build LB-05's runtime around the service a test made."""
        blueprint = build_blueprint(service, site_key.public)
        return SystemRuntime(blueprint=blueprint, is_ready=lambda: True)

    return create_app(make_platform(), [SystemModule(key=SYSTEM_KEY, schema="lb05", build=build)])


@pytest.fixture
def make_rig(layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse) -> Callable[..., Rig]:
    """Return a builder of rigs: pass the model's scripted replies, and optionally a ledger."""

    def build(replies: dict[str, list[str | Exception]] | None = None, ledger: MemoryLedger | None = None) -> Rig:
        """Build a rig whose models answer from `replies` (by alias)."""
        chat = FakeChat({"lb-reason": [], "lb-fast": [], **(replies or {})})
        writer = MemorySpanWriter()
        ledger = ledger or MemoryLedger()
        pipeline = AnalystPipeline(layer, policy, warehouse, chat, Tracer(writer))
        service = Lb05Service(layer, warehouse, pipeline, ledger, database_check=lambda: True)
        site_key = SiteKey()
        return Rig(serve(service, site_key).test_client(), site_key, chat, ledger, writer)

    return build


def one_question() -> dict[str, list[str | Exception]]:
    """Script the models for one question that is answered: the revenue query, then its explanation."""
    return {"lb-reason": [sql_reply(REVENUE_SQL)], "lb-fast": [EXPLANATION]}


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_every_route_needs_a_visitor_token_for_lb_05(make_rig: Callable[..., Rig], method: str, path: str) -> None:
    """No token, another system's token or a made-up one is refused before anything happens."""
    rig = make_rig(one_question())
    send = getattr(rig.client, method)
    other_system = rig.site_key.headers("lb-01")
    made_up = {"Authorization": "Bearer not.a.token"}

    answers = [send(path, json={"question": QUESTION})]
    answers += [send(path, json={"question": QUESTION}, headers=headers) for headers in (other_system, made_up)]

    for answer in answers:
        assert answer.status_code == 401
        assert answer.get_json()["error"]["code"] == "unauthorized"
    assert rig.chat.calls() == 0
    assert rig.ledger.used == {}


def test_a_question_is_answered_with_the_sql_the_table_and_an_explanation(make_rig: Callable[..., Rig]) -> None:
    """The whole way: the models' two calls, the checked SQL, its result, and the visitor's count going down."""
    rig = make_rig(one_question())

    response = rig.ask()
    body = response.get_json()

    assert response.status_code == 200
    assert body["outcome"] == "answered"
    assert body["model_calls"] == 2
    assert body["remaining_questions"] == QUESTIONS_PER_DAY - 1
    assert body["as_of"] == "2026-11-18"
    assert body["explanation"] == "Revenue last quarter was 8,766,862 CZK."
    assert body["explanation_source"] == "model"
    assert body["result"]["columns"] == [{"name": "revenue", "kind": "integer"}]
    assert body["result"]["row_count"] == len(body["result"]["rows"]) == 1
    assert body["result"]["tables"] == ["order_lines", "orders"]
    assert body["result"]["joins"] == 1
    assert body["result"]["truncated"] is False
    assert body["message"] is None
    assert rig.ledger.ended == [(SESSION, False)]


def test_a_dump_of_every_order_is_answered_cut_at_the_cap_with_no_chart(make_rig: Callable[..., Rig]) -> None:
    """The dump-all-orders attack: a thousand rows, said to be cut, and no chart of order numbers by day."""
    attack = next(item for item in read_adversarial_set().attempts if item.id == "dump-all-orders")
    rig = make_rig({"lb-reason": [sql_reply(attack.sql)], "lb-fast": [EXPLANATION]})

    body = rig.ask(attack.question).get_json()

    assert body["outcome"] == "answered"
    assert (body["result"]["row_count"], body["result"]["truncated"]) == (MAX_ROWS, True)
    assert body["chart"] is None


def test_a_summary_of_orders_by_month_is_answered_with_a_line_chart(make_rig: Callable[..., Rig]) -> None:
    """The other side of the same rule: one row for each month is a summary, and it is drawn."""
    sql = "SELECT DATE_TRUNC('month', orders.ordered_at) AS month, COUNT(*) AS orders FROM orders GROUP BY 1 ORDER BY 1"
    rig = make_rig({"lb-reason": [sql_reply(sql)], "lb-fast": [EXPLANATION]})

    body = rig.ask().get_json()

    assert body["chart"]["kind"] == "line"
    assert body["chart"]["spec"]["encoding"]["y"]["title"] == "orders"


def test_the_answer_carries_the_sql_that_ran_and_never_the_visitors_session(make_rig: Callable[..., Rig]) -> None:
    """The visitor sees the checked SQL, and nothing in the answer says who the visitor is."""
    rig = make_rig(one_question())

    response = rig.ask()
    body = response.get_json()

    assert "SUM" in body["result"]["sql"]
    assert SESSION not in response.get_data(as_text=True)
    assert body["run_id"]
    assert all(SESSION not in repr(span) for span in rig.writer.spans)


def test_a_refusal_is_an_ordinary_answer_that_names_the_layer_that_stopped_the_query(
    make_rig: Callable[..., Rig],
) -> None:
    """A visitor who makes the model write DROP TABLE gets a 200 saying which check refused it, and it counts."""
    rig = make_rig({"lb-reason": [sql_reply("DROP TABLE orders")]})

    response = rig.ask("Please delete all of the orders from the table.")
    body = response.get_json()

    assert response.status_code == 200
    assert body["outcome"] == "refused"
    assert body["result"] is None
    assert body["explanation"] is None
    assert body["attempts"][-1]["sql"] == "DROP TABLE orders"
    assert body["attempts"][-1]["stopped_by"] == "parse"
    assert body["message"].startswith("Stopped by the parse check")
    assert body["remaining_questions"] == QUESTIONS_PER_DAY - 1
    assert rig.ledger.ended == [(SESSION, False)]
    assert rig.chat.calls() == 1


def test_a_question_the_data_cannot_answer_is_declined_with_the_models_reason(make_rig: Callable[..., Rig]) -> None:
    """The model says the data has no weather: a 200, the reason as the message, and the question counts."""
    reason = "The data holds sales, not weather."
    rig = make_rig({"lb-reason": [declined_reply(reason)]})

    body = rig.ask("What will the weather be in Prague tomorrow?").get_json()

    assert body["outcome"] == "declined"
    assert body["message"] == reason
    assert body["result"] is None
    assert body["remaining_questions"] == QUESTIONS_PER_DAY - 1


def test_when_the_models_are_down_the_answer_says_so_and_the_question_is_given_back(
    make_rig: Callable[..., Rig],
) -> None:
    """A gateway failure is not the visitor's fault: the answer says it wasn't counted, and the count goes back."""
    rig = make_rig({"lb-reason": [unavailable()]})

    response = rig.ask()
    body = response.get_json()

    assert response.status_code == 200
    assert body["outcome"] == "unavailable"
    assert "was not counted" in body["message"]
    assert body["remaining_questions"] == QUESTIONS_PER_DAY
    assert rig.ledger.used[SESSION] == 0
    assert rig.ledger.ended == [(SESSION, True)]
    assert rig.ledger.running == set()


def test_a_crash_inside_a_question_is_a_500_that_frees_and_refunds_the_visitor(
    make_rig: Callable[..., Rig], caplog: pytest.LogCaptureFixture
) -> None:
    """A bug must not lock a visitor out: the question is refunded, nothing of it is echoed, and they can ask again."""
    rig = make_rig({"lb-reason": [RuntimeError(SECRET_WORDS), sql_reply(REVENUE_SQL)], "lb-fast": [EXPLANATION]})

    with caplog.at_level(logging.ERROR):
        crashed = rig.ask()
    again = rig.ask()

    assert crashed.status_code == 500
    assert crashed.get_json()["error"]["code"] == "internal_error"
    assert SECRET_WORDS not in crashed.get_data(as_text=True)
    assert SECRET_WORDS not in caplog.text
    assert rig.ledger.ended[0] == (SESSION, True)
    assert again.get_json()["outcome"] == "answered"
    assert rig.ledger.used[SESSION] == 1


def test_a_crash_after_the_allowance_of_refunds_counts_like_any_other_failure(
    make_rig: Callable[..., Rig],
) -> None:
    """A bug that can be provoked is no free pass: with the refunds used up, the crashed question stays counted."""
    ledger = MemoryLedger(refunds={SESSION: MAX_REFUNDS_PER_DAY})
    rig = make_rig({"lb-reason": [RuntimeError(SECRET_WORDS)]}, ledger=ledger)

    crashed = rig.ask()

    assert crashed.status_code == 500
    assert ledger.ended == [(SESSION, False)]
    assert ledger.used[SESSION] == 1
    assert ledger.running == set()


def test_failures_that_cost_nothing_are_capped_so_a_visitor_cannot_try_without_end(
    make_rig: Callable[..., Rig],
) -> None:
    """Failures can be provoked on purpose, so only five a day are given back: the thirty-first attempt is refused.

    Without the cap every failed question is free, and a visitor who keeps the models failing (or too slow, or
    their replies unreadable) never reaches the limit of 25: this loop would run to its end with no 429.
    """
    attempts = 2 * QUESTIONS_PER_DAY
    rig = make_rig({"lb-reason": [unavailable() for _ in range(attempts)]})

    answers = []
    for _ in range(attempts):
        response = rig.ask()
        if response.status_code == 429:
            break
        answers.append(response.get_json())
    else:
        pytest.fail("A visitor whose questions all fail was never stopped.")

    given_back = [body for body in answers if "was not counted" in body["message"]]
    counted = [body for body in answers if "was counted" in body["message"]]
    assert len(answers) == QUESTIONS_PER_DAY + MAX_REFUNDS_PER_DAY
    assert len(given_back) == MAX_REFUNDS_PER_DAY
    assert len(counted) == QUESTIONS_PER_DAY
    assert [body["remaining_questions"] for body in given_back] == [QUESTIONS_PER_DAY] * MAX_REFUNDS_PER_DAY
    assert counted[-1]["remaining_questions"] == 0
    assert str(MAX_REFUNDS_PER_DAY) in counted[0]["message"]
    assert rig.ledger.used[SESSION] == QUESTIONS_PER_DAY


def test_however_many_questions_fail_a_visitor_is_never_given_more_than_twenty_five_answers(
    make_rig: Callable[..., Rig],
) -> None:
    """Answers and failures mixed: the answers a visitor receives stay within 25, and the day still comes to an end."""
    pairs = 2 * QUESTIONS_PER_DAY
    replies: dict[str, list[str | Exception]] = {
        "lb-reason": [reply for _ in range(pairs) for reply in (unavailable(), sql_reply(REVENUE_SQL))],
        "lb-fast": [EXPLANATION] * pairs,
    }
    rig = make_rig(replies)

    outcomes = []
    for _ in range(2 * pairs):
        response = rig.ask()
        if response.status_code == 429:
            break
        outcomes.append(response.get_json()["outcome"])
    else:
        pytest.fail("A visitor who mixes answers and failures was never stopped.")

    assert outcomes.count("answered") <= QUESTIONS_PER_DAY
    assert outcomes.count("answered") + outcomes.count("unavailable") - MAX_REFUNDS_PER_DAY == QUESTIONS_PER_DAY
    assert rig.ledger.used[SESSION] == QUESTIONS_PER_DAY


def test_the_twenty_sixth_question_of_the_day_is_refused_before_any_model_is_asked(
    make_rig: Callable[..., Rig],
) -> None:
    """Twenty-five questions are answered; the next is a 429 with the time the count starts again, and no model call."""
    rig = make_rig({"lb-reason": [sql_reply(REVENUE_SQL)] * QUESTIONS_PER_DAY, "lb-fast": [EXPLANATION] * 25})

    answers = [rig.ask() for _ in range(QUESTIONS_PER_DAY)]
    calls_before = rig.chat.calls()
    refused = rig.ask()

    assert [answer.status_code for answer in answers] == [200] * QUESTIONS_PER_DAY
    assert answers[-1].get_json()["remaining_questions"] == 0
    assert refused.status_code == 429
    error = refused.get_json()["error"]
    assert error["code"] == "daily_limit"
    assert error["message"] == DAILY_LIMIT_MESSAGE
    assert error["resets_at"] == "2026-10-02T00:00:00+00:00"
    assert rig.chat.calls() == calls_before == 2 * QUESTIONS_PER_DAY


def test_each_visitor_has_their_own_twenty_five(make_rig: Callable[..., Rig]) -> None:
    """One visitor using up their day leaves another's untouched."""
    ledger = MemoryLedger(used={SESSION: QUESTIONS_PER_DAY})
    rig = make_rig(one_question(), ledger=ledger)

    refused = rig.ask(session=SESSION)
    allowed = rig.ask(session=OTHER_SESSION)

    assert refused.status_code == 429
    assert allowed.status_code == 200
    assert allowed.get_json()["remaining_questions"] == QUESTIONS_PER_DAY - 1


def test_a_visitor_with_a_question_running_is_told_to_wait(make_rig: Callable[..., Rig]) -> None:
    """One question at a time per visitor: a second one gets a 429 that isn't about the day's limit."""
    ledger = MemoryLedger(used={SESSION: 1}, running={SESSION})
    rig = make_rig(one_question(), ledger=ledger)

    refused = rig.ask()

    assert refused.status_code == 429
    error = refused.get_json()["error"]
    assert error["code"] == "question_running"
    assert error["message"] == BUSY_MESSAGE
    assert "resets_at" not in error
    assert rig.chat.calls() == 0
    assert ledger.used == {SESSION: 1}


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"question": ""},
        {"question": "four"},
        {"question": "x" * (MAX_QUESTION_CHARS + 1)},
        {"question": 12345},
        {"question": None},
        {"question": ["revenue", "last", "quarter"]},
        {"question": "A null byte \x00 in a question"},
        {"question": "How is revenue doing?", "sql": "SELECT 1"},
    ],
    ids=["empty", "blank", "short", "long", "number", "null", "list", "control", "extra-field"],
)
def test_a_malformed_question_is_a_422_that_costs_nothing(
    make_rig: Callable[..., Rig], body: dict[str, object]
) -> None:
    """The body is checked before the quota is touched, and the answer names the field but never echoes it."""
    rig = make_rig(one_question())

    response = rig.client.post("/api/lb05/ask", json=body, headers=rig.site_key.headers(SYSTEM_KEY))

    assert response.status_code == 422
    error = response.get_json()["error"]
    assert error["code"] == "invalid_request"
    assert "Null byte" not in response.get_data(as_text=True)
    assert rig.ledger.used == {}
    assert rig.chat.calls() == 0


def test_a_question_that_is_not_json_is_refused_without_touching_the_quota(make_rig: Callable[..., Rig]) -> None:
    """A form post or plain text is a 4xx from the framework, in the platform's JSON shape."""
    rig = make_rig(one_question())
    headers = rig.site_key.headers(SYSTEM_KEY)

    form = rig.client.post("/api/lb05/ask", data={"question": QUESTION}, headers=headers)
    broken = rig.client.post("/api/lb05/ask", data="{not json", headers={**headers, "Content-Type": "application/json"})

    for response in (form, broken):
        assert 400 <= response.status_code < 500
        assert "error" in response.get_json()
    assert rig.ledger.used == {}


def test_the_quota_route_reports_the_count_the_reset_and_the_limits(make_rig: Callable[..., Rig]) -> None:
    """After one question 24 are left, the count resets at midnight UTC, and the limits are the datasheet's."""
    rig = make_rig(one_question())
    before = rig.get("/api/lb05/quota").get_json()
    rig.ask()

    after = rig.get("/api/lb05/quota").get_json()

    assert before["used"] == 0
    assert before["remaining"] == QUESTIONS_PER_DAY
    assert (after["used"], after["remaining"]) == (1, QUESTIONS_PER_DAY - 1)
    assert after["resets_at"] == "2026-10-02T00:00:00Z"
    assert after["limits"] == {
        "questions_per_day": QUESTIONS_PER_DAY,
        "query_timeout_seconds": 5.0,
        "row_cap": MAX_ROWS,
        "max_model_calls_per_question": MAX_MODEL_CALLS,
        "question_deadline_seconds": QUESTION_DEADLINE_SECONDS,
    }


def test_the_semantic_layer_route_describes_what_a_question_may_use(make_rig: Callable[..., Rig]) -> None:
    """The tables, joins, metrics and date phrases are served, and the two hidden columns are nowhere in them."""
    rig = make_rig(one_question())

    response = rig.get("/api/lb05/semantic-layer")
    body = response.get_json()

    assert response.status_code == 200
    assert body["version"] == 1
    assert body["as_of"] == "2026-11-18"
    assert [table["name"] for table in body["tables"]] == [
        "customers",
        "products",
        "orders",
        "order_lines",
        "subscriptions",
    ]
    metrics = {metric["name"]: metric for metric in body["metrics"]}
    assert metrics["revenue"]["kind"] == "expression"
    assert "line_total_czk" in metrics["revenue"]["definition"]
    assert metrics["repeat_buyers"]["kind"] == "worked_example"
    ranges = {item["name"]: item for item in body["ranges"]}
    assert (ranges["last_quarter"]["start"], ranges["last_quarter"]["end"]) == ("2026-07-01", "2026-09-30")
    assert "email" not in response.get_data(as_text=True).replace("e-mail", "")
    assert "payment_reference" not in response.get_data(as_text=True)


def test_without_a_gateway_the_layer_and_quota_are_served_but_a_question_is_a_503(
    layer: SemanticLayer, warehouse: Warehouse
) -> None:
    """A service with no model access can't answer, says so, and never counts the question."""
    ledger = MemoryLedger()
    site_key = SiteKey()
    service = Lb05Service(layer, warehouse, None, ledger, database_check=lambda: True)
    client = serve(service, site_key).test_client()
    headers = site_key.headers(SYSTEM_KEY)

    asked = client.post("/api/lb05/ask", json={"question": QUESTION}, headers=headers)
    read = client.get("/api/lb05/semantic-layer", headers=headers)
    counted = client.get("/api/lb05/quota", headers=headers)

    assert (asked.status_code, read.status_code, counted.status_code) == (503, 200, 200)
    assert asked.get_json()["error"]["code"] == "unavailable"
    assert ledger.used == {}


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_a_service_that_could_not_start_answers_503_after_the_token_check(method: str, path: str) -> None:
    """With no data or no layer, LB-05's routes say unavailable (and still refuse a visitor without a token first)."""
    site_key = SiteKey()
    client = serve(None, site_key).test_client()
    send = getattr(client, method)

    anonymous = send(path, json={"question": QUESTION})
    visitor = send(path, json={"question": QUESTION}, headers=site_key.headers(SYSTEM_KEY))

    assert anonymous.status_code == 401
    assert visitor.status_code == 503
    assert visitor.get_json()["error"]["code"] == "unavailable"


def test_losing_the_ledger_after_a_question_does_not_lose_the_answer(
    layer: SemanticLayer, policy: SqlPolicy, warehouse: Warehouse, caplog: pytest.LogCaptureFixture
) -> None:
    """If the database goes away while a question runs, the visitor still gets their answer; the failure is logged."""
    chat = FakeChat(one_question())
    pipeline = AnalystPipeline(layer, policy, warehouse, chat, Tracer(MemorySpanWriter()))
    service = Lb05Service(layer, warehouse, pipeline, LedgerThatCannotFinish(), database_check=lambda: True)
    site_key = SiteKey()
    client = serve(service, site_key).test_client()

    with caplog.at_level(logging.ERROR):
        response = client.post("/api/lb05/ask", json={"question": QUESTION}, headers=site_key.headers(SYSTEM_KEY))

    assert response.status_code == 200
    assert response.get_json()["outcome"] == "answered"
    assert "Could not end a question's quota entry" in caplog.text
    assert SECRET_WORDS not in caplog.text


def test_the_ledger_a_test_uses_is_a_ledger() -> None:
    """The in-memory ledger above has the shape the API needs, so a change to the protocol shows up here."""
    ledger: Ledger = MemoryLedger()

    assert ledger.admit(SESSION).allowed
    assert ledger.usage(SESSION).used == 1
    assert midnight_after(TODAY.date()) == datetime(2026, 10, 2, tzinfo=UTC)
