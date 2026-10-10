"""Django settings for the Django systems, read from the environment.

Safe by default: debugging is off, the secret key, hosts and databases come only from
the environment (config/environment.py), and every response carries the security
headers from docs/SECURITY.md. There are no accounts, sessions or templates: the
service answers JSON to the site, and visitors are identified by signed tokens.
"""

import os
from pathlib import Path

from celery.schedules import crontab

from config.channel_layer import channel_layers
from config.environment import read_environment
from core.databases import system_databases

ENVIRONMENT = read_environment(os.environ)
# services/django-systems, the folder manage.py lives in.
BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = ENVIRONMENT.secret_key
DEBUG = ENVIRONMENT.debug
ALLOWED_HOSTS = list(ENVIRONMENT.allowed_hosts)

INSTALLED_APPS = [
    "django.contrib.postgres",
    "core",
    "lb01",
    "lb02",
    "lb09",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "core.middleware.SecurityHeadersMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"
ASGI_APPLICATION = "config.asgi.application"

# Nothing may use `default`: every system names its own connection (core.databases).
DATABASES: dict[str, dict[str, object]] = {
    "default": {},
    **system_databases(
        ENVIRONMENT.database_url,
        {
            "lb01": ENVIRONMENT.lb01_database_url,
            "lb02": ENVIRONMENT.lb02_database_url,
            "lb09": ENVIRONMENT.lb09_database_url,
        },
    ),
}
DATABASE_ROUTERS = ["core.databases.SystemSchemaRouter"]
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

USE_TZ = True
TIME_ZONE = "UTC"
LANGUAGE_CODE = "en"
USE_I18N = False

# Headers Django sets itself; core.middleware adds the rest.
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "no-referrer"
SECURE_CROSS_ORIGIN_OPENER_POLICY = "same-origin"
X_FRAME_OPTIONS = "DENY"
# TLS ends at Cloudflare, and the proxy in front of the service passes the scheme on.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

# Tickets and chat messages are short. LB-09's recording is the one big body: up to 3 MiB of
# audio as base64 in a JSON object (lb09/limits.py), which is what this leaves room for.
DATA_UPLOAD_MAX_MEMORY_SIZE = 4_400_000

REDIS_URL = ENVIRONMENT.redis_url
REDIS_PREFIX = ENVIRONMENT.redis_prefix

# Channels (LB-02's WebSockets): the layer that carries the live calendar between
# connections lives in the same Redis, under the platform's key prefix. The prefix ends
# in a colon so that an ACL rule for `lb:channels:*` covers every key the layer writes.
# Its sockets must outwait the layer's own blocking read (config/channel_layer.py).
CHANNEL_LAYERS = channel_layers(REDIS_URL, f"{REDIS_PREFIX}channels:")

# Celery: Redis carries the queue under the platform's key prefix, messages are JSON
# only (never pickle), and nothing stores task results.
CELERY_BROKER_URL = REDIS_URL
CELERY_BROKER_TRANSPORT_OPTIONS = {"global_keyprefix": f"{REDIS_PREFIX}celery:"}
CELERY_TASK_SERIALIZER = "json"
CELERY_ACCEPT_CONTENT = ["json"]
CELERY_TASK_IGNORE_RESULT = True
CELERY_WORKER_PREFETCH_MULTIPLIER = 1
CELERY_TIMEZONE = "UTC"
CELERY_BEAT_SCHEDULE = {
    # Visitor data lives 24 hours (the LB-01 datasheet); the sweep keeps that promise.
    "lb01-sweep-expired-tickets": {"task": "lb01.sweep_expired_tickets", "schedule": 15 * 60},
    # A new day moves the orders' relative dates on.
    "lb01-reseed": {"task": "lb01.reseed", "schedule": crontab(hour=3, minute=7)},
    # A hold that ran out is already free for everyone (LB-02 reads expiry when it
    # checks, not when it sweeps); the sweep only tidies the rows and tells the live
    # calendar.
    "lb02-sweep-expired-holds": {"task": "lb02.sweep_expired_holds", "schedule": 60},
    # Visitor data lives 24 hours (the LB-02 datasheet keeps the LB-01 promise).
    "lb02-sweep-expired-conversations": {"task": "lb02.sweep_expired_conversations", "schedule": 15 * 60},
    # The demo calendar starts afresh every night, counted from the new day.
    "lb02-reset-calendar": {"task": "lb02.reset_calendar", "schedule": crontab(hour=3, minute=11)},
    # Visitor data lives 24 hours (the LB-09 datasheet); a meeting the worker lost is given up on after
    # ten minutes, and an audio file a crash left behind is removed after an hour.
    "lb09-sweep": {"task": "lb09.sweep", "schedule": 5 * 60},
}

# The synthetic data the seed commands load: one folder per system, such as data/seed/lb01.
SEED_DIR = Path(ENVIRONMENT.seed_dir) if ENVIRONMENT.seed_dir else BASE_DIR.parents[1] / "data" / "seed"
# The site's Ed25519 public key, which visitor tokens must be signed with (core/visitors.py).
WEB_TOKEN_KEY = ENVIRONMENT.web_token_key
# LB-09: where recordings wait for the worker, and where the private transcriber's weights are (lb09/storage.py,
# lb09/transcribers.py). Either may be unset: see config/environment.py.
LB09_AUDIO_DIR = ENVIRONMENT.lb09_audio_dir
LB09_WHISPER_DIR = ENVIRONMENT.lb09_whisper_dir

# The golden sets the evals grade against, such as evals/lb01/golden.yaml. They are read
# in development and CI only, never by the deployed service.
EVALS_DIR = BASE_DIR.parents[1] / "evals"

# Logs go to the console as plain lines. Request bodies never reach them.
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "root": {"handlers": ["console"], "level": "INFO"},
}
