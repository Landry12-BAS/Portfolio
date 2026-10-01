"""Run a command of the Flask systems: `python manage.py <command> [options]`.

Settings come from the environment (see .env.example); `just seed-lb05`, `just eval-lb05`
and `just openapi-flask` call this with the right file.
"""

import os
import sys

from config.systems import SYSTEMS
from core.cli import main

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:], os.environ, SYSTEMS))
