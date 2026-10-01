"""Tests for core.cli: `manage.py` runs the commands the platform and each system bring."""

from collections.abc import Sequence
from pathlib import Path

import pytest

from core import cli
from core.cli import all_commands, main
from core.platform import Platform
from core.registry import SystemModule
from tests.support import VALID_ENVIRONMENT, SiteKey
from tests.unit.test_http import stand_in_system


def record_arguments(arguments: Sequence[str], platform: Platform) -> int:  # noqa: ARG001 - the Command signature
    """Write the arguments the command got so a test can see them, and exit with status 7."""
    cli.write_line("got " + " ".join(arguments))
    return 7


def system_with_command(name: str) -> SystemModule:
    """Build a stand-in system that brings one command."""
    return SystemModule(
        key="lb-98", schema="lb98", build=stand_in_system(SiteKey()).build, commands={name: record_arguments}
    )


def test_runs_a_systems_command_with_its_arguments_and_returns_its_status(capsys: pytest.CaptureFixture[str]) -> None:
    """The first argument names the command; the rest go to it; its return value is the exit status."""
    status = main(["seed_thing", "--size", "small"], VALID_ENVIRONMENT, [system_with_command("seed_thing")])

    assert status == 7
    assert capsys.readouterr().out == "got --size small\n"


def test_an_unknown_command_lists_the_known_ones(capsys: pytest.CaptureFixture[str]) -> None:
    """A typo gets a usage line that names every command, and exit status 2."""
    status = main(["nope"], VALID_ENVIRONMENT, [system_with_command("seed_thing")])

    assert status == 2
    error = capsys.readouterr().err
    assert "export_openapi" in error
    assert "seed_thing" in error
    assert main([], VALID_ENVIRONMENT, []) == 2


def test_a_bad_environment_stops_a_command_before_it_runs(capsys: pytest.CaptureFixture[str]) -> None:
    """The command never starts when the settings are wrong, and the message names the variables."""
    status = main(["seed_thing"], {}, [system_with_command("seed_thing")])

    assert status == 1
    assert "FLASK_ALLOWED_HOSTS" in capsys.readouterr().err


def test_two_commands_of_one_name_are_refused() -> None:
    """A system can't silently replace another's command, or the platform's."""
    with pytest.raises(ValueError, match="defined twice"):
        all_commands([system_with_command("export_openapi")])


def test_export_openapi_writes_the_document_next_to_manage_py(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """The command writes openapi.json, sorted and indented as the drift test expects, and says where."""
    monkeypatch.setattr(cli, "SERVICE_DIRECTORY", tmp_path)

    status = main(["export_openapi"], VALID_ENVIRONMENT, [stand_in_system(SiteKey())])

    written = (tmp_path / "openapi.json").read_text(encoding="utf-8")
    assert status == 0
    assert written.startswith('{\n  "components"')
    assert written.endswith("}\n")
    assert str(tmp_path / "openapi.json") in capsys.readouterr().out


def test_export_openapi_takes_no_arguments(capsys: pytest.CaptureFixture[str]) -> None:
    """An argument is a mistake, not something to ignore."""
    assert main(["export_openapi", "--force"], VALID_ENVIRONMENT, []) == 2
    assert "takes no arguments" in capsys.readouterr().err
