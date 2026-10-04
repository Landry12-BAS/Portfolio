"""The environment variables the Flask systems read, checked once when the app starts.

A missing or malformed variable stops the service at startup with one message naming
every problem, instead of failing later on the first request. Messages name variables,
never their values, so a secret can't reach a log this way.
"""

import re
from collections.abc import Mapping
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError, field_validator, model_validator

from lb_common.gateway import check_gateway_url
from lb_common.tokens import check_service_name
from lb_common.visitors import load_public_key

# The gateway's rule for LB_REDIS_PREFIX, so spans written here land beside its own.
REDIS_PREFIX = re.compile(r"[a-z0-9-]{1,24}:")
# A DuckDB memory limit as this service accepts it: a whole number of megabytes or gigabytes.
MEMORY_LIMIT = re.compile(r"[1-9][0-9]{0,3}(?:MB|GB)")
# An S3 bucket name, an S3 endpoint (a scheme and a host, with an optional port, and no path), and a region.
BUCKET_NAME = re.compile(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]")
S3_ENDPOINT = re.compile(r"https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?|http://(?:127\.0\.0\.1|localhost)(?::[0-9]{1,5})?")
S3_REGION = re.compile(r"[a-z0-9-]{1,32}")

# Each variable, and the field it fills.
VARIABLES = {
    "FLASK_ALLOWED_HOSTS": "allowed_hosts",
    "LB_DATABASE_URL": "database_url",
    "LB05_DATABASE_URL": "lb05_database_url",
    "LB_REDIS_URL": "redis_url",
    "LB_REDIS_PREFIX": "redis_prefix",
    "LB_SEED_DIR": "seed_dir",
    "LB_WEB_TOKEN_KEY": "web_token_key",
    "LB_GATEWAY_URL": "gateway_url",
    "LB_SERVICE_NAME": "service_name",
    "LB_SERVICE_KEY_FILE": "service_key_file",
    "LB05_WAREHOUSE_DIR": "lb05_warehouse_dir",
    "LB05_DUCKDB_MEMORY_LIMIT": "duckdb_memory_limit",
    "LB05_DUCKDB_THREADS": "duckdb_threads",
    "LB03_DATABASE_URL": "lb03_database_url",
    "LB03_STORAGE": "lb03_storage",
    "LB03_FILES_DIR": "lb03_files_dir",
    "LB03_S3_BUCKET": "lb03_s3_bucket",
    "LB03_S3_ENDPOINT": "lb03_s3_endpoint",
    "LB03_S3_REGION": "lb03_s3_region",
    "LB03_S3_ACCESS_KEY_ID": "lb03_s3_access_key_id",
    "LB03_S3_SECRET_ACCESS_KEY": "lb03_s3_secret_access_key",
    "LB03_OCR_WORKERS": "lb03_ocr_workers",
    "LB03_SCRATCH_DIR": "lb03_scratch_dir",
    "LB03_REQUIRE_LANDLOCK": "lb03_require_landlock",
}
# The three variables that together say how to call the AI gateway.
GATEWAY_FIELDS = ("gateway_url", "service_name", "service_key_file")


class ConfigurationError(Exception):
    """The environment is missing something or holds something malformed; the message lists every problem."""


