"""LB-02's concierge: one visitor message in, one reply out, with the booking rules around the model.

    visitor message -> mask -> detect language -> screen for injection -> (check language)
        -> keep the contact address -> refresh the slots on offer -> model with tools -> reply

A conversation is one run of LB-02, and each message is a span of it. Every model call goes
through the gateway, labelled with the conversation's run, so the run's quotas apply and the
Scope shows the whole story. A typical booking takes 7 to 10 gateway calls, counted from the
moment the visitor writes:

- every message costs an injection check (`lb-guard`);
- a message that needs a tool costs one `lb-tools` call to choose it and, unless the answer
  is a receipt the code writes itself (a hold, a confirmation), one more to write the reply;
- a first message the code can't tell the language of costs one `lb-fast` call.

The conversation is held to 30 visitor messages and 64 gateway calls in total, counted by the
database (lb02/conversations.py). A message the injection screen flags never reaches a model;
one it can't check is treated as unchecked, so the screen fails closed. Anything the concierge
can't carry on with, a person is handed the conversation, with the whole transcript.

The model is untrusted throughout. Its tools are gated by the state machine and validated
(lb02/tools.py), a hold made in a turn can't be confirmed in it, and its words are only ever
shown, never executed.
"""

import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, datetime
from functools import cache
from typing import Literal, Protocol

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from openai import OpenAIError
from redis import Redis

from core.structured import ChatMessage, ChatModels, Completion, GatewayChat, StructuredOutputError, ask_for_json
from core.tool_chat import GatewayToolChat, ToolChat, ToolChatMessage, ToolReply
from lb02.booking import DATABASE, BookingService, CalendarNotifier, Clock, bookable_days, local_day
from lb02.conversations import (
    language_of,
    record,
    spend_call,
    spend_message,
    sync_step,
    transcript_pairs,
)
from lb02.handoff import hand_over, refresh_transcript
from lb02.languages import Detection, detect
from lb02.limits import (
    FAILURES_BEFORE_HANDOFF,
    INJECTION_STRIKES_BEFORE_HANDOFF,
    MAX_CHAT_CALLS_PER_TURN,
    MAX_TOOL_CALLS_PER_REPLY,
    MESSAGES_PER_SESSION,
)
from lb02.live import ChannelLayerNotifier
from lb02.messages import Receipt, has_wording, render, typeset_czech, when_text
from lb02.models import Conversation, Handoff, Offering, Reservation
from lb02.privacy import MaskedMessage, mask, strip_control_characters
from lb02.prompts import (
    CHAT_MAX_TOKENS,
    LANGUAGE_MAX_TOKENS,
    LanguageGuess,
    OfferingFacts,
    OptionFacts,
    StateFacts,
    fit_history,
    history_messages,
    language_messages,
    state_block,
    system_prompt,
    tool_definitions,
)
from lb02.snapshot import Snapshot, options_of, snapshot_of
from lb02.states import Step
from lb02.tools import ToolExecutor, ToolOutcome, TurnContext, email_status, hold_expiry_note
from lb_common.gateway import Gateway
from lb_common.run import DataClass, Run, run_scope
from lb_common.tracing import RedisSpanWriter, Tracer

# The virtual models: the strongest chat model for the conversation, and a fast one for the language check.
CHAT_ALIAS = "lb-tools"
LANGUAGE_ALIAS = "lb-fast"
# The gateway's codes for "this run or this visitor has used its calls": retrying is pointless.
OUT_OF_QUOTA = frozenset({"quota_exceeded", "budget_exhausted"})
# The longest reply the concierge shows, in characters.
MAX_REPLY_CHARS = 1_200
BLANK_LINES = re.compile(r"\n{3,}")
REAL_ADDRESS_NOTE = (
    "The visitor gave an email address that isn't an example address, so it was not kept. "
    "Ask for an example one, such as name@example.test."
)

type Screening = Literal["clean", "flagged", "unchecked", "unavailable", "budget"]


class BudgetSpentError(Exception):
    """The conversation has used all the gateway calls it may."""


