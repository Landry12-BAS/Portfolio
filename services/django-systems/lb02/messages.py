"""The messages the concierge's own code writes, in English and Czech: receipts, refusals and notices.

Most of what the concierge says comes from the model, in the visitor's language. These
moments don't, because they state facts the model must not get wrong or can't be asked:

- a hold was placed, a booking was made, a hold ran out, a slot was taken: the times, the
  code and the numbers come from the database, never from the model's memory of a tool result;
- the injection screen refused a message, couldn't check it, or a limit ended the
  conversation: no model is called at all.

A receipt costs no model call, which is part of how a booking stays within 6 to 10 calls.
The receipts that confirm a fact have English and Czech wording. In any other language the
model writes them from the tool result instead (one more call), while the notices that
involve no model are shown in English, the language everything falls back to.

Czech text is typeset the way the site's is (docs: Languages): a space after a one-letter
word becomes a non-breaking one, so no line ends on it.
"""

import re
from datetime import datetime
from enum import StrEnum
from typing import Final

from lb02.models import ROASTERY_TIME_ZONE

# The languages the receipts are written in; every other language falls back to English.
TEMPLATE_LANGUAGES: Final = ("en", "cs")
# A space that follows a one-letter Czech word, which must not end a line.
SINGLE_LETTER_WORD: Final = re.compile(r"(?<!\w)([KkSsVvZzAaIiOoUu])\s", re.UNICODE)
NO_BREAK_SPACE: Final = chr(0xA0)
# The dash between the start and the end of a session, as typography writes a range.
EN_DASH: Final = chr(0x2013)

WEEKDAYS: Final = {
    "en": ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"),
    "cs": ("po", "út", "st", "čt", "pá", "so", "ne"),
}
MONTHS_EN: Final = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


class Receipt(StrEnum):
    """The kinds of message the concierge's code writes itself."""

    HOLD_PLACED = "hold_placed"
    BOOKING_CONFIRMED = "booking_confirmed"
    HOLD_EXPIRED = "hold_expired"
    SLOT_TAKEN = "slot_taken"
    INJECTION_REFUSED = "injection_refused"
    UNCHECKED = "unchecked"
    HANDED_OFF = "handed_off"
    MESSAGE_LIMIT = "message_limit"
    BUDGET_SPENT = "budget_spent"
    UNAVAILABLE = "unavailable"
    OOPS = "oops"
    CLOSED = "closed"


# The receipts that state a booking fact. For a language without wording of its own, the
# model writes them from the tool result, so they are the one kind that can cost a call.
MODEL_WRITES_IN_OTHER_LANGUAGES: Final = frozenset(
    {Receipt.HOLD_PLACED, Receipt.BOOKING_CONFIRMED, Receipt.HOLD_EXPIRED, Receipt.SLOT_TAKEN}
)

