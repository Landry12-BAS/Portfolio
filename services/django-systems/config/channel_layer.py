"""The Channels layer's Redis settings, built in one place so production and the tests use the same ones.

The layer carries LB-02's live calendar between connections. How its sockets time out is
easy to get subtly wrong, and wrong looks like a WebSocket that closes by itself every few
seconds, so the numbers live here with their reasons and a test proves them against a real
Redis.
"""

from typing import Final

from channels_redis.core import RedisChannelLayer

# How long the layer waits on Redis for a message, per round. An idle WebSocket spends its
# whole life in this wait: channels-redis asks Redis to hold the request open (BZPOPMIN) for
# this many seconds, and asks again when Redis answers "nothing yet".
BLOCK_SECONDS: Final[float] = RedisChannelLayer.brpop_timeout

# How long a Redis socket may wait for an answer before it gives up.
#
# It has to be longer than the wait above. redis-py's own default is five seconds, which is
# exactly the layer's block: the socket's deadline and Redis's "nothing yet" answer arrive
# at the same instant, the deadline wins about as often as not, and the idle connection
# dies with a TimeoutError, which a visitor sees as a WebSocket closing by itself roughly
# every five seconds. Three blocks keeps the deadline well clear of the normal answer and
# leaves two whole blocks of slack for a slow Redis or a busy event loop, while a Redis
# that really has stopped answering is still reported after fifteen seconds.
SOCKET_TIMEOUT_SECONDS: Final[float] = 3 * BLOCK_SECONDS


def channel_layers(redis_url: str, prefix: str) -> dict[str, dict[str, object]]:
    """Describe the channel layer on Redis: where it is, which keys it may write, and when its sockets give up.

    `prefix` ends in a colon, so an ACL rule for `<prefix>*` covers every key the layer writes.
    """
    return {
        "default": {
            "BACKEND": "channels_redis.core.RedisChannelLayer",
            "CONFIG": {
                "hosts": [{"address": redis_url, "socket_timeout": SOCKET_TIMEOUT_SECONDS}],
                "prefix": prefix,
            },
        },
    }
