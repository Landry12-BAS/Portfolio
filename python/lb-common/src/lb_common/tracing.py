"""Run spans from the systems' own code: the steps, tool calls and checks of a run.

Spans use the gateway's format (services/gateway/src/spans.ts) and go to the same Redis
streams, so one run's trace holds the system's steps with the gateway's model calls
nested under them. They carry metadata only (names, timings, counts, scores), never a
visitor's text or a model's answer. Telemetry never fails a run: a span that can't be
written is logged and dropped.

    with tracer.span("hybrid search") as span:
        chunks = search(query)
        span.set("chunks", len(chunks))
"""

import logging
import math
import re
import secrets
import time
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from typing import Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel
from redis import Redis
from redis.exceptions import RedisError
from redis.typing import EncodableT, FieldT

from lb_common.run import Run, current_run, current_span_id, span_scope

logger = logging.getLogger(__name__)

# How a span ended; `skipped` marks a step the run passed over.
type SpanStatus = Literal["ok", "error", "skipped"]
# What a system's span describes: its whole run, one step of it, or one tool call.
type SpanKind = Literal["system.run", "system.step", "system.tool"]
# A detail on a span: a label, a count, a score or a flag.
type AttrValue = str | int | float | bool

# The gateway's stream caps, so both writers keep the streams the same.
RUN_STREAM_MAXLEN = 1_000
RUN_STREAM_TTL_SECONDS = 86_400
ALL_STREAM_MAXLEN = 100_000

# The gateway's rule for LB_REDIS_PREFIX, such as `lb:`.
REDIS_PREFIX = re.compile(r"[a-z0-9-]{1,24}:")
# Span names such as `hybrid search`, and detail names such as `top_score`.
SPAN_NAME = re.compile(r"[\w .:/-]{1,100}", re.ASCII)
ATTR_NAME = re.compile(r"[a-zA-Z][a-zA-Z0-9_.]{0,63}")
# Details are short labels, such as a category or a model, not content.
MAX_ATTR_TEXT = 200


class Span(BaseModel):
    """One finished step of a run, in the gateway's span format (version 1)."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        validate_by_name=True,
        validate_by_alias=True,
        serialize_by_alias=True,
        frozen=True,
        extra="forbid",
        allow_inf_nan=False,
    )

    v: Literal[1] = 1
    run_id: str
    system: str
    span_id: str
    parent_id: str | None = None
    # A system kind such as `system.step`, or a gateway kind such as `gateway.call`.
    kind: str
    name: str
    status: SpanStatus
    start_ms: int
    end_ms: int
    attrs: dict[str, AttrValue] = Field(default_factory=dict)

    def to_json(self) -> str:
        """Serialise the span as the gateway does: camelCase keys, and no parentId when there is none."""
        return self.model_dump_json(exclude_none=True)


def new_span_id() -> str:
    """Make a random span ID of 16 hex digits, the size the gateway and OpenTelemetry use."""
    return secrets.token_hex(8)


def epoch_ms() -> int:
    """Return the current Unix time in milliseconds, the clock spans are stamped with."""
    return time.time_ns() // 1_000_000


class SpanWriter(Protocol):
    """Somewhere finished spans go."""

    def write(self, spans: Sequence[Span]) -> None:
        """Store the spans. Must never raise: telemetry can't be allowed to fail a run."""


