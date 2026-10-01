"""The WSGI entry point gunicorn serves: `gunicorn --config gunicorn.conf.py wsgi:app`.

The app is built when a worker boots, after gunicorn has forked it (the config never
preloads the app), so every worker owns its database connections and its DuckDB. A bad
environment stops the worker at boot with one message naming every problem.
"""

import os

from config.environment import read_environment
from config.systems import SYSTEMS
from core.app import create_app
from core.platform import connect_platform

app = create_app(connect_platform(read_environment(os.environ)), SYSTEMS)
