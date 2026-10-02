"""LB-03 as a module of the Flask monolith: its API, commands and migrations, registered in config/systems.py."""

from core.platform import Platform
from core.registry import SystemModule, SystemRuntime
from lb03.api import SYSTEM_KEY, build_blueprint
from lb03.commands import eval_lb03, ocr_lb03, seed_lb03, sweep_lb03
from lb03.models import MIGRATIONS
from lb03.service import build_service


def build_runtime(platform: Platform) -> SystemRuntime:
    """Build LB-03's runtime: its service (or none, when a part can't be built) behind its API, and its readiness."""
    service = build_service(platform)
    return SystemRuntime(
        blueprint=build_blueprint(service, platform.environment.web_token_key),
        is_ready=service.is_ready if service is not None else lambda: False,
    )


LB03 = SystemModule(
    key=SYSTEM_KEY,
    schema="lb03",
    build=build_runtime,
    commands={"seed_lb03": seed_lb03, "ocr_lb03": ocr_lb03, "eval_lb03": eval_lb03, "sweep_lb03": sweep_lb03},
    migrations=MIGRATIONS,
)
