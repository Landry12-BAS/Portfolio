"""What the systems of the Flask monolith share while they run: settings, the database, models and spans.

A `Platform` is built once per process (`connect_platform`), after gunicorn has forked
the worker, and handed to each system's module. Tests build one by hand with fakes for
the gateway and the span store, so no test calls a provider or needs one.
"""

import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from redis import Redis
from sqlalchemy import Engine

from config.environment import ConfigurationError, Environment
from core.databases import system_engines
from core.structured import ChatModels, GatewayChat, GatewayGuard, InjectionGuard
from lb_common.gateway import Gateway, GatewaySettings
from lb_common.tokens import ServiceKeyError, ServiceTokens, load_service_key
from lb_common.tracing import RedisSpanWriter, SpanWriter, Tracer

logger = logging.getLogger(__name__)

# How long a Redis call may take, so a stalled Redis can't hold a request: spans are best-effort.
REDIS_TIMEOUT_SECONDS = 2.0
# The repository root, where data/seed and data/generated live; this file is services/flask-systems/core/platform.py.
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


def utc_now() -> datetime:
    """Return the current time, timezone-aware, in UTC: the clock every system counts days by."""
    return datetime.now(UTC)


@dataclass(frozen=True)
class Platform:
    """The shared parts a system is built from.

    `chat` is None when the service has no gateway settings: it then runs without being
    able to answer, and says so. `engines` holds one SQLAlchemy engine per system schema.
    """

    environment: Environment
    engines: Mapping[str, Engine]
    chat: ChatModels | None
    tracer: Tracer
    clock: Callable[[], datetime] = utc_now
    # The gateway's prompt-injection check, for the systems that read documents; None without a gateway.
    guard: InjectionGuard | None = None
    # Where finished spans go, for a system that records its own on a thread of its own (LB-03's queue); None in tests.
    span_writer: SpanWriter | None = None

    def seed_directory(self) -> Path:
        """Return where the synthetic data files live: LB_SEED_DIR, else the repository's data/seed."""
        configured = self.environment.seed_dir
        return Path(configured) if configured else REPOSITORY_ROOT / "data" / "seed"


def connect_gateway(environment: Environment) -> Gateway | None:
    """Connect to the AI gateway the environment describes, or return None when it describes none.

    A half-described gateway is refused at startup (config.environment); a key file that
    is missing or open to other users is refused here, naming the file and never its content.
    """
    if environment.gateway_url is None or environment.service_name is None or environment.service_key_file is None:
        return None
    settings = GatewaySettings(
        url=environment.gateway_url,
        service=environment.service_name,
        key_file=Path(environment.service_key_file),
    )
    try:
        tokens = ServiceTokens(settings.service, load_service_key(settings.key_file))
    except ServiceKeyError as error:
        raise ConfigurationError(f"The gateway service key can't be used: {error}") from None
    return Gateway(settings, tokens)


def close_platform(platform: Platform) -> None:
    """Close what a finished command opened: every engine's pooled connections, so none is left to be dropped."""
    for engine in platform.engines.values():
        engine.dispose()


def connect_platform(environment: Environment) -> Platform:
    """Build the platform the running service uses: engines, the gateway if configured, and spans to Redis."""
    gateway = connect_gateway(environment)
    if gateway is None:
        logger.warning("No gateway settings: the service runs, but cannot answer questions.")
    redis = Redis.from_url(
        environment.redis_url, socket_timeout=REDIS_TIMEOUT_SECONDS, socket_connect_timeout=REDIS_TIMEOUT_SECONDS
    )
    span_writer = RedisSpanWriter(redis, prefix=environment.redis_prefix)
    tracer = Tracer(span_writer)
    engines = system_engines(environment.database_url, {"lb05": environment.lb05_database_url})
    return Platform(
        environment=environment,
        engines=engines,
        chat=GatewayChat(gateway) if gateway is not None else None,
        tracer=tracer,
        guard=GatewayGuard(gateway) if gateway is not None else None,
        span_writer=span_writer,
    )