class GuardVerdictLike(Protocol):
    """The parts of lb_common.gateway.GuardVerdict the concierge reads."""

    @property
    def flagged(self) -> bool:
        """Whether the text looks like an injection attempt."""
        ...

    @property
    def score(self) -> float:
        """The classifier's highest injection probability across the text."""
        ...


class Guard(Protocol):
    """The injection check. lb_common.gateway.Gateway provides it."""

    def guard(self, text: str) -> GuardVerdictLike:
        """Check a text for a prompt injection."""
        ...


@dataclass(frozen=True)
class Reply:
    """What the concierge says, and the receipt it is when the code wrote it."""

    text: str
    receipt: Receipt | None = None


@dataclass(frozen=True)
class TurnResult(Snapshot):
    """Everything one turn produced: where the conversation stands now, what was said, and what ran on the way."""

    reply: str
    receipt: Receipt | None
    # Every tool call the model made this turn, in order, those the state machine refused included.
    tools: list[ToolOutcome] = field(default_factory=list)
    model_calls: int = 0


class BudgetedChat:
    """The JSON chat models, with each call counted against the conversation's budget before it is made."""

    def __init__(self, chat: ChatModels, conversation: Conversation) -> None:
        """Count the calls of `chat` against `conversation`."""
        self.chat = chat
        self.conversation = conversation

    def complete(self, alias: str, messages: Sequence[ChatMessage], max_tokens: int) -> Completion:
        """Ask the alias for a reply, unless the conversation has no calls left."""
        if not spend_call(self.conversation):
            raise BudgetSpentError
        return self.chat.complete(alias, messages, max_tokens)


def clean_reply(text: str) -> str:
    """Tidy a model's reply for display: no control characters, no runs of blank lines, a sane length."""
    cleaned = BLANK_LINES.sub("\n\n", strip_control_characters(text)).strip()
    if len(cleaned) <= MAX_REPLY_CHARS:
        return cleaned
    cut = cleaned[:MAX_REPLY_CHARS]
    sentence_end = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
    return cut[: sentence_end + 1] if sentence_end > MAX_REPLY_CHARS // 2 else cut.rstrip() + "…"


def is_out_of_quota(error: OpenAIError) -> bool:
    """Tell whether the gateway refused because a quota is spent, which no retry will fix."""
    return getattr(error, "code", None) in OUT_OF_QUOTA


