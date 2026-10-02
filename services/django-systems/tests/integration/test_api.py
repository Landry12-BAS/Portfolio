"""Integration tests for LB-01's API: visitors file tickets, read cited drafts and decide, each in their own session."""

import base64
import time
from collections.abc import Callable
from datetime import date
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from django.conf import settings
from django.test import Client
from pytest_django.fixtures import Settings

from lb01.api import TICKETS_PER_DAY
from lb01.models import Customer, Decision, Draft, Ticket
from lb01.seed import seed
from lb01.tasks import run_ticket
from tests.lb02_support import race
from tests.support import held_until_all_have_counted

pytestmark = [pytest.mark.integration, pytest.mark.django_db(databases=["lb01"])]

SAM = "session-of-sam-visitor-0001"
SOMEONE_ELSE = "session-of-another-visitor"


@pytest.fixture(autouse=True)
def seeded() -> None:
    """Load the synthetic customers, orders and policies."""
    seed(settings.SEED_DIR / "lb01", date(2026, 10, 1))


@pytest.fixture
def site_key(settings: Settings) -> Ed25519PrivateKey:
    """Make the site's signing key, and give the service its public half."""
    key = Ed25519PrivateKey.generate()
    raw = key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    settings.WEB_TOKEN_KEY = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    return key


