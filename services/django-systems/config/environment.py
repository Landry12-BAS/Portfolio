"""The environment variables the Django systems read, checked once when settings load.

A missing or malformed variable stops the service at startup with one message naming
every problem, instead of failing later on the first request. Messages name variables,
never their values, so a secret can't reach a log this way.
"""

import re
from collections.abc import Mapping

from django.core.exceptions import ImproperlyConfigured
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

# The gateway's rule for LB_REDIS_PREFIX, so spans written here land beside its own.
REDIS_PREFIX = re.compile(r"[a-z0-9-]{1,24}:")

# Each variable, and the setting it fills.
VARIABLES = {
    "DJANGO_SECRET_KEY": "secret_key",
    "DJANGO_DEBUG": "debug",
    "DJANGO_ALLOWED_HOSTS": "allowed_hosts",
    "LB_DATABASE_URL": "database_url",
    "LB01_DATABASE_URL": "lb01_database_url",
    "LB_REDIS_URL": "redis_url",
    "LB_REDIS_PREFIX": "redis_prefix",
    "LB_SEED_DIR": "seed_dir",
}


class Environment(BaseModel):
    """The service's settings, as its environment gives them.

    `lb01_database_url` is optional: in production it logs LB-01 in as a role granted
    only the lb01 schema; without it, LB-01 uses the shared `database_url`. `seed_dir`
    is where the synthetic data lives; without it, the repository's data/seed.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    secret_key: str = Field(min_length=50)
    debug: bool = False
    allowed_hosts: tuple[str, ...] = Field(min_length=1)
    database_url: str
    lb01_database_url: str | None = None
    redis_url: str
    redis_prefix: str = "lb:"
    seed_dir: str | None = None

    @field_validator("database_url", "lb01_database_url")
    @classmethod
    def _check_database_url(cls, url: str | None) -> str | None:
        """Accept only Postgres URLs."""
        if url is not None and not url.startswith(("postgres://", "postgresql://")):
            raise ValueError("must be a postgres:// URL")
        return url

    @field_validator("redis_url")
    @classmethod
    def _check_redis_url(cls, url: str) -> str:
        """Accept only Redis URLs."""
        if not url.startswith(("redis://", "rediss://")):
            raise ValueError("must be a redis:// or rediss:// URL")
        return url

    @field_validator("redis_prefix")
    @classmethod
    def _check_redis_prefix(cls, prefix: str) -> str:
        """Accept the gateway's prefix format, such as `lb:`."""
        if not REDIS_PREFIX.fullmatch(prefix):
            raise ValueError("must be lowercase letters, digits and hyphens, ending in a colon")
        return prefix


def variable_for(field: str) -> str:
    """Return the environment variable that fills a setting, for error messages."""
    for variable, name in VARIABLES.items():
        if name == field:
            return variable
    return field


def split_hosts(value: str) -> tuple[str, ...]:
    """Split a comma-separated list of host names, dropping blanks."""
    return tuple(host.strip() for host in value.split(",") if host.strip())


def read_environment(environ: Mapping[str, str]) -> Environment:
    """Read and check the service's variables, raising one error that lists every problem."""
    values: dict[str, object] = {}
    for variable, field in VARIABLES.items():
        raw = environ.get(variable, "").strip()
        if raw:
            values[field] = split_hosts(raw) if field == "allowed_hosts" else raw
    try:
        return Environment.model_validate(values)
    except ValidationError as error:
        problems = [f"{variable_for(str(issue['loc'][0]))}: {issue['msg']}" for issue in error.errors()]
        raise ImproperlyConfigured("Invalid environment:\n- " + "\n- ".join(problems)) from None
