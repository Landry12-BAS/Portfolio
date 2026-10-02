"""Integration tests for the span writer against a real Redis: both streams, their caps, and outages."""

import logging
from collections.abc import Callable

import pytest
from redis import Redis

from lb_common.run import Run, run_scope, span_scope
from lb_common.tracing import RedisSpanWriter, Span, Tracer, root_span_id

pytestmark = pytest.mark.integration

RUN = Run(system="lb-01", run_id="run-redis-0001", session="session-0123456789abcdef")


def test_spans_reach_the_runs_stream_and_the_stream_of_every_run(
    redis: Redis, prefix: str, read_spans: Callable[[str], list[Span]]
) -> None:
    """The Scope reads the first; the persister drains the second."""
    tracer = Tracer(RedisSpanWriter(redis, prefix))

    with run_scope(RUN), tracer.span("ticket", kind="system.run"), tracer.span("classify") as step:
        step.set("category", "damaged")

    run_spans = read_spans(f"{prefix}run:run-redis-0001:spans")
    all_spans = read_spans(f"{prefix}spans")
    assert [span.name for span in run_spans] == ["classify", "ticket"]
    assert all_spans == run_spans
    assert run_spans[0].attrs == {"category": "damaged"}
    assert run_spans[0].parent_id == run_spans[1].span_id


def test_a_root_written_when_a_run_ends_is_last_in_the_stream_and_has_no_parent(
    redis: Redis, prefix: str, read_spans: Callable[[str], list[Span]]
) -> None:
    """A run in turns (a conversation) names its root in advance and writes it last: what the gateway calls finished."""
    tracer = Tracer(RedisSpanWriter(redis, prefix))

    with run_scope(RUN):
        with span_scope(root_span_id(RUN.run_id)), tracer.span("visitor message"):
            pass
        tracer.finish_run("booking conversation", 1_790_000_000_000, messages=2, booked=False)

    spans = read_spans(f"{prefix}run:run-redis-0001:spans")
    assert [span.name for span in spans] == ["visitor message", "booking conversation"]
    assert spans[0].parent_id == spans[1].span_id == root_span_id(RUN.run_id)
    [*_, (_, fields)] = redis.xrange(f"{prefix}run:run-redis-0001:spans") or []
    assert fields is not None
    assert '"kind":"system.run"' in fields["span"]
    assert "parentId" not in fields["span"]


def test_a_runs_stream_expires_after_a_day(redis: Redis, prefix: str) -> None:
    """Visitor runs don't outlive the retention rule; the persister keeps what matters."""
    tracer = Tracer(RedisSpanWriter(redis, prefix))

    with run_scope(RUN), tracer.span("classify"):
        pass

    ttl = redis.ttl(f"{prefix}run:run-redis-0001:spans")
    assert 86_000 < ttl <= 86_400


def test_spans_share_the_gateways_stream_format(redis: Redis, prefix: str) -> None:
    """One field, `span`, holding the JSON the gateway writes, so one reader handles both."""
    tracer = Tracer(RedisSpanWriter(redis, prefix))

    with run_scope(RUN), tracer.span("classify"):
        pass

    [(_, fields)] = redis.xrange(f"{prefix}run:run-redis-0001:spans") or []
    assert fields is not None
    assert list(fields) == ["span"]
    assert '"runId":"run-redis-0001"' in fields["span"]


def test_an_outage_drops_the_spans_but_never_fails_the_run(caplog: pytest.LogCaptureFixture) -> None:
    """Telemetry is not worth a visitor's run: the step finishes, and the loss is logged."""
    unreachable = Redis.from_url("redis://127.0.0.1:1", socket_connect_timeout=0.2)
    tracer = Tracer(RedisSpanWriter(unreachable, "lbtest-down:"))

    with caplog.at_level(logging.WARNING), run_scope(RUN), tracer.span("classify") as step:
        step.set("chunks", 3)

    assert "Dropped 1 run spans" in caplog.text
    unreachable.close()


def test_a_malformed_prefix_is_refused(redis: Redis) -> None:
    """The prefix follows the gateway's rule, so both write the same keys."""
    with pytest.raises(ValueError, match="ending in a colon"):
        RedisSpanWriter(redis, "LB")
