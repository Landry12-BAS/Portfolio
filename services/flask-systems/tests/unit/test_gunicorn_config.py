"""Tests for the gunicorn settings (gunicorn.conf.py): the ones that keep the server small, local and quiet.

The file is plain Python that gunicorn runs, so it is run here the same way, with the environment under the test's
control. Nothing starts a server: `just flask` and the smoke run in the README do that.
"""

import runpy
from pathlib import Path
from typing import Any

import pytest

from core.cli import SERVICE_DIRECTORY

CONFIG_FILE = Path(SERVICE_DIRECTORY / "gunicorn.conf.py")
OVERRIDES = ("GUNICORN_BIND", "GUNICORN_WORKERS", "GUNICORN_THREADS", "GUNICORN_FORWARDED_ALLOW_IPS")


@pytest.fixture
def settings(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Run the config file with no overrides in the environment, and return the settings it sets."""
    for name in OVERRIDES:
        monkeypatch.delenv(name, raising=False)
    return runpy.run_path(str(CONFIG_FILE))


def test_it_listens_on_the_loopback_only_by_default(settings: dict[str, Any]) -> None:
    """The service sits behind the reverse proxy on the same machine: no public interface is bound unless asked for."""
    assert settings["bind"] == "127.0.0.1:8102"
    assert settings["forwarded_allow_ips"] == "127.0.0.1"


def test_it_runs_threaded_workers_that_build_the_app_after_the_fork(settings: dict[str, Any]) -> None:
    """One worker of eight threads, never preloaded: DuckDB and the pool belong to the process that uses them."""
    assert settings["worker_class"] == "gthread"
    assert (settings["workers"], settings["threads"]) == (1, 8)
    assert settings["preload_app"] is False


def test_the_admin_control_socket_is_closed(settings: dict[str, Any]) -> None:
    """Least privilege: gunicorn's control channel is a way in nobody here needs."""
    assert settings["control_socket_disable"] is True


def test_request_limits_are_small_and_workers_are_recycled(settings: dict[str, Any]) -> None:
    """Requests are small JSON documents, and a slow leak is capped by replacing each worker now and then."""
    assert settings["limit_request_line"] <= 2_048
    assert settings["limit_request_field_size"] <= 4_096
    assert settings["limit_request_fields"] <= 40
    assert 0 < settings["max_requests"] <= 2_000
    assert settings["max_requests_jitter"] > 0


def test_the_access_log_keeps_no_address_header_body_or_query_string(settings: dict[str, Any]) -> None:
    """One line of method, path, status and seconds: nothing a visitor typed, and no IP address in the clear."""
    assert settings["access_log_format"] == "%(m)s %(U)s %(s)s %(L)s"
    assert settings["accesslog"] == "-"


def test_the_environment_can_change_where_and_how_wide_it_serves(monkeypatch: pytest.MonkeyPatch) -> None:
    """The deployment's overrides are read, so a container can bind its own address and size."""
    monkeypatch.setenv("GUNICORN_BIND", "0.0.0.0:9000")
    monkeypatch.setenv("GUNICORN_WORKERS", "2")
    monkeypatch.setenv("GUNICORN_THREADS", "4")

    settings = runpy.run_path(str(CONFIG_FILE))

    assert (settings["bind"], settings["workers"], settings["threads"]) == ("0.0.0.0:9000", 2, 4)
