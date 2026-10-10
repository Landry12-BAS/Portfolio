"""How a meeting's progress reaches the page: the row says where the worker is, and the channel layer says it live.

The worker records every stage it reaches on the meeting's row (which `GET /api/lb09/meetings/{id}` reads,
the polling fallback) and then tells the meeting's Channels group, which every open WebSocket of that meeting
has joined. Telling the group is best effort: if Redis is down the row is still right, and the next poll
shows it. The event carries only the state, never the words of the meeting.
"""

import logging

from asgiref.sync import async_to_sync
from channels.exceptions import ChannelFull
from channels.layers import get_channel_layer
from django.utils import timezone
from redis.exceptions import RedisError

from lb09.events import state_of
from lb09.models import Meeting

logger = logging.getLogger(__name__)

# The event type the consumer handles; Channels finds the handler by turning the dot into an underscore.
PROGRESS = "meeting.progress"


def meeting_group(public_id: str) -> str:
    """Name the group of the open connections of one meeting; a public ID is made of URL-safe characters."""
    return f"lb09.meeting.{public_id}"


def record_stage(meeting: Meeting, stage: str, **fields: object) -> None:
    """Save the stage the worker reached, with any other fields that changed, and tell the meeting's group."""
    meeting.stage = stage
    for name, value in fields.items():
        setattr(meeting, name, value)
    meeting.updated_at = timezone.now()
    meeting.save(update_fields=["stage", "updated_at", *fields])
    announce(meeting)


def announce(meeting: Meeting) -> None:
    """Send the meeting's state to its group, and never raise."""
    layer = get_channel_layer()
    if layer is None:
        return
    payload = state_of(meeting).model_dump(mode="json")
    try:
        async_to_sync(layer.group_send)(meeting_group(meeting.public_id), {"type": PROGRESS, "state": payload})
    except (RedisError, ChannelFull, OSError) as error:
        logger.warning(
            "The progress of meeting %s could not be announced: %s.", meeting.public_id, type(error).__name__
        )