class Environment(BaseModel):
    """The service's settings, as its environment gives them.

    `lb05_database_url` is optional: in production it logs LB-05 in as a role granted
    only the lb05 schema; without it, LB-05 uses the shared `database_url`. `seed_dir` is
    where the synthetic data files live, and `lb05_warehouse_dir` where `just seed-lb05`
    writes the generated sales data; without them, the repository's data/seed and
    data/generated/lb05. `web_token_key` is the site's Ed25519 public key, which visitor
    tokens are checked against; without it, every visitor call is refused. The gateway
    settings are all or nothing: without them the service runs, but cannot answer a
    question. The DuckDB limits cap what one query may use on the machine.

    LB-03's settings follow the same pattern. `lb03_database_url` is its own role's login, as LB-05's is.
    `lb03_storage` says where uploaded files are kept: `local` (a folder, `lb03_files_dir`, by default
    data/generated/lb03/files) or `s3` (a bucket on any S3-compatible service, such as Cloudflare R2, with
    the bucket, its endpoint, region and an access key pair, all of which are then required; the secret
    is held as a secret, so it can't be printed by accident). `lb03_ocr_workers` is how many OCR
    processes may run at once, and `lb03_scratch_dir` is where each one gets its own folder to work in
    (the system's temporary folder by default; the stack gives it a small memory-backed one).
    `lb03_require_landlock` makes the worker refuse every document on a kernel (or a container) that has no
    Landlock, instead of reading it in a cage with one wall less: off until the owner has seen on the box,
    in a document's trace, that its Landlock is there (docs/DEPLOY.md).
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    allowed_hosts: tuple[str, ...] = Field(min_length=1)
    database_url: str
    lb05_database_url: str | None = None
    redis_url: str
    redis_prefix: str = "lb:"
    seed_dir: str | None = None
    web_token_key: str | None = None
    gateway_url: str | None = None
    service_name: str | None = None
    service_key_file: str | None = None
    lb05_warehouse_dir: str | None = None
    duckdb_memory_limit: str = "1GB"
    duckdb_threads: int = Field(default=2, ge=1, le=8)
    lb03_database_url: str | None = None
    lb03_storage: Literal["local", "s3"] = "local"
    lb03_files_dir: str | None = None
    lb03_s3_bucket: str | None = None
    lb03_s3_endpoint: str | None = None
    lb03_s3_region: str = "auto"
    lb03_s3_access_key_id: str | None = None
    lb03_s3_secret_access_key: SecretStr | None = None
    lb03_ocr_workers: int = Field(default=1, ge=1, le=4)
    lb03_scratch_dir: str | None = None
    lb03_require_landlock: bool = False

    @field_validator("database_url", "lb05_database_url", "lb03_database_url")
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

    @field_validator("web_token_key")
    @classmethod
    def _check_web_token_key(cls, key: str | None) -> str | None:
        """Accept only a base64url Ed25519 public key."""
        if key is not None:
            load_public_key(key)
        return key

    @field_validator("gateway_url")
    @classmethod
    def _check_gateway_url(cls, url: str | None) -> str | None:
        """Accept only a gateway URL that service tokens may safely be sent to."""
        return check_gateway_url(url) if url is not None else None

    @field_validator("service_name")
    @classmethod
    def _check_service_name(cls, name: str | None) -> str | None:
        """Accept only a well-formed service name, such as `flask-systems`."""
        if name is None:
            return None
        try:
            return check_service_name(name)
        except ValueError:
            # lb_common's message quotes the name; this one doesn't, as no message here repeats a value.
            raise ValueError("must be lowercase letters, digits and hyphens, such as flask-systems") from None

    @field_validator("duckdb_memory_limit")
    @classmethod
    def _check_memory_limit(cls, limit: str) -> str:
        """Accept only a whole number of megabytes or gigabytes, such as `1GB`."""
        if not MEMORY_LIMIT.fullmatch(limit):
            raise ValueError("must be a whole number of MB or GB, such as 1GB")
        return limit

    @field_validator("lb03_s3_bucket")
    @classmethod
    def _check_bucket_name(cls, name: str | None) -> str | None:
        """Accept only a bucket name as S3 allows it: lowercase letters, digits, dots and hyphens, 3 to 63 long."""
        if name is not None and not BUCKET_NAME.fullmatch(name):
            raise ValueError("must be a bucket name: 3 to 63 lowercase letters, digits, dots or hyphens")
        return name

    @field_validator("lb03_s3_endpoint")
    @classmethod
    def _check_s3_endpoint(cls, endpoint: str | None) -> str | None:
        """Accept an https:// endpoint, or plain http:// only for a server on this machine, with no path."""
        if endpoint is not None and not S3_ENDPOINT.fullmatch(endpoint):
            raise ValueError("must be an https:// URL (http:// only for localhost or 127.0.0.1) with no path")
        return endpoint

    @field_validator("lb03_s3_region")
    @classmethod
    def _check_s3_region(cls, region: str) -> str:
        """Accept a region name such as `auto` or `eu-central-1`."""
        if not S3_REGION.fullmatch(region):
            raise ValueError("must be a region name such as auto or eu-central-1")
        return region

    @model_validator(mode="after")
    def _check_storage_is_complete(self) -> Self:
        """Require the bucket, the endpoint-or-AWS region and both halves of the key when files are kept in S3."""
        if self.lb03_storage != "s3":
            return self
        missing = [
            variable_for(name)
            for name in ("lb03_s3_bucket", "lb03_s3_access_key_id", "lb03_s3_secret_access_key")
            if getattr(self, name) is None
        ]
        if missing:
            raise ValueError("LB03_STORAGE=s3 also needs " + ", ".join(missing))
        return self

    @model_validator(mode="after")
    def _check_gateway_is_complete(self) -> Self:
        """Require the gateway's URL, service name and key file together, or none of them."""
        given = [getattr(self, name) is not None for name in GATEWAY_FIELDS]
        if any(given) and not all(given):
            raise ValueError("LB_GATEWAY_URL, LB_SERVICE_NAME and LB_SERVICE_KEY_FILE must be set together")
        return self

    def database_url_for(self, schema: str) -> str:
        """Return the URL a system's engine connects with: its own role's when it has one, else the shared one."""
        own = {"lb05": self.lb05_database_url, "lb03": self.lb03_database_url}.get(schema)
        return own or self.database_url

    def gateway_is_configured(self) -> bool:
        """Tell whether the service has everything it needs to call the AI gateway."""
        return self.gateway_url is not None


def variable_for(field: str) -> str:
    """Return the environment variable that fills a field, for error messages."""
    for variable, name in VARIABLES.items():
        if name == field:
            return variable
    return field


def split_hosts(value: str) -> tuple[str, ...]:
    """Split a comma-separated list of host names, dropping blanks."""
    return tuple(host.strip() for host in value.split(",") if host.strip())


def describe_problem(location: tuple[str | int, ...], message: str) -> str:
    """Write one validation problem as a variable name and a reason, never the value that failed."""
    if not location:
        return message.removeprefix("Value error, ")
    return f"{variable_for(str(location[0]))}: {message.removeprefix('Value error, ')}"


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
        problems = [describe_problem(tuple(issue["loc"]), issue["msg"]) for issue in error.errors()]
        raise ConfigurationError("Invalid environment:\n- " + "\n- ".join(problems)) from None