TEMPLATES: Final[dict[str, dict[Receipt, str]]] = {
    "en": {
        Receipt.HOLD_PLACED: (
            "I've held {offering} on {when} for {party} for {minutes} minutes. Shall I confirm it? "
            "Just say yes. If you'd rather not, tell me and I'll release it."
        ),
        Receipt.BOOKING_CONFIRMED: (
            "You're booked: {offering} on {when} for {party}. Your booking code is {code}. "
            "I've recorded a confirmation for {to} on this page; this demo never sends real email."
        ),
        Receipt.HOLD_EXPIRED: (
            "Your hold on {when} ran out after {minutes} minutes, so that time is free again. "
            "Would you like me to look for times again?"
        ),
        Receipt.SLOT_TAKEN: "Sorry, someone else has just taken that time. Shall I look for other times?",
        Receipt.INJECTION_REFUSED: (
            "I can only help with booking tastings, cupping sessions and roasting workshops, "
            "and I can't change how I work. What would you like to book?"
        ),
        Receipt.UNCHECKED: (
            "I couldn't check that message just now, so I haven't acted on it. Please try again in a moment."
        ),
        Receipt.HANDED_OFF: (
            "I've passed this conversation, with everything we've said so far, to a member of our team. "
            "They'll pick it up from here."
        ),
        Receipt.MESSAGE_LIMIT: (
            "We've reached the {limit} messages this demo allows in one conversation, so I've passed it, "
            "with the whole transcript, to a member of our team."
        ),
        Receipt.BUDGET_SPENT: (
            "This conversation has used all the model calls the demo allows, so I've passed it, with the "
            "whole transcript, to a member of our team."
        ),
        Receipt.UNAVAILABLE: (
            "I can't reach my tools at the moment, so I've passed this conversation, with everything "
            "we've said so far, to a member of our team."
        ),
        Receipt.OOPS: "Sorry, I lost my place. Could you say that again?",
        Receipt.CLOSED: "This conversation is finished. To book something else, please start a new chat.",
    },
    "cs": {
        Receipt.HOLD_PLACED: (
            "Termín {when} ({offering}) pro {party} je pro vás podržen na {minutes} minut. "
            "Mám ho potvrdit? Stačí napsat „ano“. Pokud ne, dejte vědět a uvolním ho."
        ),
        Receipt.BOOKING_CONFIRMED: (
            "Hotovo, máte rezervováno: {offering}, {when}, pro {party}. Kód rezervace: {code}. "
            "Potvrzení pro {to} je zaznamenáno na této stránce; demo žádný e-mail doopravdy neposílá."
        ),
        Receipt.HOLD_EXPIRED: (
            "Podržení termínu {when} po {minutes} minutách vypršelo a termín je zase volný. "
            "Mám znovu vyhledat volné termíny?"
        ),
        Receipt.SLOT_TAKEN: "Tenhle termín mezitím obsadil někdo jiný. Mám vyhledat jiné termíny?",
        Receipt.INJECTION_REFUSED: (
            "Umím pomoci jen s rezervací degustací, cuppingů a pražících workshopů a svá pravidla "
            "měnit nemohu. Co byste si přáli rezervovat?"
        ),
        Receipt.UNCHECKED: (
            "Tuhle zprávu se teď nepodařilo zkontrolovat, takže se podle ní nic nestalo. "
            "Zkuste to prosím za chvíli znovu."
        ),
        Receipt.HANDED_OFF: (
            "Konverzace je i s celým dosavadním přepisem předána našemu týmu. Převezme ji někdo z kolegů."
        ),
        Receipt.MESSAGE_LIMIT: (
            "Dosáhli jsme {limit} zpráv, které toto demo v jedné konverzaci povoluje, proto je konverzace "
            "i s celým přepisem předána našemu týmu."
        ),
        Receipt.BUDGET_SPENT: (
            "Tato konverzace vyčerpala všechna volání modelu, která demo povoluje, proto je i s celým "
            "přepisem předána našemu týmu."
        ),
        Receipt.UNAVAILABLE: (
            "Momentálně nemám přístup ke svým nástrojům, proto je konverzace i s celým dosavadním "
            "přepisem předána našemu týmu."
        ),
        Receipt.OOPS: "Omlouvám se, ztratil se mi kontext. Můžete to prosím zopakovat?",
        Receipt.CLOSED: "Tahle konverzace je u konce. Pro další rezervaci prosím začněte nový chat.",
    },
}


def typeset_czech(text: str) -> str:
    """Put a non-breaking space after every one-letter word, so no line of Czech text ends on one."""
    return SINGLE_LETTER_WORD.sub(lambda match: match.group(1) + NO_BREAK_SPACE, text)


def has_wording(receipt: Receipt, language: str) -> bool:
    """Tell whether the code writes this receipt in this language, or leaves it to the model.

    Receipts that don't state a booking fact always have wording, in English when the
    language has none; the ones that do are the model's to write in a language without any.
    """
    return language in TEMPLATE_LANGUAGES or receipt not in MODEL_WRITES_IN_OTHER_LANGUAGES


def guests(count: int, language: str) -> str:
    """Write a party size as the language counts it: 1 guest, 2 guests; 1 osobu, 2 osoby, 5 osob."""
    if language == "cs":
        if count == 1:
            return "1 osobu"
        return f"{count} osoby" if 2 <= count <= 4 else f"{count} osob"
    return "1 guest" if count == 1 else f"{count} guests"


def when_text(starts_at: datetime, ends_at: datetime, language: str) -> str:
    """Write a session's day and time on the roastery's clock: `Fri 2 Oct, 14:30-15:30`, `pá 2. 10., 14:30-15:30`."""
    start = starts_at.astimezone(ROASTERY_TIME_ZONE)
    end = ends_at.astimezone(ROASTERY_TIME_ZONE)
    hours = f"{start:%H:%M}{EN_DASH}{end:%H:%M}"
    if language == "cs":
        return f"{WEEKDAYS['cs'][start.weekday()]} {start.day}. {start.month}., {hours}"
    return f"{WEEKDAYS['en'][start.weekday()]} {start.day} {MONTHS_EN[start.month - 1]}, {hours}"


def render(receipt: Receipt, language: str, **facts: object) -> str:
    """Write a receipt in a language, filling in its facts; languages without wording get English.

    Raises KeyError if a fact the wording needs is missing, so a receipt can never go out
    with a hole in it.
    """
    wording = TEMPLATES["cs" if language == "cs" else "en"][receipt]
    text = wording.format(**facts)
    return typeset_czech(text) if language == "cs" else text
