"""The confirmation email of a booking: written, recorded on the page, and never sent.

Sending the confirmation is the last step of the datasheet's chain. Here it is a mock by
construction: the message is built from the booking's facts in English or Czech, stored as a
`Confirmation` whose delivery can only be `mock` (the database refuses anything else), and
shown by the page as what would have been sent. No code path in this service sends email.

The text is written by this module from the booking's own facts, never by the model, so a
confirmation can't promise anything the booking doesn't hold.
"""

from datetime import datetime
from typing import Final

from lb02.messages import guests, typeset_czech, when_text
from lb02.models import Confirmation, Conversation, Reservation

SUBJECTS: Final = {
    "en": "Your Basalt & Bean booking {code}",
    "cs": "Vaše rezervace v Basalt & Bean {code}",
}
BODIES: Final = {
    "en": (
        "Hello {name},\n\n"
        "Your booking is confirmed.\n\n"
        "{offering}\n{when} (Prague time)\nFor {party}\nBooking code: {code}\n\n"
        "This is a demo: this message was recorded on the page and was never sent to {to}.\n\n"
        "Basalt & Bean Coffee Co."
    ),
    "cs": (
        "Dobrý den, {name},\n\n"
        "vaše rezervace je potvrzena.\n\n"
        "{offering}\n{when} (pražský čas)\nPro {party}\nKód rezervace: {code}\n\n"
        "Toto je ukázka: zpráva byla jen zaznamenána na stránce a nikdy nebyla odeslána na {to}.\n\n"
        "Basalt & Bean Coffee Co."
    ),
}


def record_confirmation(
    conversation: Conversation, reservation: Reservation, language: str, now: datetime
) -> Confirmation:
    """Build a booking's confirmation in English or Czech and record it as a mock, replacing none already made.

    Recording twice for one booking returns the first, so a repeated confirm never writes two.
    """
    existing = Confirmation.objects.filter(reservation=reservation).first()
    if existing is not None:
        return existing
    wording = "cs" if language == "cs" else "en"
    offering = reservation.slot.offering
    facts = {
        "name": reservation.guest_name,
        "offering": offering.title(wording),
        "when": when_text(reservation.during.lower, reservation.during.upper, wording),
        "party": guests(reservation.party_size, wording),
        "code": reservation.code,
        "to": conversation.guest_email,
    }
    body = BODIES[wording].format(**facts)
    return Confirmation.objects.create(
        reservation=reservation,
        to_address=conversation.guest_email,
        subject=SUBJECTS[wording].format(code=reservation.code),
        body=typeset_czech(body) if wording == "cs" else body,
        language=wording,
        recorded_at=now,
    )
