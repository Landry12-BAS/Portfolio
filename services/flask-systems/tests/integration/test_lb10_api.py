"""Tests for LB-10's API on the real parts: the service as its module wires it, a real Postgres and Redis.

The model is a fake (no provider key exists here, and a test must never spend quota); everything between
the visitor's request and the model is real: the token check, the quota in Postgres, the runner's event
loop, the pipeline, the cache, and the run's spans going to a Redis stream.
"""

import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from datetime import datetime
from typing import Any

import pytest
from flask import Flask
from redis import Redis
from sqlalchemy import Engine
from werkzeug.test import TestResponse

from core.app import create_app
from core.platform import Platform
from core.registry import SystemModule, SystemRuntime
from core.structured import ChatMessage
from lb10.api import SYSTEM_KEY, build_blueprint
from lb10.limits import MAX_REFUNDS_PER_DAY
from lb10.runner import EvalRunner
from lb10.service import Refusal, build_pipeline_factory, build_service
from lb10.templates import render
from lb_common.tracing import RedisSpanWriter, Span, Tracer
from tests.lb10_support import CLASSIFIER, FakeEvalChat, classification, committed_pack, right_answer
from tests.support import SESSION, TODAY, MemorySpanWriter, SiteKey, make_environment

pytestmark = pytest.mark.integration

OTHER_SESSION = "session-of-kim-visitor-0002"
PACK = committed_pack(CLASSIFIER)
EDITED = PACK.prompt.system + "\nBe brief."
# How long a test waits for a run on fakes to finish.
WAIT_SECONDS = 20.0


def answer_by_case(_alias: str, messages: Sequence[ChatMessage]) -> str:
    """Answer each case rightly: the user message names the ticket of exactly one case."""
    for case in PACK.cases:
        if render(PACK.prompt.user, case.inputs) == messages[1].content:
            return right_answer(PACK, case.id)
    raise AssertionError("the pipeline asked about a ticket no case has")


@dataclass
class Served:
    """LB-10 served through the real app factory over real Postgres and Redis."""

    app: Flask
    site_key: SiteKey
    chat: FakeEvalChat

    def request(
        self, method: str, path: str, session: str = SESSION, body: dict[str, object] | None = None
    ) -> TestResponse:
        """Send a request as a visitor with a valid token."""
        headers = self.site_key.headers(SYSTEM_KEY, session)
        return self.app.test_client().open(path, method=method, headers=headers, json=body)

    def start(
        self,
        prompt: str = EDITED,
        providers: Sequence[str] = ("groq",),
        session: str = SESSION,
        target: str = CLASSIFIER,
    ) -> TestResponse:
        """Start a run as a visitor."""
        body: dict[str, object] = {"target": target, "prompt": prompt, "providers": list(providers)}
        return self.request("POST", "/api/lb10/runs", session, body)

    def wait_for(self, run_id: str, session: str = SESSION) -> dict[str, Any]:
        """Poll a run until it is no longer running, and return it."""
        deadline = time.monotonic() + WAIT_SECONDS
        while time.monotonic() < deadline:
            response = self.request("GET", f"/api/lb10/runs/{run_id}", session)
            assert response.status_code == 200
            run: dict[str, Any] = response.get_json()
            if run["state"] != "running":
                return run
            time.sleep(0.05)
        raise AssertionError("the run did not end in time")


@pytest.fixture
def serve(lb10_engine: Engine, redis: Redis, prefix: str) -> Callable[..., Served]:
    """Return a function that serves LB-10 on a given fake model, on the test's database and Redis prefix."""
    built: list[Served] = []

    def build(chat: FakeEvalChat | None = None, now: datetime = TODAY) -> Served:
        """Build the platform and LB-10's runtime the way production does, with the model replaced."""
        site_key = SiteKey()
        fake = chat or FakeEvalChat(answer_by_case)
        environment = make_environment(LB_REDIS_PREFIX=prefix, LB_WEB_TOKEN_KEY=site_key.public)
        writer = RedisSpanWriter(redis, prefix=prefix)
        platform = Platform(
            environment=environment,
            engines={"lb10": lb10_engine},
            chat=None,
            tracer=Tracer(writer),
            clock=lambda: now,
            span_writer=writer,
        )

        def build_runtime(platform: Platform) -> SystemRuntime:
            """Build the runtime with the fake chat in the gateway's place."""
            service = build_service(platform, chat=fake)
            assert service is not None
            return SystemRuntime(
                blueprint=build_blueprint(service, platform.environment.web_token_key),
                is_ready=service.is_ready,
                start=service.start,
            )

        module = SystemModule(key=SYSTEM_KEY, schema="lb10", build=build_runtime)
        served = Served(create_app(platform, [module], start_background=True), site_key, fake)
        built.append(served)
        return served

    return build


