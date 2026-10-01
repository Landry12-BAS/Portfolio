"""Tests for LB-05's API on the real parts: the service as its module wires it, a real Postgres ledger and Redis.

The model is still a scripted fake (no provider key exists here, and a test must never spend quota); everything
between the visitor's request and the model is real: the token check, the quota in Postgres, the semantic layer,
the SQL checks, DuckDB, and the run's spans going to a Redis stream.
"""

import threading
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest
from flask import Flask
from redis import Redis
from sqlalchemy import Engine, select
from werkzeug.test import TestResponse

from core.app import create_app
from core.platform import Platform
from core.registry import SystemModule
from core.structured import ChatMessage, Completion
from lb05.models import QuotaUsage
from lb05.module import build_runtime
from lb05.safety import QUESTIONS_PER_DAY
from lb_common.tracing import RedisSpanWriter, Span, Tracer
from tests.support import (
    EXPLANATION,
    QUESTION,
    REVENUE_SQL,
    SESSION,
    TODAY,
    FakeChat,
    SiteKey,
    make_environment,
    sql_reply,
    unavailable,
)

pytestmark = pytest.mark.integration

OTHER_SESSION = "session-of-kim-visitor-0002"
DAY = TODAY.date()


@dataclass
class BlockingChat:
    """A model that holds a question until the test lets it go, so questions can be made to overlap exactly."""

    inner: FakeChat
    started: threading.Event = field(default_factory=threading.Event)
    release: threading.Event = field(default_factory=threading.Event)

    def complete(
        self, alias: str, messages: Sequence[ChatMessage], max_tokens: int, timeout_seconds: float | None = None
    ) -> Completion:
        """Say a question has reached the model, wait to be released, then answer from the script."""
        self.started.set()
        if not self.release.wait(timeout=30):
            raise TimeoutError("The test never let the model go.")
        return self.inner.complete(alias, messages, max_tokens, timeout_seconds)


@dataclass
class Served:
    """LB-05 served through the real app factory over real Postgres and Redis."""

    app: Flask
    site_key: SiteKey

    def request(
        self, method: str, path: str, session: str = SESSION, body: dict[str, str] | None = None
    ) -> TestResponse:
        """Send a request as a visitor with a valid token, from a client of its own (so threads don't share one)."""
        headers = self.site_key.headers("lb-05", session)
        return self.app.test_client().open(path, method=method, headers=headers, json=body)

    def ask(self, question: str = QUESTION, session: str = SESSION) -> TestResponse:
        """Post a question as a visitor."""
        return self.request("POST", "/api/lb05/ask", session, {"question": question})


def answers(count: int) -> dict[str, list[str | Exception]]:
    """Script the models for `count` questions that are each answered with the revenue query."""
    return {"lb-reason": [sql_reply(REVENUE_SQL)] * count, "lb-fast": [EXPLANATION] * count}


@pytest.fixture
def serve(engine: Engine, redis: Redis, prefix: str, small_data: Path) -> Callable[..., Served]:
    """Return a function that serves LB-05 on a given model, on the test's database, Redis prefix and dataset."""

    def build(chat: FakeChat | BlockingChat, now: datetime = TODAY) -> Served:
        """Build the platform and LB-05's runtime the way production does, with the model replaced and a fixed clock."""
        site_key = SiteKey()
        environment = make_environment(
            LB05_WAREHOUSE_DIR=str(small_data), LB_REDIS_PREFIX=prefix, LB_WEB_TOKEN_KEY=site_key.public
        )
        platform = Platform(
            environment=environment,
            engines={"lb05": engine},
            chat=chat,
            tracer=Tracer(RedisSpanWriter(redis, prefix=prefix)),
            clock=lambda: now,
        )
        module = SystemModule(key="lb-05", schema="lb05", build=build_runtime)
        return Served(create_app(platform, [module]), site_key)

    return build


def stored_count(engine: Engine, session: str = SESSION, day: date = DAY) -> int | None:
    """Read a visitor's count for a day straight from Postgres."""
    with engine.connect() as connection:
        return connection.execute(
            select(QuotaUsage.used).where(QuotaUsage.session_key == session, QuotaUsage.day == day)
        ).scalar_one_or_none()


def test_the_service_is_ready_when_its_database_answers(serve: Callable[..., Served]) -> None:
    """Readiness is the database's: with Postgres up, LB-05 reports itself ready."""
    served = serve(FakeChat(answers(0)))

    response = served.app.test_client().get("/api/readyz")

    assert (response.status_code, response.get_json()) == (200, {"lb05": True})


