"""Fixtures for the integration tests: one real Redis for the session, and a key prefix per test.

Integration tests run against a real Redis, because run spans are Redis streams that a
fake would only imitate. LB_TEST_REDIS_URL points at a running server (CI starts one);
without it, Testcontainers starts one in Docker. Each test writes under a prefix of its
own and removes its keys afterwards, so tests never share state.
"""

import os
import secrets
from collections.abc import Callable, Iterator

import pytest
from redis import Redis

from lb_common.tracing import Span

# The Redis version the gateway's integration tests use too.
REDIS_IMAGE = "redis:8.10-alpine"


@pytest.fixture(scope="session")
def redis_url() -> Iterator[str]:
    """Provide the URL of a real Redis: LB_TEST_REDIS_URL when set, otherwise a container."""
    external = os.environ.get("LB_TEST_REDIS_URL")
    if external:
        yield external
        return
    # Imported here, so runs with LB_TEST_REDIS_URL never need Docker.
    from testcontainers.community.redis import RedisContainer

    with RedisContainer(REDIS_IMAGE) as container:
        yield f"redis://{container.get_container_host_ip()}:{container.get_exposed_port(6379)}"


@pytest.fixture
def prefix() -> str:
    """Make a key prefix for one test, in the gateway's format (such as `lbtest-1a2b3c4d5e6f:`)."""
    return f"lbtest-{secrets.token_hex(6)}:"


@pytest.fixture
def redis(redis_url: str, prefix: str) -> Iterator[Redis]:
    """Connect to the test Redis, and remove the test's keys when it ends."""
    client = Redis.from_url(redis_url, decode_responses=True)
    yield client
    keys = list(client.scan_iter(match=f"{prefix}*"))
    if keys:
        client.delete(*keys)
    client.close()


@pytest.fixture
def read_spans(redis: Redis) -> Callable[[str], list[Span]]:
    """Return a reader for the spans in one Redis stream, oldest first."""

    def read(key: str) -> list[Span]:
        """Read and validate every span in the stream at `key`."""
        entries = redis.xrange(key) or []
        return [Span.model_validate_json(fields["span"]) for _, fields in entries if fields]

    return read
