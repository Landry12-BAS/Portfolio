"""Integration tests for LB-02's HTTP API: the offerings, the calendar and a visitor's own conversations."""

from datetime import timedelta
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from django.test import Client

from lb02 import api
from lb02.booking import BookingService
from lb02.models import Confirmation, Conversation, Offering, Reservation
from lb02.states import Step
from tests.lb02_support import (
    FIRST_MESSAGE,
    SECOND_MESSAGE,
    THIRD_MESSAGE,
    Rig,
    build_rig,
    call,
    calling,
    mint_token,
    say,
)

pytestmark = [pytest.mark.integration, pytest.mark.django_db(databases=["lb02"])]

JANA = "session-of-jana-visitor-01"
DAN = "session-of-dan-visitor-002"


@pytest.fixture(autouse=True)
def rig(monkeypatch: pytest.MonkeyPatch) -> Rig:
    """Build the concierge on fakes over a seeded calendar, and give the API the rig's clock to read the calendar by."""
    built = build_rig()
    monkeypatch.setattr(api, "booking_service", lambda: BookingService(clock=built.clock))
    return built


def visitor(key: Ed25519PrivateKey, session: str = JANA, system: str = "lb-02") -> Client:
    """Return a test client that calls as a visitor, with a token the site minted for `system`."""
    return Client(headers={"Authorization": f"Bearer {mint_token(key, session, system)}"})


def get(client: Client, path: str) -> tuple[int, Any]:
    """GET a path and return the status and the JSON body."""
    response = client.get(path)
    return response.status_code, response.json()


def booked_conversation(rig: Rig, session: str = JANA) -> Conversation:
    """Take a visitor through a whole cupping booking and return their conversation."""
    conversation = rig.conversation(session)
    rig.script_booking()
    for message in (FIRST_MESSAGE, SECOND_MESSAGE, THIRD_MESSAGE):
        rig.concierge.take_turn(conversation, message)
    return conversation


# Who may ask


@pytest.mark.parametrize(
    "path",
    [
        "/api/lb02/offerings",
        "/api/lb02/calendar",
        "/api/lb02/conversations",
        "/api/lb02/conversations/AAAAAAAAAAAAAAAA",
    ],
)
def test_every_route_needs_a_visitor_token_for_lb_02(web_signing_key: Ed25519PrivateKey, path: str) -> None:
    """No token, or a token minted for another system, is a 401 in the platform's error shape."""
    for client in (Client(), visitor(web_signing_key, system="lb-01")):
        status, body = get(client, path)

        assert status == 401
        assert body["error"]["code"] == "unauthorized"


# The offerings


def test_the_offerings_come_in_both_languages(web_signing_key: Ed25519PrivateKey) -> None:
    """The page shows each offering in the visitor's language, with what it needs to price and size a booking."""
    status, offerings = get(visitor(web_signing_key), "/api/lb02/offerings")

    assert status == 200
    assert [offering["key"] for offering in offerings] == ["tasting", "cupping", "roasting-workshop"]
    tasting = offerings[0]
    assert tasting["title"] == {"en": "Coffee tasting", "cs": "Degustace kávy"}
    assert tasting["room"] == {"en": "Tasting Room", "cs": "Ochutnávková místnost"}
    assert (tasting["duration_minutes"], tasting["capacity"], tasting["price_czk"]) == (45, 6, 350)


# The calendar


def test_the_czech_texts_are_typeset_so_no_line_can_end_on_a_one_letter_word(
    web_signing_key: Ed25519PrivateKey,
) -> None:
    """The same rule as everywhere Czech is shown: a no-break space after u, s, k, z and the like."""
    _, offerings = get(visitor(web_signing_key), "/api/lb02/offerings")

    summary = offerings[0]["summary"]["cs"]
    assert "u" + chr(0xA0) + "na\u0161eho baru" in summary
    assert "s" + chr(0xA0) + "pozn\u00e1mkami" in summary
    assert " u " not in summary
    assert (
        offerings[0]["summary"]["en"]
        == "A private guided flight of three single-origin coffees at our bar, with notes on how each was roasted."
    )


