"""Unit tests for the tracer: span nesting, outcomes, details, and the gateway's span format."""

import json
from collections.abc import Iterator, Sequence

import pytest

from lb_common.run import Run, run_scope
from lb_common.tracing import Span, Tracer

RUN = Run(system="lb-01", run_id="run-0001", session="session-0123456789abcdef")


class MemoryWriter:
    """A span writer that keeps spans in a list, in the order they finish."""

    def __init__(self) -> None:
        """Start with no spans."""
        self.spans: list[Span] = []

    def write(self, spans: Sequence[Span]) -> None:
        """Keep the spans."""
        self.spans.extend(spans)


class StepClock:
    """A clock that moves 10 ms every time it is read, so spans get distinct times."""

    def __init__(self) -> None:
        """Start at a fixed Unix time in milliseconds."""
        self.now = 1_790_000_000_000

    def __call__(self) -> int:
        """Return the time, then move on."""
        self.now += 10
        return self.now


@pytest.fixture
def writer() -> MemoryWriter:
    """Collect the test tracer's spans."""
    return MemoryWriter()


@pytest.fixture
def tracer(writer: MemoryWriter) -> Iterator[Tracer]:
    """Open a tracer inside a test run."""
    with run_scope(RUN):
        yield Tracer(writer, StepClock())


def test_a_span_records_its_step(tracer: Tracer, writer: MemoryWriter) -> None:
    """Name, kind, run, timing and details all reach the written span."""
    with tracer.span("hybrid search", chunks=12) as span:
        span.set("top_score", 0.82)

    [written] = writer.spans
    assert written.name == "hybrid search"
    assert written.kind == "system.step"
    assert written.status == "ok"
    assert (written.run_id, written.system) == ("run-0001", "lb-01")
    assert written.parent_id is None
    assert written.end_ms > written.start_ms
    assert written.attrs == {"chunks": 12, "top_score": 0.82}


def test_nested_spans_point_at_their_parent(tracer: Tracer, writer: MemoryWriter) -> None:
    """Inner spans finish first and name the span around them as their parent."""
    with tracer.span("ticket", kind="system.run") as outer:
        with tracer.span("classify"):
            pass
        with tracer.span("look up order", kind="system.tool"):
            pass

    classify, lookup, ticket = writer.spans
    assert ticket.span_id == outer.span_id
    assert classify.parent_id == outer.span_id
    assert lookup.parent_id == outer.span_id
    assert lookup.kind == "system.tool"


def test_a_failed_step_records_the_error_type_but_not_its_message(tracer: Tracer, writer: MemoryWriter) -> None:
    """Messages can quote content, so only the exception's type goes in the trace."""
    with pytest.raises(LookupError), tracer.span("look up order"):
        raise LookupError("order BB-1042 for jana@example.com")

    [written] = writer.spans
    assert written.status == "error"
    assert written.attrs == {"error": "LookupError"}
    assert "jana" not in written.to_json()


def test_a_skipped_step_says_why(tracer: Tracer, writer: MemoryWriter) -> None:
    """A step passed over is recorded, with its reason."""
    with tracer.span("draft") as span:
        span.skip("cached_sample")

    [written] = writer.spans
    assert written.status == "skipped"
    assert written.attrs == {"outcome": "cached_sample"}


@pytest.mark.parametrize(
    ("name", "value", "problem"),
    [
        ("top score", 1, "not a detail name"),
        ("9lives", 1, "not a detail name"),
        ("note", "x" * 201, "short labels"),
        ("score", float("nan"), "finite"),
        ("score", float("inf"), "finite"),
    ],
)
def test_details_must_be_short_metadata(tracer: Tracer, name: str, value: float | str, problem: str) -> None:
    """Long text, odd names and non-numbers are refused where they are set."""
    with pytest.raises(ValueError, match=problem), tracer.span("classify") as span:
        span.set(name, value)


def test_a_malformed_span_name_is_refused(tracer: Tracer) -> None:
    """Names are short labels too."""
    with pytest.raises(ValueError, match="not a span name"), tracer.span("classify\nnow"):
        pass


def test_spans_belong_to_a_run(writer: MemoryWriter) -> None:
    """Outside a run there is nowhere to record a span."""
    tracer = Tracer(writer)

    with pytest.raises(RuntimeError, match="run_scope"), tracer.span("classify"):
        pass
    assert writer.spans == []


def test_spans_serialise_in_the_gateways_format() -> None:
    """The JSON matches services/gateway/src/spans.ts field for field, with no parentId when there is none."""
    span = Span(
        run_id="run-0001",
        system="lb-01",
        span_id="0123456789abcdef",
        kind="system.step",
        name="classify",
        status="ok",
        start_ms=1,
        end_ms=2,
        attrs={"category": "damaged", "score": 0.5, "cached": False},
    )

    assert json.loads(span.to_json()) == {
        "v": 1,
        "runId": "run-0001",
        "system": "lb-01",
        "spanId": "0123456789abcdef",
        "kind": "system.step",
        "name": "classify",
        "status": "ok",
        "startMs": 1,
        "endMs": 2,
        "attrs": {"category": "damaged", "score": 0.5, "cached": False},
    }


def test_a_gateway_span_reads_back() -> None:
    """Spans the gateway wrote parse into the same model, parent and all."""
    line = (
        '{"v":1,"runId":"run-0001","system":"lb-01","spanId":"fedcba9876543210","parentId":"0123456789abcdef",'
        '"kind":"gateway.call","name":"lb-fast","status":"ok","startMs":1,"endMs":9,'
        '"attrs":{"alias":"lb-fast","attempts":1,"stream":false}}'
    )

    span = Span.model_validate_json(line)

    assert span.kind == "gateway.call"
    assert span.parent_id == "0123456789abcdef"
    assert span.attrs["attempts"] == 1
