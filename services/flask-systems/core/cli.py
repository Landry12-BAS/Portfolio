"""The commands of the Flask systems, run through `manage.py`: `python manage.py <command> [options]`.

Each system brings its own commands (such as `seed_lb05`), listed on its module; the
platform adds `export_openapi`. A command gets its arguments and the platform and returns
the process's exit status, so every command is a plain function a test can call.
"""

import sys
from collections.abc import Mapping, Sequence
from pathlib import Path

from config.environment import ConfigurationError, read_environment
from core.app import create_app, render_openapi
from core.platform import Platform, connect_platform
from core.registry import Command, SystemModule

# The folder manage.py lives in: services/flask-systems.
SERVICE_DIRECTORY = Path(__file__).resolve().parents[1]
OPENAPI_FILE = "openapi.json"


def write_line(text: str, *, error: bool = False) -> None:
    """Write one line to the command's standard output, or to standard error."""
    stream = sys.stderr if error else sys.stdout
    stream.write(text + "\n")


def platform_commands(systems: Sequence[SystemModule]) -> dict[str, Command]:
    """Return the commands every deployment has: `export_openapi` for the systems served."""

    def export_openapi(arguments: Sequence[str], platform: Platform) -> int:
        """Write the API's OpenAPI document to openapi.json, for the site's typed client."""
        if arguments:
            write_line("export_openapi takes no arguments.", error=True)
            return 2
        path = SERVICE_DIRECTORY / OPENAPI_FILE
        path.write_text(render_openapi(create_app(platform, systems)), encoding="utf-8")
        write_line(f"Wrote {path}.")
        return 0

    return {"export_openapi": export_openapi}


def all_commands(systems: Sequence[SystemModule]) -> dict[str, Command]:
    """Collect the platform's commands and every system's, refusing two commands of one name."""
    commands = platform_commands(systems)
    for module in systems:
        for name, command in module.commands.items():
            if name in commands:
                raise ValueError(f"The command {name!r} is defined twice.")
            commands[name] = command
    return commands


def main(argv: Sequence[str], environ: Mapping[str, str], systems: Sequence[SystemModule]) -> int:
    """Run the command named first in `argv` and return its exit status."""
    commands = all_commands(systems)
    if not argv or argv[0] not in commands:
        write_line("Usage: python manage.py <command> [options]", error=True)
        write_line("Commands: " + ", ".join(sorted(commands)), error=True)
        return 2
    try:
        platform = connect_platform(read_environment(environ))
    except ConfigurationError as error:
        write_line(str(error), error=True)
        return 1
    return commands[argv[0]](argv[1:], platform)