def test_the_calendar_shows_tomorrow_and_the_days_after_it_with_every_slot_free(
    web_signing_key: Ed25519PrivateKey,
) -> None:
    """The calendar opens tomorrow and runs 14 days, and nothing is held or booked in a fresh one."""
    status, calendar = get(visitor(web_signing_key), "/api/lb02/calendar")

    assert status == 200
    assert (calendar["first_day"], calendar["last_day"]) == ("2026-10-02", "2026-10-15")
    assert len(calendar["slots"]) == 14 * 8
    assert {slot["status"] for slot in calendar["slots"]} == {"free"}
    assert not any(slot["mine"] for slot in calendar["slots"])
    first = calendar["slots"][0]
    assert (first["offering"], first["starts_at"]) == ("tasting", "2026-10-02T08:00:00Z")
    assert calendar["as_of"] == "2026-10-01T09:00:00Z"


def test_a_window_of_days_can_be_asked_for(web_signing_key: Ed25519PrivateKey) -> None:
    """`from` and `days` pick the days shown, so the page can draw a week at a time."""
    status, calendar = get(visitor(web_signing_key), "/api/lb02/calendar?from=2026-10-05&days=2")

    assert status == 200
    assert (calendar["first_day"], calendar["last_day"]) == ("2026-10-05", "2026-10-06")
    assert {slot["starts_at"][:10] for slot in calendar["slots"]} == {"2026-10-05", "2026-10-06"}


@pytest.mark.parametrize("query", ["days=0", "days=15", "days=many", "from=tomorrow"])
def test_a_bad_window_is_refused_in_the_platforms_error_shape(web_signing_key: Ed25519PrivateKey, query: str) -> None:
    """The refusal names the fields at fault and never repeats what was sent."""
    status, body = get(visitor(web_signing_key), f"/api/lb02/calendar?{query}")

    assert status == 422
    assert body["error"]["code"] == "invalid_request"
    assert "tomorrow" not in str(body)
    assert "many" not in str(body)


def test_a_held_slot_is_held_for_everyone_and_mine_only_for_the_conversation_that_holds_it(
    rig: Rig, web_signing_key: Ed25519PrivateKey
) -> None:
    """Both visitors see the slot as held; only the holder, naming their conversation, sees it as theirs."""
    jana = rig.conversation(JANA)
    rig.give_details(jana)
    rig.run_tool(jana, "hold_slot", option=1)

    def held_slots(session: str, conversation: str | None = None) -> list[dict[str, Any]]:
        """Read the day's calendar as a visitor, optionally from the point of view of one of their conversations."""
        extra = f"&conversation={conversation}" if conversation else ""
        _, calendar = get(visitor(web_signing_key, session), f"/api/lb02/calendar?days=1{extra}")
        return [slot for slot in calendar["slots"] if slot["status"] != "free"]

    others = held_slots(DAN)
    janas = held_slots(JANA, jana.public_id)
    without_naming_it = held_slots(JANA)

    assert [(slot["offering"], slot["status"], slot["mine"]) for slot in others] == [("cupping", "held", False)]
    assert [(slot["offering"], slot["status"], slot["mine"]) for slot in janas] == [("cupping", "held", True)]
    assert [slot["mine"] for slot in without_naming_it] == [False]
    assert others[0]["until"] == "2026-10-01T09:05:00Z"


def test_the_whole_room_is_taken_with_a_slot_that_overlaps_it(rig: Rig, web_signing_key: Ed25519PrivateKey) -> None:
    """The 11:30 cupping holds the Tasting Room, so the 12:00 tasting shows as held too: the calendar is honest."""
    jana = rig.conversation(JANA)
    rig.give_details(jana, part_of_day="morning")
    rig.run_tool(jana, "hold_slot", option=1)

    _, calendar = get(visitor(web_signing_key, DAN), "/api/lb02/calendar?days=1")

    taken = {(slot["offering"], slot["starts_at"][11:16]) for slot in calendar["slots"] if slot["status"] == "held"}
    assert taken == {("cupping", "09:30"), ("tasting", "10:00")}


