"""Helpers LB-02's tests share: calendar and conversation builders, a clock to move, a notifier to read."""

import itertools
import json
import threading
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta

from django.conf import settings
from django.db import connections
from django.db.backends.postgresql.psycopg_any import DateTimeTZRange

from core.tool_chat import ToolCall, ToolChatMessage, ToolDefinition, ToolReply
from lb02.booking import BookingService, SlotChange, local_day
from lb02.concierge import Concierge
from lb02.conversations import start_conversation
from lb02.models import ROASTERY_TIME_ZONE, Conversation, Offering, Reservation, Resource, Slot
from lb02.seed import seed
from lb02.tools import ToolOutcome, TurnContext
from lb_common.run import Run, current_run, run_scope
from lb_common.tracing import Tracer
from tests.support import FakeChat, FakeGateway, MemorySpanWriter

# A fixed morning, so every test counts its days from the same "today" (a Thursday, 11:00 in Prague).
START = datetime(2026, 10, 1, 9, 0, tzinfo=UTC)


class FakeClock:
    """A clock that stands still until it is moved: `advance` makes a hold run out without waiting."""

    def __init__(self, start: datetime = START) -> None:
        """Start at `start`, which is a timezone-aware moment."""
        self.now = start

    def __call__(self) -> datetime:
        """Return the clock's current moment."""
        return self.now

    def advance(self, minutes: float) -> None:
        """Move the clock forward."""
        self.now += timedelta(minutes=minutes)


@dataclass
class RecordingNotifier:
    """Remembers every announcement the booking service makes about the live calendar."""

    announcements: list[Sequence[SlotChange]] = field(default_factory=list)

    def slots_changed(self, changes: Sequence[SlotChange]) -> None:
        """Keep the changes."""
        self.announcements.append(list(changes))

    def changed_ids(self) -> set[int]:
        """Return the IDs of every slot that has been announced."""
        return {change.slot_id for changes in self.announcements for change in changes}


# How long a test waits for its threads before giving up, so a deadlock fails the test instead of hanging it.
PATIENCE_SECONDS = 20


def race[Outcome](jobs: list[Callable[[], Outcome]]) -> list[Outcome | Exception]:
    """Run every job in its own thread, all released at once, and return each job's result or the error it raised.

    A thread has a database connection of its own, so each job is a transaction of its own, and
    the tests that use this commit for real (`transaction=True`) so the jobs can see each other.
    """
    barrier = threading.Barrier(len(jobs))

    def run(job: Callable[[], Outcome]) -> Outcome | Exception:
        """Wait for the others, run the job on this thread's own connection, and close it afterwards."""
        try:
            barrier.wait(timeout=PATIENCE_SECONDS)
            return job()
        except Exception as error:  # noqa: BLE001 - the test reads each racer's error as its result
            return error
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        futures = [pool.submit(run, job) for job in jobs]
        return [future.result(timeout=PATIENCE_SECONDS) for future in futures]


def reload(conversation: Conversation) -> Conversation:
    """Read a conversation again from the database, with its offering."""
    return Conversation.objects.select_related("offering").get(pk=conversation.pk)


def make_room(key: str = "tasting-room") -> Resource:
    """Create a room."""
    return Resource.objects.create(key=key, name_en=key.title(), name_cs=key.title())


def make_offering(
    room: Resource, key: str = "tasting", minutes: int = 60, capacity: int = 6, position: int = 1
) -> Offering:
    """Create an offering that runs in a room."""
    return Offering.objects.create(
        resource=room,
        key=key,
        position=position,
        title_en=key.title(),
        title_cs=key.title(),
        summary_en="A session.",
        summary_cs="Setkání.",
        duration_minutes=minutes,
        capacity=capacity,
        price_czk=400,
    )


def make_slot(offering: Offering, starts_at: datetime) -> Slot:
    """Create a slot of an offering that starts at a moment and lasts as long as the offering does."""
    ends_at = starts_at + timedelta(minutes=offering.duration_minutes)
    slot = Slot.objects.create(offering=offering, during=DateTimeTZRange(starts_at, ends_at, "[)"))
    slot.offering = offering
    return slot


def make_conversation(
    offering: Offering | None = None,
    session: str = "session-of-jana-visitor-01",
    party_size: int | None = 2,
    guest_name: str = "Jana Novak",
    guest_email: str = "jana@example.test",
) -> Conversation:
    """Create a conversation whose details are all collected, ready to hold a slot."""
    return Conversation.objects.create(
        session_key=session,
        language="en",
        offering=offering,
        party_size=party_size,
        guest_name=guest_name,
        guest_email=guest_email,
    )


def tomorrow_at(clock: FakeClock, hour: int, minute: int = 0, days: int = 1) -> datetime:
    """Return a moment on the roastery's calendar: `days` after the clock's day, at a local hour (Prague time)."""
    day = local_day(clock()) + timedelta(days=days)
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=ROASTERY_TIME_ZONE)


