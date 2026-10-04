"""The registry of systems: a new system joins the Flask monolith by adding one module.

A system is a `SystemModule`: its part number and schema, a function that builds its
API from the shared platform, and the commands it adds to `manage.py`. The list of
modules is in config/systems.py; nothing else in the app names a system.
"""

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from core.openapi import APIBlueprint
from core.platform import Platform

# A command run from `manage.py`: it gets its arguments and the platform, and returns the exit status.
type Command = Callable[[Sequence[str], Platform], int]


@dataclass(frozen=True)
class SystemRuntime:
    """A system built and ready to serve: its API, whether it can serve right now, and how to start its own work.

    `start` is for a system that works outside requests (LB-03 reads documents and sweeps on a loop of its own): the
    worker calls it as it boots, so that work does not wait for the first request to begin.
    """

    blueprint: APIBlueprint
    is_ready: Callable[[], bool]
    start: Callable[[], None] | None = None


@dataclass(frozen=True)
class SystemModule:
    """One system of the monolith.

    `key` is its part number (`lb-05`), `schema` its Postgres schema (`lb05`), which also
    names it in the readiness check. `build` makes its runtime from the platform, `commands`
    are the `manage.py` commands it brings, by name, and `migrations` is the folder of its
    Alembic migrations, which `manage.py migrate` runs on its schema.
    """

    key: str
    schema: str
    build: Callable[[Platform], SystemRuntime]
    commands: Mapping[str, Command] = field(default_factory=dict)
    migrations: Path | None = None
