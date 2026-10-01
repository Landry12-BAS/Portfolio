"""The booking state machine: where a conversation stands, and which tools the model may call there.

The datasheet's chain is detect language, collect details, check availability, hold the
slot, confirm, send the confirmation. A conversation's `step` follows from the facts, never
from what the model says: whether the details are complete, whether the conversation holds
a live slot, whether it has a booking, whether it has been handed to a person. So the model
can't move a conversation forward by claiming it is further along than it is.

Each step offers the model only the tools that make sense there, and the executor accepts
only those tools (lb02/tools.py). The one that matters most is `confirm_booking`: it is
offered when, and only when, the conversation holds a live slot, and it takes no slot
argument at all, so a model can't confirm a slot it never held, or one someone else holds.

    details ──────> availability ──────> hold ──────> done
        │                │                │
        └────────────────┴────────────────┴──────────> handoff

Detecting the language comes first in a conversation's life and is not a step of its own:
it happens on the first message, in code where it can (lb02/languages.py). Sending the
confirmation follows a confirm at once, inside the same turn, so a booking is never left
without one.
"""

from enum import StrEnum

from lb02.models import Conversation

Step = Conversation.Step


class Tool(StrEnum):
    """The tools the concierge's model can call: every one takes validated arguments (lb02/tools.py)."""

    UPDATE_DETAILS = "update_details"
    CHECK_AVAILABILITY = "check_availability"
    HOLD_SLOT = "hold_slot"
    CONFIRM_BOOKING = "confirm_booking"
    RELEASE_HOLD = "release_hold"
    HANDOFF_TO_PERSON = "handoff_to_person"


# What the model is told it can call at each step. Nothing is offered once the conversation
# is with a person, and once it is booked the only thing left is to hand over.
OFFERED: dict[str, tuple[Tool, ...]] = {
    Step.DETAILS: (Tool.UPDATE_DETAILS, Tool.HANDOFF_TO_PERSON),
    Step.AVAILABILITY: (Tool.UPDATE_DETAILS, Tool.CHECK_AVAILABILITY, Tool.HOLD_SLOT, Tool.HANDOFF_TO_PERSON),
    Step.HOLD: (
        Tool.CONFIRM_BOOKING,
        Tool.RELEASE_HOLD,
        Tool.HOLD_SLOT,
        Tool.CHECK_AVAILABILITY,
        Tool.UPDATE_DETAILS,
        Tool.HANDOFF_TO_PERSON,
    ),
    Step.DONE: (Tool.HANDOFF_TO_PERSON,),
    Step.HANDOFF: (),
}

# What the executor will run. It is what is offered, plus one replay: a second confirm
# after the booking is made returns the same booking instead of an error, so a model that
# calls the tool twice in one reply gets the same answer both times.
ACCEPTED: dict[str, tuple[Tool, ...]] = {
    **OFFERED,
    Step.DONE: (Tool.CONFIRM_BOOKING, Tool.HANDOFF_TO_PERSON),
}


def derive_step(*, details_complete: bool, has_live_hold: bool, has_booking: bool, handed_off: bool) -> str:
    """Work out where a conversation stands from the facts about it.

    A handoff ends the conversation, a booking finishes it, a live hold waits for the
    visitor's yes, complete details are ready for a search, and anything less is still
    collecting details.
    """
    if handed_off:
        return Step.HANDOFF
    if has_booking:
        return Step.DONE
    if has_live_hold:
        return Step.HOLD
    if details_complete:
        return Step.AVAILABILITY
    return Step.DETAILS


def tools_offered(step: str) -> tuple[Tool, ...]:
    """List the tools the model is told about at a step."""
    return OFFERED[step]


def tool_accepted(step: str, tool: Tool) -> bool:
    """Tell whether a tool call is allowed to run at a step."""
    return tool in ACCEPTED[step]