def raw_reservation(conversation: Conversation, slot: Slot, status: str = "held", **fields: object) -> Reservation:
    """Insert a reservation straight into the table, as code that skipped the booking rules would."""
    values: dict[str, object] = {
        "slot": slot,
        "resource_id": slot.offering.resource_id,
        "during": slot.during,
        "conversation": conversation,
        "status": status,
        "party_size": 2,
        "guest_name": "Jana Novak",
        "hold_expires_at": slot.starts_at,
        "created_at": slot.starts_at - timedelta(days=1),
    }
    if status == "booked":
        values |= {"confirmed_at": slot.starts_at - timedelta(days=1), "idempotency_key": "raw"}
    return Reservation.objects.create(**{**values, **fields})


_call_numbers = itertools.count(1)


def call(tool_name: str, /, **arguments: object) -> ToolCall:
    """Make a tool call as a model would write it: a name, and its arguments as a JSON string.

    The tool's name is positional only, so an argument may be called `name` too, as a guest's is.
    """
    return ToolCall(id=f"call_{next(_call_numbers)}", name=tool_name, arguments=json.dumps(arguments))


def say(text: str) -> ToolReply:
    """Make a reply that is only words."""
    return ToolReply(text=text, calls=(), model="test/lb-tools")


def calling(*calls: ToolCall, text: str = "") -> ToolReply:
    """Make a reply that calls tools, perhaps with words alongside."""
    return ToolReply(text=text, calls=tuple(calls), model="test/lb-tools")


@dataclass
class ToolRequest:
    """One request to the chat model with tools: what was offered, what was read, and which run it belonged to."""

    alias: str
    messages: list[ToolChatMessage]
    offered: list[str]
    max_tokens: int
    run: Run | None

    def system(self) -> str:
        """Return the system message, with the rules and the State the model read."""
        return self.messages[0].content or ""

    def last(self) -> str:
        """Return the last message the model read: the visitor's, or after a tool call that tool's answer."""
        return self.messages[-1].content or ""


@dataclass
class ScriptedToolChat:
    """Stands in for the gateway's chat with tools: replies from a script, and remembers every request."""

    replies: list[ToolReply]
    requests: list[ToolRequest] = field(default_factory=list)
    fails_with: Exception | None = None

    def complete(
        self, alias: str, messages: Sequence[ToolChatMessage], tools: Sequence[ToolDefinition], max_tokens: int
    ) -> ToolReply:
        """Return the next scripted reply, or fail like the gateway; remember the request and the run it was made in."""
        self.requests.append(
            ToolRequest(alias, list(messages), [tool.name for tool in tools], max_tokens, current_run())
        )
        if self.fails_with is not None:
            raise self.fails_with
        return self.replies.pop(0)


@dataclass
class Rig:
    """A concierge on fakes, with everything a test wants to read back."""

    concierge: Concierge
    models: ScriptedToolChat
    guard: FakeGateway
    language_chat: FakeChat
    spans: MemorySpanWriter
    clock: FakeClock
    notifier: RecordingNotifier

    def conversation(self, session: str = "session-of-jana-visitor-01") -> Conversation:
        """Start a conversation for a visitor, the way the consumer does."""
        return start_conversation(session, self.clock())

    def run_tool(
        self, conversation: Conversation, tool_name: str, /, context: TurnContext | None = None, **arguments: object
    ) -> ToolOutcome:
        """Run one tool call as the model would write it, inside the conversation's run, as the concierge does."""
        run = Run(system="lb-02", run_id=conversation.run_id, data_class="visitor", session=conversation.session_key)
        with run_scope(run):
            return self.concierge.tools.run(conversation, call(tool_name, **arguments), context or TurnContext("en"))

    def give_details(
        self, conversation: Conversation, email: str = "jana@example.test", **details: object
    ) -> ToolOutcome:
        """Tell the concierge the details of a cupping for two tomorrow afternoon, except those `details` replace.

        The email is kept the way the concierge keeps it, by the code from the visitor's own message and not by a
        tool, so it is put on the conversation first; an empty `email` leaves it missing.
        """
        if email:
            conversation.guest_email = email
            conversation.save(update_fields=["guest_email"])
        given: dict[str, object] = {
            "offering": "cupping",
            "party_size": 2,
            "name": "Jana Novak",
            "date_from": "2026-10-02",
            "date_to": "2026-10-02",
            "part_of_day": "afternoon",
        }
        return self.run_tool(conversation, "update_details", **(given | details))


def build_rig(
    replies: Sequence[ToolReply] = (),
    *,
    flag_when: str | None = None,
    guard_fails: bool = False,
    language_replies: Sequence[str] = (),
    seeded: bool = True,
) -> Rig:
    """Build a concierge whose gateway is entirely fake, over a freshly seeded calendar.

    The clock stands on Thursday 1 October 2026, so the calendar's first day is Friday the
    2nd. Nothing here can reach a provider, so no test spends quota.
    """
    clock = FakeClock()
    notifier = RecordingNotifier()
    if seeded:
        seed(settings.SEED_DIR / "lb02", date(2026, 10, 1))
    models = ScriptedToolChat(list(replies))
    guard = FakeGateway(flag_when=flag_when, guard_fails=guard_fails)
    language_chat = FakeChat({"lb-fast": list(language_replies)})
    spans = MemorySpanWriter()
    concierge = Concierge(
        guard=guard,
        chat=language_chat,
        tool_chat=models,
        tracer=Tracer(spans),
        bookings=BookingService(clock=clock, notifier=notifier),
        clock=clock,
    )
    return Rig(concierge, models, guard, language_chat, spans, clock, notifier)
