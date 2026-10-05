"""The systems the Flask monolith serves. A new system joins by adding its module to this list."""

from core.registry import SystemModule
from lb03.module import LB03
from lb05.module import LB05
from lb10.module import LB10

SYSTEMS: tuple[SystemModule, ...] = (LB05, LB03, LB10)
