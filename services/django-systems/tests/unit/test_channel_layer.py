"""Unit tests for the channel layer's Redis settings: the sockets must outwait the layer's blocking read."""

from channels_redis.core import RedisChannelLayer

from config import settings as production
from config.channel_layer import BLOCK_SECONDS, SOCKET_TIMEOUT_SECONDS, channel_layers


def config_of(layers: dict[str, dict[str, object]]) -> dict[str, object]:
    """Pick out the default layer's CONFIG, which the layer's class receives as keyword arguments."""
    config = layers["default"]["CONFIG"]
    assert isinstance(config, dict)
    return config


def host_of(layers: dict[str, dict[str, object]]) -> dict[str, object]:
    """Pick out the one Redis host the layer is configured with."""
    hosts = config_of(layers)["hosts"]
    assert isinstance(hosts, list)
    assert len(hosts) == 1
    host: dict[str, object] = hosts[0]
    return host


def test_the_block_is_the_one_the_installed_layer_really_uses() -> None:
    """Whatever channels-redis blocks for, the sockets are sized from it, so an upgrade can't leave them behind."""
    assert RedisChannelLayer.brpop_timeout == BLOCK_SECONDS


def test_the_socket_gives_up_only_after_two_whole_blocks_beyond_the_one_it_waits_on() -> None:
    """Equal to the block is the bug (an idle socket dies about every five seconds); three blocks is the fix."""
    assert SOCKET_TIMEOUT_SECONDS >= 3 * BLOCK_SECONDS


def test_the_layer_is_described_by_its_address_its_prefix_and_its_socket_timeout() -> None:
    """The address and the socket timeout travel together, because only a host written as a dict can carry options."""
    layers = channel_layers("redis://cache:6379/0", "lb:channels:")

    assert layers["default"]["BACKEND"] == "channels_redis.core.RedisChannelLayer"
    assert config_of(layers)["prefix"] == "lb:channels:"
    assert host_of(layers) == {"address": "redis://cache:6379/0", "socket_timeout": SOCKET_TIMEOUT_SECONDS}


def test_production_settings_build_the_layer_the_same_way() -> None:
    """The settings the deployed service runs on use the builder, not a copy of its numbers."""
    layers = production.CHANNEL_LAYERS

    assert host_of(layers) == {"address": production.REDIS_URL, "socket_timeout": SOCKET_TIMEOUT_SECONDS}
    assert config_of(layers)["prefix"] == f"{production.REDIS_PREFIX}channels:"