class RedisSpanWriter:
    """Appends spans to Redis streams, exactly as the gateway's RedisSpanSink does.

    Each span goes to its run's stream, which the Scope reads live, and to the stream of
    every run, which a persister drains into `platform.run_spans`. Both are capped.
    """

    def __init__(self, redis: Redis, prefix: str = "lb:") -> None:
        """Write to `redis` under the gateway's key prefix (its LB_REDIS_PREFIX)."""
        if not REDIS_PREFIX.fullmatch(prefix):
            raise ValueError("The prefix is lowercase letters, digits and hyphens, ending in a colon, such as lb:.")
        self._redis = redis
        self._prefix = prefix

    def run_stream(self, run_id: str) -> str:
        """Return the Redis key of a run's span stream."""
        return f"{self._prefix}run:{run_id}:spans"

    def write(self, spans: Sequence[Span]) -> None:
        """Write the spans to both streams in one round trip. Never raises."""
        if not spans:
            return
        pipeline = self._redis.pipeline(transaction=False)
        for span in spans:
            fields: dict[FieldT, EncodableT] = {"span": span.to_json()}
            run_stream = self.run_stream(span.run_id)
            pipeline.xadd(run_stream, fields, maxlen=RUN_STREAM_MAXLEN, approximate=True)
            pipeline.expire(run_stream, RUN_STREAM_TTL_SECONDS)
            pipeline.xadd(f"{self._prefix}spans", fields, maxlen=ALL_STREAM_MAXLEN, approximate=True)
        try:
            pipeline.execute()
        except RedisError:
            logger.warning("Dropped %d run spans: Redis did not take them.", len(spans), exc_info=True)


class OpenSpan:
    """A span being recorded: where it sits in its run, and the details its step adds."""

    def __init__(self, run: Run, name: str, kind: SpanKind, parent_id: str | None, start_ms: int) -> None:
        """Open a span of `run` called `name`, nested under `parent_id`, started at `start_ms`."""
        if not SPAN_NAME.fullmatch(name):
            raise ValueError(f"{name!r} is not a span name: 1 to 100 letters, digits, spaces or . : / - _.")
        self.run = run
        self.span_id = new_span_id()
        self.parent_id = parent_id
        self.name = name
        self.kind = kind
        self.start_ms = start_ms
        self.status: SpanStatus = "ok"
        self.attrs: dict[str, AttrValue] = {}

    def set(self, name: str, value: AttrValue) -> None:
        """Add a detail to the span, such as a count, a score or a label.

        Details are metadata: text is capped at 200 characters, and a visitor's own words
        must never be recorded here.
        """
        if not ATTR_NAME.fullmatch(name):
            raise ValueError(f"{name!r} is not a detail name: letters, digits, dots and underscores.")
        if isinstance(value, str) and len(value) > MAX_ATTR_TEXT:
            raise ValueError(f"Span details are short labels of at most {MAX_ATTR_TEXT} characters.")
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError(f"The detail {name!r} is not a finite number.")
        self.attrs[name] = value

    def skip(self, reason: str) -> None:
        """Mark the step as passed over, for example because a cached result made it unnecessary."""
        self.status = "skipped"
        self.set("outcome", reason)

    def finish(self, end_ms: int) -> Span:
        """Close the span and return it in the gateway's format."""
        return Span(
            run_id=self.run.run_id,
            system=self.run.system,
            span_id=self.span_id,
            parent_id=self.parent_id,
            kind=self.kind,
            name=self.name,
            status=self.status,
            start_ms=self.start_ms,
            end_ms=end_ms,
            attrs=self.attrs,
        )


class Tracer:
    """Records the spans of the current run."""

    def __init__(self, writer: SpanWriter, clock: Callable[[], int] = epoch_ms) -> None:
        """Send finished spans to `writer`. `clock` returns Unix time in milliseconds."""
        self._writer = writer
        self._clock = clock

    @contextmanager
    def span(self, name: str, kind: SpanKind = "system.step", **attrs: AttrValue) -> Iterator[OpenSpan]:
        """Record the `with` block as a span of the current run, under the innermost open span.

        Model calls made inside the block nest under this span in the trace. If the block
        raises, the span ends with status `error` and the exception's type (never its
        message, which could quote content), and the exception carries on.
        """
        run = current_run()
        if run is None:
            raise RuntimeError("Spans belong to a run: open one with run_scope() first.")
        span = OpenSpan(run, name, kind, current_span_id(), self._clock())
        for key, value in attrs.items():
            span.set(key, value)
        try:
            with span_scope(span.span_id):
                yield span
        except BaseException as error:
            span.status = "error"
            span.attrs["error"] = type(error).__name__
            raise
        finally:
            self._writer.write([span.finish(self._clock())])