def test_the_service_is_ready_when_its_database_answers(serve: Callable[..., Served]) -> None:
    """Readiness is the database's."""
    served = serve()
    response = served.app.test_client().get("/api/readyz")
    assert (response.status_code, response.get_json()) == (200, {"lb10": True})


def test_the_targets_list_every_pack_with_its_sample_and_only_the_visitor_providers(
    serve: Callable[..., Served],
) -> None:
    """The board's first read: the packs, the production prompt, the fixed ten cases, Groq and Workers AI."""
    served = serve()
    response = served.request("GET", "/api/lb10/targets")
    body = response.get_json()
    assert response.status_code == 200
    assert body["can_run"] is True
    assert body["limits"]["cases_per_run"] == 10
    assert body["limits"]["runs_per_day"] == 1
    classifier = next(target for target in body["targets"] if target["pack"] == CLASSIFIER)
    assert classifier["system_prompt"] == PACK.prompt.system
    assert len(classifier["sample"]) == 10
    assert [provider["id"] for provider in classifier["providers"]] == ["groq", "workers-ai"]
    assert all(not provider["trains_on_inputs"] for provider in classifier["providers"])
    assert {target["pack"] for target in body["targets"]} >= {
        "lb01-drafter",
        "lb02-planner",
        "lb05-sql-writer",
        "lb08-generator",
    }


def test_a_run_is_started_with_202_polled_and_ends_with_its_report_and_a_trace(
    serve: Callable[..., Served], read_spans: Callable[[str], list[Span]], prefix: str
) -> None:
    """The whole way: token, quota row, the runner, twenty fake calls, the cache, the report, the spans in Redis."""
    served = serve()

    response = served.start()
    body = response.get_json()
    assert response.status_code == 202, body
    assert body["remaining_runs"] == 0
    run_id = body["run"]["run_id"]
    assert body["run"]["state"] == "running"
    assert body["run"]["calls_total"] == 20

    run = served.wait_for(run_id)
    assert run["state"] == "done", run
    report = run["report"]
    assert report["total_model_calls"] == 20
    assert [variant["variant"] for variant in report["variants"]] == ["production", "edited"]
    assert report["comparisons"][0]["verdict"] == "no_detectable_difference"
    assert "small sample" in report["sample_note"]
    assert run["calls_done"] == 20
    spans = read_spans(f"{prefix}run:{run_id}:spans")
    names = [span.name for span in spans]
    assert names.count("model call") == 20
    assert "eval run" in names
    for span in spans:
        assert all("Be brief" not in str(value) for value in span.attrs.values())
    assert served.request("GET", "/api/lb10/quota").get_json()["remaining"] == 0
    today = served.request("GET", "/api/lb10/runs").get_json()
    assert [run["run_id"] for run in today["runs"]] == [run_id]


def test_the_second_run_of_the_day_is_refused_and_another_visitor_reads_the_cache(
    serve: Callable[..., Served],
) -> None:
    """One run a visitor a day; the next visitor's run on the same pack costs only their own prompt's calls."""
    served = serve()
    first = served.start()
    assert first.status_code == 202
    served.wait_for(first.get_json()["run"]["run_id"])
    again = served.start()
    assert again.status_code == 429
    assert again.get_json()["error"]["code"] == "daily_limit"
    assert "resets_at" in again.get_json()["error"]
    calls_before = len(served.chat.calls)

    other = served.start(prompt=EDITED + " Really.", session=OTHER_SESSION)
    assert other.status_code == 202
    run = served.wait_for(other.get_json()["run"]["run_id"], OTHER_SESSION)
    assert run["state"] == "done"
    assert len(served.chat.calls) - calls_before == 10
    assert run["report"]["total_cached_calls"] == 10
    # A visitor never reads another's run.
    stranger = served.request("GET", f"/api/lb10/runs/{run['run_id']}", SESSION)
    assert stranger.status_code == 404


