"""LB-05 as a module of the Flask monolith: its API, commands and migrations, registered in config/systems.py."""

from pathlib import Path

from core.platform import Platform
from core.registry import SystemModule, SystemRuntime
from lb05.api import SYSTEM_KEY, build_blueprint
from lb05.commands import eval_lb05, export_pack_lb05, seed_lb05, sweep_lb05
from lb05.service import build_service

# LB-05's Alembic migrations.
MIGRATIONS = Path(__file__).resolve().parent / "migrations"


def build_runtime(platform: Platform) -> SystemRuntime:
    """Build LB-05's runtime: its service (or none, when a part can't be built) behind its API, and its readiness."""
    service = build_service(platform)
    return SystemRuntime(
        blueprint=build_blueprint(service, platform.environment.web_token_key),
        is_ready=service.is_ready if service is not None else lambda: False,
    )


LB05 = SystemModule(
    key=SYSTEM_KEY,
    schema="lb05",
    build=build_runtime,
    commands={
        "seed_lb05": seed_lb05,
        "eval_lb05": eval_lb05,
        "sweep_lb05": sweep_lb05,
        "export_pack_lb05": export_pack_lb05,
    },
    migrations=MIGRATIONS,
)
