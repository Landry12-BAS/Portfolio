"""Unit tests for runs: the gateway's rules for their fields, and the current run and span."""

import pytest

from lb_common.run import RUN_ID, Run, current_run, current_span_id, new_run_id, run_scope, span_scope

SESSION = "session-0123456789abcdef"


def test_a_visitor_run_with_a_session_is_valid() -> None:
    """The common case: a visitor's action, with their hashed session key."""
    run = Run(system="lb-01", run_id="run-0001", session=SESSION)

    assert run.data_class == "visitor"


def test_a_synthetic_run_needs_no_session() -> None:
    """Curated samples belong to no visitor."""
    run = Run(system="lb-01", run_id="run-0001", data_class="synthetic")

    assert run.session is None


def test_a_visitor_run_without_a_session_is_refused() -> None:
    """Without it, the visitor's daily quota couldn't apply."""
    with pytest.raises(ValueError, match="session key"):
        Run(system="lb-01", run_id="run-0001")


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("system", "lb-1"),
        ("system", "LB-01"),
        ("run_id", "short"),
        ("run_id", "run:0001"),
        ("run_id", "běh-0001"),
        ("session", "too-short"),
        ("session", "session 0123456789abcdef"),
        ("data_class", "public"),
    ],
)
def test_fields_the_gateway_would_refuse_are_refused_here(field: str, value: str) -> None:
    """Colons, spaces and accented letters could otherwise reach the gateway's Redis keys."""
    fields: dict[str, str] = {"system": "lb-01", "run_id": "run-0001", "session": SESSION, field: value}

    with pytest.raises(ValueError, match=r"not a|is 8 to 64|is 16 to 128"):
        Run(**fields)  # type: ignore[arg-type]


def test_new_run_ids_are_unique_and_valid() -> None:
    """Random IDs fit the gateway's format and never repeat in practice."""
    ids = {new_run_id() for _ in range(1000)}

    assert len(ids) == 1000
    assert all(RUN_ID.fullmatch(run_id) for run_id in ids)


def test_the_current_run_is_set_inside_its_scope_only() -> None:
    """Outside `run_scope` there is no run; inside it, there is exactly that one."""
    run = Run(system="lb-01", run_id="run-0001", session=SESSION)

    assert current_run() is None
    with run_scope(run):
        assert current_run() is run
    assert current_run() is None


def test_a_new_run_starts_outside_any_span() -> None:
    """A run started inside another run's span doesn't inherit that span as its parent."""
    outer = Run(system="lb-01", run_id="run-0001", session=SESSION)
    inner = Run(system="lb-01", run_id="run-0002", session=SESSION)

    with run_scope(outer), span_scope("0123456789abcdef"):
        with run_scope(inner):
            assert current_span_id() is None
        assert current_span_id() == "0123456789abcdef"


def test_span_scopes_nest_and_unwind() -> None:
    """The innermost span is current, and leaving it restores the one around it."""
    with span_scope("aaaaaaaaaaaaaaaa"):
        with span_scope("bbbbbbbbbbbbbbbb"):
            assert current_span_id() == "bbbbbbbbbbbbbbbb"
        assert current_span_id() == "aaaaaaaaaaaaaaaa"
    assert current_span_id() is None


def test_a_malformed_span_id_is_refused() -> None:
    """Span IDs become a gateway header, so only 16 hex digits pass."""
    with pytest.raises(ValueError, match="16 lowercase hex digits"), span_scope("not-a-span-id"):
        pass