def test_a_booked_slot_stays_booked(rig: Rig, web_signing_key: Ed25519PrivateKey) -> None:
    """A booking doesn't run out, and shows as booked to everyone and mine to its owner."""
    conversation = booked_conversation(rig)
    rig.clock.advance(60)

    _, calendar = get(visitor(web_signing_key, DAN), "/api/lb02/calendar?days=1")
    _, mine = get(visitor(web_signing_key, JANA), f"/api/lb02/calendar?days=1&conversation={conversation.public_id}")

    assert {slot["status"] for slot in calendar["slots"] if slot["offering"] == "cupping"} >= {"booked"}
    assert [slot["mine"] for slot in mine["slots"] if slot["status"] == "booked"] == [True]
    assert not any(slot["mine"] for slot in calendar["slots"])


def test_a_hold_that_ran_out_shows_as_free_before_any_sweep(rig: Rig, web_signing_key: Ed25519PrivateKey) -> None:
    """Expiry is read from the clock: six minutes later the slot is free whether or not the sweep has run."""
    jana = rig.conversation(JANA)
    rig.give_details(jana)
    rig.run_tool(jana, "hold_slot", option=1)
    rig.clock.advance(6)

    _, calendar = get(visitor(web_signing_key, DAN), "/api/lb02/calendar?days=1")

    assert {slot["status"] for slot in calendar["slots"]} == {"free"}
    assert Reservation.objects.get(conversation=jana).status == Reservation.Status.HELD


def test_another_visitors_conversation_cant_be_used_as_the_point_of_view(
    rig: Rig, web_signing_key: Ed25519PrivateKey
) -> None:
    """Naming someone else's conversation, or none that exists, is the same 404, so IDs can't be probed."""
    jana = rig.conversation(JANA)

    status, body = get(visitor(web_signing_key, DAN), f"/api/lb02/calendar?conversation={jana.public_id}")
    unknown_status, unknown_body = get(
        visitor(web_signing_key, DAN), "/api/lb02/calendar?conversation=AAAAAAAAAAAAAAAA"
    )

    assert (status, unknown_status) == (404, 404)
    assert body == unknown_body
    assert body["error"]["code"] == "not_found"


# A visitor's conversations


def test_a_visitor_lists_their_own_conversations_newest_first(rig: Rig, web_signing_key: Ed25519PrivateKey) -> None:
    """Their own, and nobody else's, with where each stands."""
    older = rig.conversation(JANA)
    rig.clock.advance(1)
    newer = rig.conversation(JANA)
    rig.conversation(DAN)

    status, conversations = get(visitor(web_signing_key, JANA), "/api/lb02/conversations")

    assert status == 200
    assert [conversation["id"] for conversation in conversations] == [newer.public_id, older.public_id]
    assert conversations[0] == {
        "id": newer.public_id,
        "step": "details",
        "language": "en",
        "messages_used": 0,
        "messages_left": 30,
        "closed": False,
        "created_at": "2026-10-01T09:01:00Z",
        "expires_at": "2026-10-02T09:01:00Z",
    }


def test_the_list_is_cut_at_twenty(rig: Rig, web_signing_key: Ed25519PrivateKey) -> None:
    """A visitor may start ten a day, so twenty is two days' worth, and the list never grows without limit."""
    for number in range(22):
        Conversation.objects.create(session_key=JANA, created_at=rig.clock() + timedelta(minutes=number))

    _, conversations = get(visitor(web_signing_key, JANA), "/api/lb02/conversations")

    assert len(conversations) == 20


