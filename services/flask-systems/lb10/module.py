"""LB-10 as a module of the Flask monolith: its API, commands and migrations, registered in config/systems.py."""

from pathlib import Path

from core.platform import Platform
from core.registry import SystemModule, SystemRuntime
from lb10.api import SYSTEM_KEY, build_blueprint
from lb10.commands import sweep_lb10
from lb10.service import build_service

# LB-10's Alembic migrations.
MIGRATIONS = Path(__file__).resolve().parent / "migrations"


def build_runtime(platform: Platform) -> SystemRuntime:
    """Build LB-10's runtime: its service (or none, when a pack can't be read) behind its API, and its readiness."""
    service = build_service(platform)
    return SystemRuntime(
        blueprint=build_blueprint(service, platform.environment.web_token_key),
        is_ready=service.is_ready if service is not None else lambda: False,
        start=service.start if service is not None else None,
    )


LB10 = SystemModule(
    key=SYSTEM_KEY,
    schema="lb10",
    build=build_runtime,
    commands={"sweep_lb10": sweep_lb10},
    migrations=MIGRATIONS,
)
