"""Django settings for the Django systems, read from the environment.

Safe by default: debugging is off, the secret key, hosts and databases come only from
the environment (config/environment.py), and every response carries the security
headers from docs/SECURITY.md. There are no accounts, sessions or templates: the
service answers JSON to the site, and visitors are identified by signed tokens.
"""

import os
from pathlib import Path

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
    **system_databases(ENVIRONMENT.database_url, {"lb01": ENVIRONMENT.lb01_database_url}),
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

# Tickets are short; nothing the API accepts comes near this.
DATA_UPLOAD_MAX_MEMORY_SIZE = 65_536

REDIS_URL = ENVIRONMENT.redis_url
REDIS_PREFIX = ENVIRONMENT.redis_prefix

# The synthetic data the seed commands load: one folder per system, such as data/seed/lb01.
SEED_DIR = Path(ENVIRONMENT.seed_dir) if ENVIRONMENT.seed_dir else BASE_DIR.parents[1] / "data" / "seed"
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