@pytest.fixture
def queued(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    """Catch the tickets the API queues for the worker, instead of sending them to Celery."""
    tickets: list[int] = []
    monkeypatch.setattr(run_ticket, "delay", tickets.append)
    return tickets


def visitor(key: Ed25519PrivateKey, session: str = SAM, system: str = "lb-01") -> Client:
    """Return a test client that calls as a visitor, with a token the site minted for `system`."""
    now = int(time.time())
    claims = {"iss": "lb-web", "aud": system, "sub": session, "iat": now, "exp": now + 300}
    return Client(headers={"Authorization": f"Bearer {jwt.encode(claims, key, algorithm='EdDSA')}"})


def drafted_ticket(session: str = SAM, language: str = "en") -> Ticket:
    """File a ticket that already has a draft waiting for approval, one sentence of it unsupported."""
    ticket = Ticket.objects.create(
        session_key=session,
        customer=Customer.objects.get(key="cus-0001"),
        language=language,
        body="My order BB-1040 came with a torn bag.",
        status=Ticket.Status.AWAITING_APPROVAL,
        category="damaged",
        order_number="BB-1040",
    )
    Draft.objects.create(
        ticket=ticket,
        sentences=[
            {"text": "Hello Sam,", "citations": []},
            {"text": "Send us a photo within 14 days.", "citations": ["passage:damaged.torn-bags"]},
            {"text": "It was delivered on 1 September.", "citations": ["order:BB-1040"]},
        ],
        claims_supported=False,
        unsupported=[{"sentence": 2, "reason": "states 1, which its sources don't"}],
        model="test/lb-tools",
    )
    return ticket


def test_every_route_needs_a_visitor_token_for_its_system(site_key: Ed25519PrivateKey) -> None:
    """No token, or a token for another system, gets a 401 in the platform's error shape."""
    for client in (Client(), visitor(site_key, system="lb-02")):
        response = client.get("/api/lb01/tickets")

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "unauthorized"


def test_the_customers_to_file_as_are_listed(site_key: Ed25519PrivateKey) -> None:
    """A visitor picks one of the synthetic customers to file a ticket as."""
    customers = visitor(site_key).get("/api/lb01/customers").json()

    assert customers[0] == {"key": "cus-0001", "name": "Sam Carter", "language": "en"}
    assert len(customers) == Customer.objects.count()


def test_filing_a_ticket_queues_it_once_it_is_saved(
    site_key: Ed25519PrivateKey, queued: list[int], django_capture_on_commit_callbacks: Callable[..., Any]
) -> None:
    """The API answers at once with the received ticket, and hands it to the worker only after the commit."""
    with django_capture_on_commit_callbacks(using="lb01") as waiting_for_commit:
        response = visitor(site_key).post(
            "/api/lb01/tickets",
            {"customer": "cus-0001", "language": "en", "body": "  Where is BB-1041?  "},
            content_type="application/json",
        )
    assert queued == []
    for callback in waiting_for_commit:
        callback()

    assert response.status_code == 202
    body = response.json()
    assert (body["status"], body["body"], body["draft"]) == ("received", "Where is BB-1041?", None)
    ticket = Ticket.objects.get(public_id=body["id"])
    assert ticket.session_key == SAM
    assert queued == [ticket.pk]
    # The run is named from the start, so the Scope can follow it while the worker works.
    assert len(body["run_id"]) >= 8
    assert ticket.run_id == body["run_id"]
    assert visitor(site_key).get(f"/api/lb01/tickets/{body['id']}").json()["run_id"] == body["run_id"]


@pytest.mark.parametrize(
    ("payload", "fields"),
    [
        ({"customer": "cus-0001", "language": "en", "body": "   "}, "body"),
        ({"customer": "cus-0001", "language": "en", "body": "x" * 2_001}, "body"),
        ({"customer": "cus-0001", "language": "de", "body": "Hallo"}, "language"),
        ({"customer": "CUS 1", "language": "en", "body": "Hi"}, "customer"),
    ],
)
def test_a_malformed_ticket_is_refused_without_echoing_it(
    site_key: Ed25519PrivateKey, queued: list[int], payload: dict[str, str], fields: str
) -> None:
    """Empty, oversized or mislabelled tickets get a 422 naming the field, and nothing is queued."""
    response = visitor(site_key).post("/api/lb01/tickets", payload, content_type="application/json")

    assert response.status_code == 422
    assert response.json()["error"]["fields"].endswith(fields)
    assert "Hallo" not in response.content.decode()
    assert queued == []


def test_an_unknown_customer_is_not_found(site_key: Ed25519PrivateKey, queued: list[int]) -> None:
    """Only the synthetic customers can file tickets, and nothing is queued for anyone else."""
    response = visitor(site_key).post(
        "/api/lb01/tickets", {"customer": "cus-9999", "language": "en", "body": "Hi"}, content_type="application/json"
    )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "unknown_customer"
    assert queued == []


def test_a_visitor_may_file_twenty_tickets_a_day(site_key: Ed25519PrivateKey, queued: list[int]) -> None:
    """The twenty-first ticket of the day is refused, and nothing is queued for it."""
    customer = Customer.objects.get(key="cus-0001")
    for _ in range(TICKETS_PER_DAY):
        Ticket.objects.create(session_key=SAM, customer=customer, language="en", body="Hello.")

    response = visitor(site_key).post(
        "/api/lb01/tickets",
        {"customer": "cus-0001", "language": "en", "body": "One more."},
        content_type="application/json",
    )

    assert response.status_code == 429
    assert response.json()["error"]["code"] == "daily_limit"
    assert queued == []


@pytest.mark.django_db(databases=["lb01"], transaction=True)
def test_tickets_filed_at_the_same_moment_cannot_pass_the_daily_limit(
    site_key: Ed25519PrivateKey, queued: list[int], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A visitor with one place left who files eight tickets at once gets that one ticket, not eight.

    Every request is held just before it saves its ticket until all eight have counted what the
    visitor filed, so each sees the same nineteen: the limit holds only if counting and saving are
    one step for a visitor. (When they are, the first request waits alone and the hold times out.)
    """
    customer = Customer.objects.get(key="cus-0001")
    for _ in range(TICKETS_PER_DAY - 1):
        Ticket.objects.create(session_key=SAM, customer=customer, language="en", body="Hello.")
    racers = 8
    monkeypatch.setattr(Ticket.objects, "create", held_until_all_have_counted(Ticket.objects.create, racers))

    def file_one() -> int:
        """File a ticket as the visitor, from a thread of its own."""
        response = visitor(site_key).post(
            "/api/lb01/tickets",
            {"customer": "cus-0001", "language": "en", "body": "One of eight."},
            content_type="application/json",
        )
        return response.status_code

    outcomes = race([file_one for _ in range(racers)])

    assert sorted(str(outcome) for outcome in outcomes) == sorted(["202"] + ["429"] * (racers - 1))
    assert Ticket.objects.filter(session_key=SAM).count() == TICKETS_PER_DAY
    assert len(queued) == 1


def test_a_visitor_sees_only_their_own_tickets(site_key: Ed25519PrivateKey) -> None:
    """Another session's ticket is neither listed nor found, as if it didn't exist."""
    mine = drafted_ticket(SAM)
    theirs = drafted_ticket(SOMEONE_ELSE)
    client = visitor(site_key)

    listed = [ticket["id"] for ticket in client.get("/api/lb01/tickets").json()]
    response = client.get(f"/api/lb01/tickets/{theirs.public_id}")

    assert listed == [mine.public_id]
    assert response.status_code == 404
    assert (
        client.post(
            f"/api/lb01/tickets/{theirs.public_id}/decision", {"action": "approve"}, content_type="application/json"
        ).status_code
        == 404
    )


def test_a_draft_is_shown_with_its_sources_and_its_marked_sentences(site_key: Ed25519PrivateKey) -> None:
    """Each sentence carries its citations and check result; each source comes in the ticket's language."""
    ticket = drafted_ticket()

    draft = visitor(site_key).get(f"/api/lb01/tickets/{ticket.public_id}").json()["draft"]

    assert [sentence["supported"] for sentence in draft["sentences"]] == [True, True, False]
    assert draft["sentences"][2]["problem"] == "states 1, which its sources don't"
    assert draft["sources"][0]["title"] == "Damaged, stale or wrong items §1: Torn or crushed bags"
    assert draft["sources"][1]["title"] == "Order BB-1040"
    assert draft["sources"][1]["text"].startswith("Order BB-1040: delivered.")


def test_a_czech_visitor_reads_the_claim_check_in_czech(site_key: Ed25519PrivateKey) -> None:
    """A stored problem is worded in the ticket's language; an older row without a code keeps its English reason."""
    ticket = drafted_ticket(language="cs")
    Draft.objects.filter(ticket=ticket).update(
        unsupported=[
            {
                "sentence": 1,
                "code": "unstated_numbers",
                "items": ["14"],
                "reason": "states 14, which its sources don't",
            },
            {"sentence": 2, "reason": "states 1, which its sources don't"},
        ]
    )

    sentences = visitor(site_key).get(f"/api/lb01/tickets/{ticket.public_id}").json()["draft"]["sentences"]

    assert sentences[1]["problem"] == "uvádí 14, což jeho zdroje neobsahují"
    assert sentences[2]["problem"] == "states 1, which its sources don't"


def test_an_english_visitor_reads_the_claim_check_in_english(site_key: Ed25519PrivateKey) -> None:
    """The same stored problem reads in English for an English ticket."""
    ticket = drafted_ticket()
    Draft.objects.filter(ticket=ticket).update(
        unsupported=[
            {"sentence": 2, "code": "uncited_fact", "items": [], "reason": "states a fact without citing a source"}
        ]
    )

    sentences = visitor(site_key).get(f"/api/lb01/tickets/{ticket.public_id}").json()["draft"]["sentences"]

    assert sentences[2]["problem"] == "states a fact without citing a source"


def test_a_czech_ticket_shows_its_sources_in_czech(site_key: Ed25519PrivateKey) -> None:
    """A Czech visitor reads the cited passages in Czech."""
    ticket = drafted_ticket(language="cs")

    sources = visitor(site_key).get(f"/api/lb01/tickets/{ticket.public_id}").json()["draft"]["sources"]

    assert sources[0]["title"] == "Poškozené, staré nebo chybné zboží §1: Roztržené nebo zmačkané sáčky"


@pytest.mark.parametrize(
    ("decision", "status", "final_text"),
    [
        ({"action": "approve"}, "sent", "Hello Sam, Send us a photo within 14 days. It was delivered on 1 September."),
        (
            {"action": "edit", "text": "Hello Sam, a new bag is on its way."},
            "sent",
            "Hello Sam, a new bag is on its way.",
        ),
        ({"action": "escalate"}, "escalated", ""),
    ],
)
def test_a_person_decides_a_draft_once(
    site_key: Ed25519PrivateKey, decision: dict[str, str], status: str, final_text: str
) -> None:
    """Approving sends the draft, editing sends new text, escalating sends nothing; a second decision is refused."""
    ticket = drafted_ticket()
    client = visitor(site_key)
    url = f"/api/lb01/tickets/{ticket.public_id}/decision"

    response = client.post(url, decision, content_type="application/json")

    assert response.status_code == 200
    assert response.json()["status"] == status
    assert response.json()["decision"]["final_text"] == final_text
    assert client.post(url, decision, content_type="application/json").status_code == 409


@pytest.mark.parametrize("decision", [{"action": "edit"}, {"action": "approve", "text": "Sneaky text."}])
def test_only_an_edit_carries_text(site_key: Ed25519PrivateKey, decision: dict[str, str]) -> None:
    """An edit needs its text, and an approval can't smuggle one in."""
    ticket = drafted_ticket()

    response = visitor(site_key).post(
        f"/api/lb01/tickets/{ticket.public_id}/decision", decision, content_type="application/json"
    )

    assert response.status_code == 422
    assert not Decision.objects.exists()


def test_a_ticket_without_a_waiting_draft_cant_be_decided(site_key: Ed25519PrivateKey) -> None:
    """A ticket still in the pipeline, or escalated by it, has nothing to approve."""
    ticket = Ticket.objects.create(
        session_key=SAM, customer=Customer.objects.get(key="cus-0001"), language="en", body="Hello."
    )

    response = visitor(site_key).post(
        f"/api/lb01/tickets/{ticket.public_id}/decision", {"action": "approve"}, content_type="application/json"
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "not_waiting"


def test_the_counters_follow_the_visitors_decisions(site_key: Ed25519PrivateKey) -> None:
    """Deflection counts drafts sent rather than escalated; accuracy counts drafts sent without an edit."""
    client = visitor(site_key)
    for decision in (
        {"action": "approve"},
        {"action": "approve"},
        {"action": "edit", "text": "Fixed."},
        {"action": "escalate"},
    ):
        ticket = drafted_ticket()
        client.post(f"/api/lb01/tickets/{ticket.public_id}/decision", decision, content_type="application/json")
    drafted_ticket()
    drafted_ticket(SOMEONE_ELSE)

    stats = client.get("/api/lb01/stats").json()

    assert stats == {
        "tickets": 5,
        "awaiting_approval": 1,
        "sent": 3,
        "sent_unedited": 2,
        "escalated": 1,
        "deflection": 0.75,
        "accuracy": pytest.approx(2 / 3),
    }
