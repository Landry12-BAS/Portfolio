"""The registry of systems: a new system joins the Flask monolith by adding one module.

A system is a `SystemModule`: its part number and schema, a function that builds its
API from the shared platform, and the commands it adds to `manage.py`. The list of
modules is in config/systems.py; nothing else in the app names a system.
"""

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field

from core.openapi import APIBlueprint
from core.platform import Platform

# A command run from `manage.py`: it gets its arguments and the platform, and returns the exit status.
type Command = Callable[[Sequence[str], Platform], int]


@dataclass(frozen=True)
class SystemRuntime:
    """A system built and ready to serve: its API, and whether it can serve right now."""

    blueprint: APIBlueprint
    is_ready: Callable[[], bool]


@dataclass(frozen=True)
class SystemModule:
    """One system of the monolith.

    `key` is its part number (`lb-05`), `schema` its Postgres schema (`lb05`), which also
    names it in the readiness check. `build` makes its runtime from the platform, and
    `commands` are the `manage.py` commands it brings, by name.
    """

    key: str
    schema: str
    build: Callable[[Platform], SystemRuntime]
    commands: Mapping[str, Command] = field(default_factory=dict)