def test_a_question_is_answered_and_counted_in_postgres(serve: Callable[..., Served], engine: Engine) -> None:
    """The whole way on real parts: token, quota row, checked SQL on DuckDB, the answer, and the count stored."""
    served = serve(FakeChat(answers(1)))

    response = served.ask()
    body = response.get_json()

    assert response.status_code == 200
    assert body["outcome"] == "answered"
    assert body["remaining_questions"] == QUESTIONS_PER_DAY - 1
    assert stored_count(engine) == 1
    assert served.request("GET", "/api/lb05/quota").get_json()["used"] == 1


def test_the_twenty_sixth_question_is_refused_and_the_limit_survives_a_restart(
    serve: Callable[..., Served], engine: Engine
) -> None:
    """25 answered, the 26th a 429 with the reset time; a new process on the same database still says no."""
    first_process = serve(FakeChat(answers(QUESTIONS_PER_DAY)))

    statuses = [first_process.ask().status_code for _ in range(QUESTIONS_PER_DAY)]
    refused = first_process.ask()
    after_restart = serve(FakeChat(answers(1))).ask()

    assert statuses == [200] * QUESTIONS_PER_DAY
    assert refused.status_code == 429
    assert refused.get_json()["error"]["code"] == "daily_limit"
    assert refused.get_json()["error"]["resets_at"] == "2026-10-02T00:00:00+00:00"
    assert after_restart.status_code == 429
    assert stored_count(engine) == QUESTIONS_PER_DAY


def test_the_next_day_starts_again_from_zero(serve: Callable[..., Served], engine: Engine) -> None:
    """The count is per UTC day: after midnight the visitor has all 25 again, and yesterday's count is untouched."""
    today = serve(FakeChat(answers(1)))
    tomorrow = serve(FakeChat(answers(1)), now=TODAY + timedelta(days=1))

    today.ask()
    response = tomorrow.ask()

    assert response.status_code == 200
    assert response.get_json()["remaining_questions"] == QUESTIONS_PER_DAY - 1
    assert stored_count(engine, day=DAY) == 1
    assert stored_count(engine, day=DAY + timedelta(days=1)) == 1


def test_a_question_the_models_could_not_answer_is_given_back_in_postgres(
    serve: Callable[..., Served], engine: Engine
) -> None:
    """The refund is real: the stored count goes back down, and the visitor is free to ask again at once."""
    served = serve(FakeChat({"lb-reason": [unavailable(), sql_reply(REVENUE_SQL)], "lb-fast": [EXPLANATION]}))

    failed = served.ask()
    count_after_failure = stored_count(engine)
    retried = served.ask()

    assert failed.get_json()["outcome"] == "unavailable"
    assert count_after_failure == 0
    assert retried.get_json()["outcome"] == "answered"
    assert stored_count(engine) == 1


def test_a_second_question_while_one_runs_is_refused_at_once_and_the_first_still_answers(
    serve: Callable[..., Served], engine: Engine
) -> None:
    """One question at a time per visitor, with real overlap: the model holds the first until the second is refused."""
    chat = BlockingChat(FakeChat(answers(2)))
    served = serve(chat)

    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(served.ask)
        assert chat.started.wait(timeout=30)
        second = served.ask()
        other_visitor_quota = served.request("GET", "/api/lb05/quota", OTHER_SESSION).get_json()
        running_quota = served.request("GET", "/api/lb05/quota").get_json()
        chat.release.set()
        finished = first.result(timeout=60)
    third = served.ask()

    assert second.status_code == 429
    assert second.get_json()["error"]["code"] == "question_running"
    assert running_quota["used"] == 1
    assert other_visitor_quota["used"] == 0
    assert finished.status_code == 200
    assert finished.get_json()["outcome"] == "answered"
    assert third.status_code == 200
    assert stored_count(engine) == 2


def test_the_spans_of_a_question_reach_redis_without_the_visitors_words(
    serve: Callable[..., Served], prefix: str, read_spans: Callable[[str], list[Span]]
) -> None:
    """The run's steps are in its Redis stream under the platform's prefix, and carry no part of the question."""
    served = serve(FakeChat(answers(1)))

    body = served.ask().get_json()
    spans = read_spans(f"{prefix}run:{body['run_id']}:spans")

    names = {span.name for span in spans}
    assert {"data question", "resolve metrics", "parse and allowlist", "explain plan", "run read-only"} <= names
    assert {span.system for span in spans} == {"lb-05"}
    assert {span.run_id for span in spans} == {body["run_id"]}
    dump = " ".join(span.to_json() for span in spans)
    assert "zebrapotato" not in dump
    assert "revenue last quarter" not in dump.lower()
    assert SESSION not in dump
