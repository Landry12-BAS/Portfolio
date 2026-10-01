"""The systems the Flask monolith serves. A new system joins by adding its module to this list."""

from core.registry import SystemModule
from lb05.module import LB05

SYSTEMS: tuple[SystemModule, ...] = (LB05,)