class Concierge:
    """Takes a visitor's messages through the booking, one turn at a time, on the gateway's models."""

    def __init__(
        self,
        guard: Guard,
        chat: ChatModels,
        tool_chat: ToolChat,
        tracer: Tracer,
        bookings: BookingService,
        clock: Clock,
    ) -> None:
        """Screen with `guard`, check languages with `chat`, converse with `tool_chat`, and trace with `tracer`.

        `bookings` and `clock` are the calendar's rules and the time they, and every decision here, use.
        """
        self.guard = guard
        self.chat = chat
        self.tool_chat = tool_chat
        self.tracer = tracer
        self.bookings = bookings
        self.clock = clock
        self.tools = ToolExecutor(bookings, tracer, clock)

    def take_turn(self, conversation: Conversation, text: str, data_class: DataClass = "visitor") -> TurnResult:
        """Answer one visitor message, as a turn of the conversation's run.

        A visitor's conversation runs on their session's quota. A curated sample or a golden-set case is
        synthetic, runs on no visitor's quota, and may use the providers that only synthetic data may reach.
        """
        session = conversation.session_key if data_class == "visitor" else None
        run = Run(system="lb-02", run_id=conversation.run_id, data_class=data_class, session=session)
        with run_scope(run), self.tracer.span("visitor message", step=conversation.step) as span:
            result = self.work_through(conversation, text)
            span.set("step", result.step)
            span.set("calls", conversation.model_calls)
            span.set("tools", len(result.tools))
            if result.receipt is not None:
                span.set("receipt", str(result.receipt))
        return result

    def work_through(self, conversation: Conversation, text: str) -> TurnResult:
        """Take the message through every stage, stopping at the first that answers it."""
        if conversation.step == Step.HANDOFF:
            return self.view(conversation, Reply(render(Receipt.CLOSED, language_of(conversation)), Receipt.CLOSED))
        masked = mask(text)
        accepted = spend_message(conversation)
        record(conversation, "visitor", masked.text, self.clock())
        language = self.note_language(conversation, detect(masked.text))
        if not accepted:
            return self.end(conversation, Handoff.Reason.MESSAGE_LIMIT, Receipt.MESSAGE_LIMIT, language)
        screening = self.screen(conversation, masked.text)
        if screening != "clean":
            return self.stop_after(conversation, screening, language)
        language = self.settle_language(conversation, masked.text, language)
        context = self.prepare(conversation, masked, language)
        return self.converse(conversation, masked.text, context)

    # Language

    def note_language(self, conversation: Conversation, detection: Detection | None) -> str:
        """Take the language from what the code could read: any detection opens, only a certain one switches."""
        if detection is not None and (
            not conversation.language or (detection.certain and detection.language != conversation.language)
        ):
            conversation.language = detection.language
            conversation.save(update_fields=["language", "updated_at"])
        return language_of(conversation)

    def settle_language(self, conversation: Conversation, masked_text: str, language: str) -> str:
        """Ask the fast model for the language of a first message the code couldn't read, and fall back to English."""
        if conversation.language:
            return language
        guessed = "en"
        try:
            with self.tracer.span("detect language") as span:
                answer = ask_for_json(
                    BudgetedChat(self.chat, conversation),
                    LANGUAGE_ALIAS,
                    language_messages(masked_text),
                    LanguageGuess,
                    LANGUAGE_MAX_TOKENS,
                )
                guessed = answer.value.language
                span.set("language", guessed)
        except (OpenAIError, StructuredOutputError, BudgetSpentError):
            guessed = "en"
        conversation.language = guessed
        conversation.save(update_fields=["language", "updated_at"])
        return guessed

    # Screening

    def screen(self, conversation: Conversation, masked_text: str) -> Screening:
        """Check the message for an injection before any model that can call a tool reads it. Fails closed."""
        if not spend_call(conversation):
            return "budget"
        try:
            with self.tracer.span("screen for injection") as span:
                verdict = self.guard.guard(masked_text)
                span.set("flagged", verdict.flagged)
                span.set("score", round(verdict.score, 4))
        except OpenAIError as error:
            return "unavailable" if is_out_of_quota(error) else "unchecked"
        return "flagged" if verdict.flagged else "clean"

    def stop_after(self, conversation: Conversation, screening: Screening, language: str) -> TurnResult:
        """Answer a message the screen stopped, with the code's own wording and no model.

        A flagged message is refused, and refused for good after three. One that couldn't be
        checked is asked again, and handed over when it can't be checked twice running.
        """
        if screening == "flagged":
            return self.refuse_injection(conversation, language)
        if screening == "unchecked":
            return self.retry_or_end(conversation, Receipt.UNCHECKED, Handoff.Reason.UNCHECKED, language)
        if screening == "budget":
            return self.end(conversation, Handoff.Reason.BUDGET, Receipt.BUDGET_SPENT, language)
        return self.end(conversation, Handoff.Reason.UNAVAILABLE, Receipt.UNAVAILABLE, language)

    def refuse_injection(self, conversation: Conversation, language: str) -> TurnResult:
        """Refuse a flagged message, and hand the conversation over once the screen has flagged it three times."""
        conversation.injection_strikes += 1
        conversation.save(update_fields=["injection_strikes", "updated_at"])
        if conversation.injection_strikes >= INJECTION_STRIKES_BEFORE_HANDOFF:
            return self.end(conversation, Handoff.Reason.ABUSE, Receipt.HANDED_OFF, language)
        return self.view(conversation, Reply(render(Receipt.INJECTION_REFUSED, language), Receipt.INJECTION_REFUSED))

    def retry_or_end(self, conversation: Conversation, receipt: Receipt, reason: str, language: str) -> TurnResult:
        """Ask the visitor to try again, or hand the conversation over after the second failure in a row."""
        conversation.failed_turns += 1
        conversation.save(update_fields=["failed_turns", "updated_at"])
        if conversation.failed_turns >= FAILURES_BEFORE_HANDOFF:
            return self.end(conversation, reason, Receipt.HANDED_OFF, language)
        return self.view(conversation, Reply(render(receipt, language), receipt))

    # Preparing what the model will read

    def prepare(self, conversation: Conversation, masked: MaskedMessage, language: str) -> TurnContext:
        """Keep the contact address, tidy a hold that ran out, and refresh the slots on offer, before the model reads.

        Returns what the tools need to know about this turn, and what the model should be told.
        """
        self.keep_contact(conversation, masked)
        now = self.clock()
        self.expire_own_holds(conversation, now)
        step = sync_step(conversation, self.bookings)
        if step == Step.AVAILABILITY:
            self.tools.run_search(conversation)
        live = self.bookings.current_hold(conversation)
        notes = [REAL_ADDRESS_NOTE] if masked.real_addresses and not masked.example_address else []
        expired = self.expired_hold(conversation, now)
        if expired is not None:
            notes.append(hold_expiry_note(expired))
        return TurnContext(language=language, held_before=live.pk if live else None, notes=tuple(notes))

    def keep_contact(self, conversation: Conversation, masked: MaskedMessage) -> None:
        """Keep the example address the visitor wrote, read by this code and never by the model."""
        if masked.example_address and masked.example_address != conversation.guest_email:
            conversation.guest_email = masked.example_address
            conversation.save(update_fields=["guest_email", "updated_at"])

    def expire_own_holds(self, conversation: Conversation, now: datetime) -> None:
        """Mark the conversation's own hold expired once it has run out, and tell the live calendar."""
        with transaction.atomic(using=DATABASE):
            stale = list(
                Reservation.objects.filter(
                    conversation=conversation, status=Reservation.Status.HELD, hold_expires_at__lte=now
                )
            )
            if stale:
                Reservation.objects.filter(pk__in=[reservation.pk for reservation in stale]).update(
                    status=Reservation.Status.EXPIRED
                )
                self.bookings.announce(stale)

    def expired_hold(self, conversation: Conversation, now: datetime) -> Reservation | None:
        """Find the hold that ran out on the conversation and hasn't been replaced, for the model to be told about."""
        if self.bookings.current_hold(conversation) or self.bookings.current_booking(conversation):
            return None
        return (
            Reservation.objects.filter(
                conversation=conversation,
                status__in=[Reservation.Status.HELD, Reservation.Status.EXPIRED],
                hold_expires_at__lte=now,
            )
            .order_by("-created_at")
            .first()
        )

    # The conversation with the model

    def converse(self, conversation: Conversation, masked_text: str, context: TurnContext) -> TurnResult:
        """Let the model answer, calling tools as it needs to, within three chat calls."""
        history = history_messages(transcript_pairs(conversation)[:-1])
        exchange: list[ToolChatMessage] = []
        outcomes: list[ToolOutcome] = []
        try:
            for _ in range(MAX_CHAT_CALLS_PER_TURN):
                reply = self.ask(conversation, masked_text, context, history, exchange)
                if not reply.calls:
                    text = clean_reply(reply.text)
                    return self.answer(conversation, text, outcomes, context.language)
                receipt_reply = self.run_calls(conversation, reply, context, exchange, outcomes)
                if receipt_reply is not None:
                    return self.view(conversation, receipt_reply, outcomes)
        except BudgetSpentError:
            return self.end(conversation, Handoff.Reason.BUDGET, Receipt.BUDGET_SPENT, context.language, outcomes)
        except OpenAIError as error:
            return self.model_failed(conversation, error, context.language, outcomes)
        return self.lost_the_thread(conversation, context.language, outcomes)

    def ask(
        self,
        conversation: Conversation,
        masked_text: str,
        context: TurnContext,
        history: Sequence[ToolChatMessage],
        exchange: Sequence[ToolChatMessage],
    ) -> ToolReply:
        """Make one call to the chat model, offering the tools the conversation's step allows."""
        step = sync_step(conversation, self.bookings)
        tools = tool_definitions(step, [offering.key for offering in Offering.objects.all()])
        today = local_day(self.clock())
        first_day, last_day = bookable_days(self.clock())
        system = system_prompt(context.language, today, first_day, last_day, self.offering_facts())
        state = state_block(self.state_facts(conversation, context.notes))
        messages = fit_history(system, state, history, masked_text, tools, tail=exchange)
        if not spend_call(conversation):
            raise BudgetSpentError
        with self.tracer.span("converse", step=step) as span:
            reply = self.tool_chat.complete(CHAT_ALIAS, messages, tools, CHAT_MAX_TOKENS)
            span.set("tool_calls", len(reply.calls))
        return reply

    def run_calls(
        self,
        conversation: Conversation,
        reply: ToolReply,
        context: TurnContext,
        exchange: list[ToolChatMessage],
        outcomes: list[ToolOutcome],
    ) -> Reply | None:
        """Run the calls the model made, answer each one to it, and return the receipt that ends the turn, if any."""
        calls = reply.calls[:MAX_TOOL_CALLS_PER_REPLY]
        exchange.append(ToolChatMessage("assistant", reply.text or None, tool_calls=calls))
        ran: list[ToolOutcome] = []
        for call in calls:
            outcome = self.tools.run(conversation, call, context)
            exchange.append(ToolChatMessage("tool", outcome.for_model(), tool_call_id=call.id))
            if outcome.note:
                record(conversation, "action", outcome.note, self.clock())
            ran.append(outcome)
        outcomes.extend(ran)
        return self.receipt_for(ran, context.language)

    def receipt_for(self, ran: Sequence[ToolOutcome], language: str) -> Reply | None:
        """Write the receipt the last receipt-bearing outcome calls for, if the code has wording for this language."""
        for outcome in reversed(ran):
            if outcome.receipt is not None and has_wording(outcome.receipt, language):
                return Reply(
                    render(outcome.receipt, language, **outcome.facts, limit=MESSAGES_PER_SESSION), outcome.receipt
                )
        return None

    def answer(self, conversation: Conversation, text: str, outcomes: list[ToolOutcome], language: str) -> TurnResult:
        """Show the model's own reply, or ask the visitor to repeat themselves when it wrote none."""
        if not text:
            return self.lost_the_thread(conversation, language, outcomes)
        conversation.failed_turns = 0
        conversation.save(update_fields=["failed_turns", "updated_at"])
        # Czech is typeset the way the code's own Czech is, so no line may end on a one-letter word.
        return self.view(conversation, Reply(typeset_czech(text) if language == "cs" else text), outcomes)

    def lost_the_thread(self, conversation: Conversation, language: str, outcomes: list[ToolOutcome]) -> TurnResult:
        """Ask the visitor to say it again when the model gave nothing, and hand over the second time running."""
        conversation.failed_turns += 1
        conversation.save(update_fields=["failed_turns", "updated_at"])
        if conversation.failed_turns >= FAILURES_BEFORE_HANDOFF:
            return self.end(conversation, Handoff.Reason.UNAVAILABLE, Receipt.UNAVAILABLE, language, outcomes)
        return self.view(conversation, Reply(render(Receipt.OOPS, language), Receipt.OOPS), outcomes)

    def model_failed(
        self, conversation: Conversation, error: OpenAIError, language: str, outcomes: list[ToolOutcome]
    ) -> TurnResult:
        """Hand over at once when the gateway's quota is spent, and otherwise let the visitor try again."""
        if is_out_of_quota(error):
            return self.end(conversation, Handoff.Reason.UNAVAILABLE, Receipt.UNAVAILABLE, language, outcomes)
        return self.lost_the_thread(conversation, language, outcomes)

    # Ending, and describing

    def end(
        self,
        conversation: Conversation,
        reason: str,
        receipt: Receipt,
        language: str,
        outcomes: list[ToolOutcome] | None = None,
    ) -> TurnResult:
        """Hand the conversation to a person, and say so with the code's own wording."""
        hand_over(conversation, Handoff.Reason(reason), self.bookings, self.clock())
        reply = Reply(render(receipt, language, limit=MESSAGES_PER_SESSION), receipt)
        return self.view(conversation, reply, outcomes or [])

    def view(self, conversation: Conversation, reply: Reply, outcomes: list[ToolOutcome] | None = None) -> TurnResult:
        """Record the reply in the transcript and describe where the conversation stands now."""
        record(conversation, "concierge", reply.text, self.clock())
        sync_step(conversation, self.bookings)
        where = snapshot_of(conversation, self.bookings)
        if where.closed:
            refresh_transcript(conversation)
        return TurnResult(
            reply=reply.text,
            receipt=reply.receipt,
            step=where.step,
            language=where.language,
            options=where.options,
            hold=where.hold,
            booking=where.booking,
            messages_left=where.messages_left,
            closed=where.closed,
            tools=outcomes or [],
            model_calls=conversation.model_calls,
        )

    def offering_facts(self) -> list[OfferingFacts]:
        """Describe the offerings for the prompt, in English."""
        return [
            OfferingFacts(o.key, o.title_en, o.duration_minutes, o.capacity, o.price_czk)
            for o in Offering.objects.all()
        ]

    def state_facts(self, conversation: Conversation, notes: Sequence[str]) -> StateFacts:
        """Gather the State the model reads, from the database, as it is at this moment."""
        offering = conversation.offering
        hold = self.bookings.current_hold(conversation)
        booking = self.bookings.current_booking(conversation)
        options = tuple(
            OptionFacts(view.number, view.offering, when_text(view.starts_at, view.ends_at, "en"))
            for view in options_of(conversation)
        )
        return StateFacts(
            step=conversation.step,
            offering=f"{offering.key} ({offering.title_en})" if offering else "not chosen",
            party_size=conversation.party_size,
            name=conversation.guest_name,
            email=email_status(conversation),
            missing=tuple(conversation.missing_details()),
            search=search_text(conversation),
            options=options,
            hold=self.hold_text(hold),
            booking=f"{booking.code}, {when_text(booking.during.lower, booking.during.upper, 'en')}"
            if booking
            else "none",
            notes=tuple(notes),
        )

    def hold_text(self, hold: Reservation | None) -> str:
        """Describe a live hold for the State: its slot, and that it runs out five minutes after it was made."""
        if hold is None:
            return "none"
        return f"{when_text(hold.during.lower, hold.during.upper, 'en')}, until {hold.hold_expires_at:%H:%M} UTC"