def test_a_bad_prompt_or_a_forbidden_provider_is_refused_before_the_quota(serve: Callable[..., Served]) -> None:
    """A dropped variable, an unknown one, OpenRouter, an unknown target: each a plain refusal that costs nothing."""
    served = serve()
    drafter = committed_pack("lb01-drafter")
    dropped = served.start(prompt=drafter.prompt.system.replace("{{language}}", "English"), target="lb01-drafter")
    assert dropped.status_code == 422
    body = dropped.get_json()
    assert body["error"]["code"] == "invalid_prompt"
    assert body["problems"][0]["code"] == "missing_variables"
    assert "{{language}}" in body["problems"][0]["message"]
    unknown = served.start(prompt=PACK.prompt.system + " {{today}}")
    assert unknown.get_json()["problems"][0]["code"] == "unknown_variables"
    openrouter = served.start(providers=("openrouter",))
    assert (openrouter.status_code, openrouter.get_json()["error"]["code"]) == (422, "invalid_providers")
    assert served.start(target="lb99-nothing").status_code == 404
    assert served.request("GET", "/api/lb10/quota").get_json()["used"] == 0
    assert served.chat.calls == []


def test_a_prompt_at_the_limit_is_taken_however_many_bytes_its_characters_need(serve: Callable[..., Served]) -> None:
    """The limit is in characters: a prompt of the most characters allowed, in letters of two bytes, starts a run.

    Such a body is more than the app's few kilobytes for every other route, so the route that starts a run takes
    as much as a prompt at the limit can need; a character more is the prompt check's refusal, not the server's.
    """
    import json

    from lb10.limits import MAX_PROMPT_CHARS

    served = serve()

    def start_as_the_site_writes_it(prompt: str, session: str) -> TestResponse:
        """Start a run with the body as the site's server writes it: JSON with its letters as UTF-8, not escaped."""
        body = json.dumps({"target": CLASSIFIER, "prompt": prompt, "providers": ["groq"]}, ensure_ascii=False)
        headers = {**served.site_key.headers(SYSTEM_KEY, session), "Content-Type": "application/json"}
        return served.app.test_client().post("/api/lb10/runs", headers=headers, data=body.encode("utf-8"))

    longest = PACK.prompt.system + "\n" + "é" * (MAX_PROMPT_CHARS - len(PACK.prompt.system) - 1)
    assert len(longest) == MAX_PROMPT_CHARS
    assert len(longest.encode("utf-8")) > 8_192
    response = start_as_the_site_writes_it(longest, SESSION)
    assert response.status_code == 202, response.get_json()
    one_more = start_as_the_site_writes_it(longest + "é", OTHER_SESSION)
    assert (one_more.status_code, one_more.get_json()["error"]["code"]) == (422, "invalid_prompt")
    assert one_more.get_json()["problems"][0]["code"] == "too_long"


def test_an_unchanged_prompt_counts_only_the_calls_it_makes(serve: Callable[..., Served]) -> None:
    """An unchanged prompt runs once, so its run says ten calls a provider, and its bar can reach its end."""
    served = serve()
    response = served.start(prompt=PACK.prompt.system, providers=("groq", "workers-ai"))
    assert response.status_code == 202
    assert response.get_json()["run"]["calls_total"] == 20
    run = served.wait_for(response.get_json()["run"]["run_id"])
    assert run["state"] == "done"
    assert run["report"]["edited_is_production"] is True
    assert run["report"]["total_model_calls"] + run["report"]["total_cached_calls"] == run["calls_total"]


def test_a_run_whose_calls_all_fail_is_failed_and_given_back(serve: Callable[..., Served]) -> None:
    """When the gateway answers nothing at all, the run fails as such and the visitor keeps their run."""
    from lb_common.gateway import GatewayResponseError

    served = serve(FakeEvalChat(lambda _alias, _messages: GatewayResponseError("down")))
    response = served.start()
    assert response.status_code == 202
    run = served.wait_for(response.get_json()["run"]["run_id"])
    assert (run["state"], run["failure"]) == ("failed", "no_answers")
    assert served.request("GET", "/api/lb10/quota").get_json()["remaining"] == 1


def test_a_run_whose_every_call_fails_is_given_back_though_production_came_from_the_cache(
    serve: Callable[..., Served],
) -> None:
    """The models were down for every call the run made, so it measured nothing of the visitor's prompt.

    Production's results came from the cache, made by an earlier visitor's run: they are not this run's answers,
    and must not turn a run that measured nothing into a report in which the visitor's prompt failed every case.
    """
    from lb_common.gateway import GatewayResponseError

    served = serve()
    earlier = served.start(session=OTHER_SESSION, prompt=PACK.prompt.system + "\nBe kind.")
    assert served.wait_for(earlier.get_json()["run"]["run_id"], OTHER_SESSION)["state"] == "done"
    served.chat.answer = lambda _alias, _messages: GatewayResponseError("down")
    response = served.start()
    assert response.status_code == 202
    run = served.wait_for(response.get_json()["run"]["run_id"])
    assert (run["state"], run["failure"]) == ("failed", "no_answers")
    assert served.request("GET", "/api/lb10/quota").get_json()["remaining"] == 1


