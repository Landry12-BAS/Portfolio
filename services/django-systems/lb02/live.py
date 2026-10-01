"""The live calendar: how a change to a slot reaches every conversation that is open.

Whoever holds, books or releases a slot, the booking service (lb02/booking.py) hands the
changes to a notifier once their transaction has committed. The notifier here sends them
to one Channels group, which every verified WebSocket connection has joined, through the
Redis channel layer. Each connection then tells its own visitor, from their point of view:
the slot they hold is theirs, and everyone else's is simply taken.

Telling the calendar is best effort. A booking that has been committed stays committed
when Redis is down; the next snapshot the page loads is right either way.
"""

import logging
from collections.abc import Sequence

from asgiref.sync import async_to_sync
from channels.exceptions import ChannelFull
from channels.layers import get_channel_layer
from redis.exceptions import RedisError

from lb02.booking import SlotChange

logger = logging.getLogger(__name__)

# The group every verified connection joins. Nothing joins it before its token has checked out.
CALENDAR_GROUP = "lb02.calendar"
# The event types the consumer handles; Channels finds the handler by turning the dot into an underscore.
CHANGED = "calendar.changed"
RESET = "calendar.reset"


def change_payload(change: SlotChange) -> dict[str, object]:
    """Describe one slot's new state in plain values, which is all the channel layer can carry."""
    return {
        "slot": change.slot_id,
        "offering": change.offering,
        "starts_at": change.starts_at.isoformat(),
        "ends_at": change.ends_at.isoformat(),
        "status": change.state.status,
        "owner": change.state.owner,
        "until": change.state.until.isoformat() if change.state.until is not None else None,
    }


def broadcast(event: dict[str, object]) -> None:
    """Send an event to every connection that has joined the calendar group, and never raise."""
    layer = get_channel_layer()
    if layer is None:
        return
    try:
        async_to_sync(layer.group_send)(CALENDAR_GROUP, event)
    except (RedisError, ChannelFull, OSError, TimeoutError):
        logger.warning("The live calendar could not be told about %s.", event.get("type"), exc_info=True)


class ChannelLayerNotifier:
    """Tells every open conversation about the slots that changed, through the channel layer."""

    def slots_changed(self, changes: Sequence[SlotChange]) -> None:
        """Broadcast the changes."""
        broadcast({"type": CHANGED, "changes": [change_payload(change) for change in changes]})


def announce_reset() -> None:
    """Tell every open conversation that the calendar was laid out afresh, so each reloads its snapshot."""
    broadcast({"type": RESET})
