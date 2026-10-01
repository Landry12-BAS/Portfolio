"""Settings for the tests: the production settings, with test values for the deploy's secrets.

The database address is a placeholder: tests/conftest.py points every system at the test
Postgres (LB_TEST_DATABASE_URL, or a Testcontainers one) before any test database is made.
"""

import os

os.environ.setdefault("DJANGO_SECRET_KEY", "test-only-secret-" + "x" * 48)
os.environ.setdefault("DJANGO_ALLOWED_HOSTS", "testserver")
os.environ.setdefault("LB_DATABASE_URL", "postgres://lb:lb@127.0.0.1:5432/lb")
os.environ.setdefault("LB_REDIS_URL", "redis://127.0.0.1:6379/0")

# The production settings, star-imported the way Django settings modules extend each other.
from config.settings import *  # noqa: F403

# Tests use the in-memory channel layer, so none of them needs a Redis by accident. The
# ones that are about the real layer ask for it (tests/conftest.py, `redis_channel_layer`).
CHANNEL_LAYERS = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}