def search_text(conversation: Conversation) -> str:
    """Describe the last search for the State, or say none has been made."""
    if conversation.search_from is None:
        return "not made yet"
    last: date = conversation.search_to or conversation.search_from
    return f"{conversation.search_from.isoformat()} to {last.isoformat()}, {conversation.search_part_of_day or 'any'}"


@cache
def shared_gateway() -> Gateway:
    """Connect to the gateway once per process, with the settings in the environment."""
    return Gateway.from_env()


def connect_concierge(clock: Clock = timezone.now, notifier: CalendarNotifier | None = None) -> Concierge:
    """Build the concierge the service runs: the gateway from the environment, spans to Redis, and the live calendar.

    The golden-set eval passes a clock of its own, so it can make a hold run out without waiting, and a notifier
    that tells nobody, so an eval never moves a visitor's calendar.
    """
    gateway = shared_gateway()
    writer = RedisSpanWriter(Redis.from_url(settings.REDIS_URL), prefix=settings.REDIS_PREFIX)
    return Concierge(
        guard=gateway,
        chat=GatewayChat(gateway),
        tool_chat=GatewayToolChat(gateway),
        tracer=Tracer(writer),
        bookings=BookingService(clock=clock, notifier=notifier or ChannelLayerNotifier()),
        clock=clock,
    )