def test_a_booked_conversation_shows_everything_the_page_needs(rig: Rig, web_signing_key: Ed25519PrivateKey) -> None:
    """Transcript, booking, and the confirmation that was recorded and never sent."""
    conversation = booked_conversation(rig)

    status, detail = get(visitor(web_signing_key, JANA), f"/api/lb02/conversations/{conversation.public_id}")

    assert status == 200
    assert (detail["step"], detail["closed"], detail["messages_used"], detail["model_calls"]) == ("done", False, 3, 7)
    assert detail["run_id"] == conversation.run_id
    assert detail["booking"]["offering"] == "cupping"
    assert detail["booking"]["to"] == "jana@example.test"
    assert (detail["hold"], detail["options"], detail["handoff"]) == (None, [], None)
    confirmation = detail["confirmation"]
    assert confirmation["delivery"] == "mock"
    assert confirmation["to"] == "jana@example.test"
    assert detail["booking"]["code"] in confirmation["body"]
    roles = [line["role"] for line in detail["transcript"]]
    assert roles.count("visitor") == 3
    assert roles.count("concierge") == 3
    assert [line["position"] for line in detail["transcript"]] == sorted(
        line["position"] for line in detail["transcript"]
    )
    assert detail["transcript"][0]["text"] == FIRST_MESSAGE.replace("jana@example.test", "[email]")


def test_a_conversation_that_is_waiting_for_a_yes_shows_its_hold(rig: Rig, web_signing_key: Ed25519PrivateKey) -> None:
    """The hold and the five minutes it has left."""
    conversation = rig.conversation(JANA)
    rig.script_booking()
    rig.concierge.take_turn(conversation, FIRST_MESSAGE)
    rig.concierge.take_turn(conversation, SECOND_MESSAGE)

    _, detail = get(visitor(web_signing_key, JANA), f"/api/lb02/conversations/{conversation.public_id}")

    assert detail["step"] == "hold"
    assert detail["hold"]["expires_at"] == "2026-10-01T09:05:00Z"
    assert (detail["booking"], detail["confirmation"]) == (None, None)


def test_a_handoff_carries_its_reason_its_summary_and_the_whole_transcript(
    rig: Rig, web_signing_key: Ed25519PrivateKey
) -> None:
    """What a person who takes over would be given, as the page can show it."""
    conversation = rig.conversation(JANA)
    rig.models.replies += [
        calling(call("update_details", offering="cupping", party_size=2, name="Jana Novak")),
        say("Sure. Which day would you like?"),
        calling(call("handoff_to_person", reason="asked_for_person")),
    ]
    rig.concierge.take_turn(conversation, "Hello! A cupping for two for Jana Novak, jana@example.test.")
    rig.concierge.take_turn(conversation, "Actually, may I speak to a person?")

    _, detail = get(visitor(web_signing_key, JANA), f"/api/lb02/conversations/{conversation.public_id}")

    assert (detail["step"], detail["closed"]) == ("handoff", True)
    handoff = detail["handoff"]
    assert handoff["reason"] == "asked_for_person"
    assert "offering: cupping; guests: 2; name: Jana Novak" in handoff["summary"]
    assert [line["text"] for line in handoff["transcript"]] == [line["text"] for line in detail["transcript"]]
    assert handoff["transcript"][-1]["role"] == "concierge"


def test_another_visitors_conversation_is_not_found(rig: Rig, web_signing_key: Ed25519PrivateKey) -> None:
    """The ID alone opens nothing: the same 404 as for an ID that doesn't exist."""
    jana = rig.conversation(JANA)

    status, body = get(visitor(web_signing_key, DAN), f"/api/lb02/conversations/{jana.public_id}")
    unknown_status, unknown_body = get(visitor(web_signing_key, DAN), "/api/lb02/conversations/AAAAAAAAAAAAAAAA")

    assert (status, unknown_status) == (404, 404)
    assert body == unknown_body


def test_reading_a_conversation_changes_nothing(rig: Rig, web_signing_key: Ed25519PrivateKey) -> None:
    """A GET describes the conversation as it is now and leaves the stored step alone, even when a hold has run out."""
    conversation = rig.conversation(JANA)
    rig.give_details(conversation)
    rig.run_tool(conversation, "hold_slot", option=1)
    rig.clock.advance(6)

    _, detail = get(visitor(web_signing_key, JANA), f"/api/lb02/conversations/{conversation.public_id}")

    assert detail["step"] == "availability"
    assert detail["hold"] is None
    assert Conversation.objects.get(pk=conversation.pk).step == Step.HOLD
    assert Confirmation.objects.count() == 0
    assert Offering.objects.count() == 3