def test_a_visitor_the_full_lab_turns_away_keeps_their_run_however_often_it_happens(
    lb10_engine: Engine, prefix: str
) -> None:
    """A run the full runner never took costs nothing: not the day's run, nor a refund kept for runs that fail.

    The answer says nothing was counted and to try again in a minute. If giving the place back spent one of the
    day's refunds, the third visitor turned away would lose the run the answer said was not counted.
    """
    chat = FakeEvalChat(answer_by_case)
    platform = Platform(
        environment=make_environment(LB_REDIS_PREFIX=prefix, LB_WEB_TOKEN_KEY=SiteKey().public),
        engines={"lb10": lb10_engine},
        chat=None,
        tracer=Tracer(MemorySpanWriter()),
        clock=lambda: TODAY,
    )
    service = build_service(platform, chat=chat)
    assert service is not None
    full_runner = EvalRunner(
        build_pipeline_factory(chat, service.repository, platform), service.repository, service.ledger, max_in_flight=0
    )
    full = replace(service, runner=full_runner)
    try:
        for _ in range(MAX_REFUNDS_PER_DAY + 1):
            refused = full.start_run(SESSION, CLASSIFIER, EDITED, ["groq"])
            assert isinstance(refused, Refusal)
            assert (refused.status, refused.code) == (503, "lab_busy")
    finally:
        full_runner.close(0.0)
    assert service.usage(SESSION).remaining == 1
    admission = service.ledger.admit(SESSION)
    assert admission.allowed
    assert service.ledger.finish(admission, refund=True), "a run that fails is still given back"


def test_a_run_with_one_wrong_answer_lists_the_changed_case(serve: Callable[..., Served]) -> None:
    """The edited prompt makes the model wrong on one case: the report lists it with both outputs."""
    flipped = {"done": False}

    def wrong_once_when_edited(alias: str, messages: Sequence[ChatMessage]) -> str:
        """Answer rightly under production, and wrongly on the first edited call."""
        if messages[0].content != PACK.prompt.system and not flipped["done"]:
            flipped["done"] = True
            return classification("other", "BB-9999")
        return answer_by_case(alias, messages)

    served = serve(FakeEvalChat(wrong_once_when_edited))
    run = served.wait_for(served.start().get_json()["run"]["run_id"])
    comparison = run["report"]["comparisons"][0]
    assert comparison["regressed"] == 1
    assert comparison["verdict"] == "no_detectable_difference"
    assert comparison["changed"][0]["change"] == "regressed"
    assert "BB-9999" in comparison["changed"][0]["edited"]["output"]


def test_every_route_refuses_a_missing_or_foreign_token(serve: Callable[..., Served]) -> None:
    """No token, another system's token, a broken token: 401 in the platform's shape."""
    served = serve()
    client = served.app.test_client()
    for headers in ({}, served.site_key.headers("lb-05", SESSION), {"Authorization": "Bearer not.a.token"}):
        response = client.get("/api/lb10/targets", headers=headers)
        assert response.status_code == 401
        assert response.get_json()["error"]["code"] == "unauthorized"


def test_without_a_gateway_the_lab_serves_the_targets_and_refuses_to_run(lb10_engine: Engine, prefix: str) -> None:
    """No chat: the targets say `can_run` is false, and starting a run is a 503, not a crash."""
    site_key = SiteKey()
    spans = MemorySpanWriter()
    platform = Platform(
        environment=make_environment(LB_REDIS_PREFIX=prefix, LB_WEB_TOKEN_KEY=site_key.public),
        engines={"lb10": lb10_engine},
        chat=None,
        tracer=Tracer(spans),
        clock=lambda: TODAY,
    )
    service = build_service(platform)
    assert service is not None
    assert not service.can_run()
    app = create_app(
        platform,
        [
            SystemModule(
                key=SYSTEM_KEY,
                schema="lb10",
                build=lambda _platform: SystemRuntime(build_blueprint(service, site_key.public), service.is_ready),
            )
        ],
    )
    headers = site_key.headers(SYSTEM_KEY, SESSION)
    assert app.test_client().get("/api/lb10/targets", headers=headers).get_json()["can_run"] is False
    refused = app.test_client().post(
        "/api/lb10/runs", headers=headers, json={"target": CLASSIFIER, "prompt": EDITED, "providers": ["groq"]}
    )
    assert (refused.status_code, refused.get_json()["error"]["code"]) == (503, "unavailable")
    assert app.test_client().get("/api/lb10/baselines", headers=headers).get_json() == {"baselines": []}
    assert app.test_client().get("/api/lb10/nightly", headers=headers).get_json() == {"results": []}
