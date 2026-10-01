"""LB-02's operating limits in one place: the datasheet's numbers, and the ones behind them.

The datasheet promises 30 messages a session, a 5-minute hold, a nightly calendar reset
and 6 to 10 model calls a booking. The rest of the numbers keep those promises, or keep
a hostile visitor from costing more than a friendly one. Models, the concierge, the
consumer and the tests all read them from here, and a test checks that the gateway's
quotas for LB-02 in routing.yaml leave room for them.
"""

from datetime import timedelta
from typing import Final

# The datasheet's limits.
MESSAGES_PER_SESSION: Final = 30
HOLD_DURATION: Final = timedelta(minutes=5)
# The calendar opens tomorrow and runs this many days: slots exist for days +1 to +14.
CALENDAR_DAYS_AHEAD: Final = 14

# A visitor's conversation, its data and its bookings are deleted after this long.
VISITOR_DATA_LIFETIME: Final = timedelta(hours=24)
# A visitor's message, in characters. A booking message is a sentence or two.
MAX_MESSAGE_LENGTH: Final = 500
# The most guests a single booking may have, whichever offering it is for.
MAX_PARTY_SIZE: Final = 12
# How many conversations one visitor may start in a day.
CONVERSATIONS_PER_VISITOR_PER_DAY: Final = 10

# Every gateway call a conversation makes counts: one injection check for each visitor
# message, the chat calls, and the language check when a first message is ambiguous. A
# typical booking takes 7 to 10 (docs/PLAYBOOK.md calls them model calls too); this is the
# most a conversation may spend before a person takes over. The gateway's own cap for
# LB-02 in routing.yaml sits a few calls above it, as a backstop that code never reaches.
MAX_MODEL_CALLS_PER_CONVERSATION: Final = 20
# Chat calls inside one visitor message: a tool call, its follow-up, and one spare.
MAX_CHAT_CALLS_PER_TURN: Final = 3
# Tool calls the concierge will run for one model reply.
MAX_TOOL_CALLS_PER_REPLY: Final = 3
# How many free slots a search offers at a time.
MAX_OPTIONS: Final = 6

# A conversation whose messages the injection screen flagged this many times, or whose
# turns failed this many times in a row, goes to a person.
INJECTION_STRIKES_BEFORE_HANDOFF: Final = 3
FAILURES_BEFORE_HANDOFF: Final = 2

# The WebSocket: how long a new connection has to present its token, and the largest
# frame it may send, in bytes.
HELLO_TIMEOUT_SECONDS: Final = 10.0
MAX_FRAME_BYTES: Final = 4_096
