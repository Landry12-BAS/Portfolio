"""Integration tests for LB-01's schema on a real Postgres: where things live, and what the database refuses."""

from datetime import timedelta

import pytest
from django.contrib.postgres.search import SearchQuery
from django.db import DatabaseError, IntegrityError, connections, transaction
from django.test import Client
from django.utils import timezone

from core.extensions import CHECK_PGVECTOR_SCHEMA
from lb01.models import MAX_TICKET_LENGTH, Customer, Decision, Policy, PolicyPassage, Ticket

pytestmark = [pytest.mark.integration, pytest.mark.django_db(databases=["lb01"])]


def query_lb01(sql: str) -> list[tuple[object, ...]]:
    """Run a fixed query on LB-01's connection and return every row."""
    with connections["lb01"].cursor() as cursor:
        cursor.execute(sql)
        return list(cursor.fetchall())


@pytest.fixture
def customer() -> Customer:
    """Make a synthetic customer to file tickets as."""
    return Customer.objects.create(key="cus-9001", name="Test Customer", email="test@example.test", language="en")


@pytest.fixture
def ticket(customer: Customer) -> Ticket:
    """File a short ticket."""
    return Ticket.objects.create(session_key="a" * 64, customer=customer, language="en", body="My bag arrived torn.")


def test_lb01_tables_live_only_in_the_lb01_schema() -> None:
    """Every LB-01 table, and LB-01's own migration history, sit in schema lb01 and nowhere else."""
    rows = query_lb01(
        "SELECT table_schema, table_name FROM information_schema.tables"
        " WHERE table_name LIKE 'lb01%' OR table_name = 'django_migrations'"
    )

    assert {schema for schema, _ in rows} == {"lb01"}
    assert {"lb01_ticket", "lb01_policypassage", "lb01_order", "django_migrations"} <= {name for _, name in rows}


def test_pgvector_lives_in_the_shared_extensions_schema() -> None:
    """The extension sits where every system's search_path can see it."""
    assert query_lb01("SELECT extnamespace::regnamespace::text FROM pg_extension WHERE extname = 'vector'") == [
        ("extensions",)
    ]


def test_the_migration_stops_when_pgvector_lives_elsewhere() -> None:
    """With pgvector installed outside `extensions`, the migration's first step fails with the fix in its hint."""
    with connections["lb01"].cursor() as cursor:
        # Undone with the rest of the test's transaction.
        cursor.execute("ALTER EXTENSION vector SET SCHEMA public")
        with pytest.raises(DatabaseError, match="outside the extensions schema"), transaction.atomic(using="lb01"):
            cursor.execute(CHECK_PGVECTOR_SCHEMA)


def test_keyword_search_follows_the_english_text() -> None:
    """The generated search column stems the English title and text, and follows every edit."""
    policy = Policy.objects.create(key="damaged", title_en="Damaged items", title_cs="Poškozené zboží", position=1)
    passage = PolicyPassage.objects.create(
        key="damaged.torn-bags",
        policy=policy,
        position=1,
        title_en="Torn bags",
        title_cs="Roztržené sáčky",
        text_en="If a bag arrives torn, we send a replacement.",
        text_cs="Pokud sáček dorazí roztržený, pošleme náhradu.",
    )

    def found(words: str) -> bool:
        """Tell whether a keyword search for `words` finds the passage."""
        return PolicyPassage.objects.filter(search=SearchQuery(words, config="english")).exists()

    assert found("bags arriving")
    assert not found("refund")

    passage.text_en = "If a bag arrives torn, we refund it."
    passage.save()

    assert found("refunds")


def test_a_passage_stores_a_1024_dimension_embedding() -> None:
    """Embeddings from bge-m3 fit the vector column, and nearest-neighbour search can use them."""
    policy = Policy.objects.create(key="coffee", title_en="Our coffee", title_cs="Naše káva", position=1)
    PolicyPassage.objects.create(
        key="coffee.storage",
        policy=policy,
        position=1,
        title_en="Storage",
        title_cs="Skladování",
        text_en="Keep coffee dry.",
        text_cs="Kávu skladujte v suchu.",
        embedding=[0.5] * 1024,
    )

    stored = PolicyPassage.objects.get(key="coffee.storage").embedding

    assert stored is not None
    assert len(stored) == 1024


@pytest.mark.parametrize("length", [0, MAX_TICKET_LENGTH + 1])
def test_the_database_refuses_an_empty_or_oversized_ticket(customer: Customer, length: int) -> None:
    """The length rule holds even for writes that skip the API's validation."""
    with pytest.raises(IntegrityError, match="lb01_ticket_body_length"), transaction.atomic(using="lb01"):
        Ticket.objects.create(session_key="a" * 64, customer=customer, language="en", body="x" * length)


def test_the_longest_allowed_ticket_is_accepted(customer: Customer) -> None:
    """A ticket of exactly the maximum length is stored."""
    assert Ticket.objects.create(session_key="a" * 64, customer=customer, language="en", body="x" * MAX_TICKET_LENGTH)


@pytest.mark.parametrize(
    ("action", "final_text"),
    [("approve", ""), ("edit", ""), ("escalate", "A reply that should never be sent.")],
)
def test_a_decision_sends_text_exactly_when_it_isnt_an_escalation(ticket: Ticket, action: str, final_text: str) -> None:
    """An approval or an edit must carry the reply; an escalation must carry none."""
    with pytest.raises(IntegrityError, match="lb01_decision_text_when_sent"), transaction.atomic(using="lb01"):
        Decision.objects.create(ticket=ticket, action=action, final_text=final_text)


def test_valid_decisions_are_stored(customer: Customer) -> None:
    """An approval with its text and an escalation without text are both accepted."""
    first = Ticket.objects.create(session_key="a" * 64, customer=customer, language="en", body="One.")
    second = Ticket.objects.create(session_key="a" * 64, customer=customer, language="en", body="Two.")

    assert Decision.objects.create(ticket=first, action="approve", final_text="Your replacement is on its way.")
    assert Decision.objects.create(ticket=second, action="escalate", final_text="")


def test_a_ticket_gets_an_unguessable_id_and_expires_after_24_hours(customer: Customer) -> None:
    """Public IDs are random, and visitor data is due for deletion a day after it arrives."""
    before = timezone.now()
    first = Ticket.objects.create(session_key="a" * 64, customer=customer, language="en", body="One.")
    second = Ticket.objects.create(session_key="a" * 64, customer=customer, language="en", body="Two.")

    assert first.public_id != second.public_id
    assert len(first.public_id) == 16
    assert before + timedelta(hours=24) <= first.expires_at <= timezone.now() + timedelta(hours=24)


def test_readiness_reports_each_system(client: Client) -> None:
    """With its schema reachable, every system reports ready."""
    response = client.get("/api/readyz")

    assert response.status_code == 200
    assert response.json() == {"lb01": True}
