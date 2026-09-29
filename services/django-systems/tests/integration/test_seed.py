"""Integration tests for LB-01's seed: it loads the files, is idempotent, and never loses data silently."""

import re
from collections.abc import Callable
from datetime import date, timedelta
from io import StringIO
from pathlib import Path
from shutil import copytree
from typing import Any

import pytest
import yaml
from django.conf import settings
from django.core.management import CommandError, call_command

from core.data_files import read_data_file
from lb01.embeddings import (
    EmbeddingFile,
    RecordedVector,
    encode_vector,
    passage_text,
    text_sha256,
    write_embedding_file,
)
from lb01.models import EMBEDDING_DIMENSIONS, Customer, Order, Policy, PolicyPassage, Ticket
from lb01.seed import CustomerFile, OrderFile, PolicyFile, SeedError, seed

pytestmark = [pytest.mark.integration, pytest.mark.django_db(databases=["lb01"])]

# The day the tests' relative order dates count from.
TODAY = date(2026, 10, 1)
SEED_FILES = settings.SEED_DIR / "lb01"


@pytest.fixture
def seed_copy(tmp_path: Path) -> Path:
    """Copy the seed files, so a test can edit them."""
    return copytree(SEED_FILES, tmp_path / "lb01")


def edit(path: Path, change: Callable[[dict[str, Any]], None]) -> None:
    """Load a YAML seed file, let `change` edit it in place, and write it back."""
    content = yaml.safe_load(path.read_text(encoding="utf-8"))
    change(content)
    path.write_text(yaml.safe_dump(content, allow_unicode=True, sort_keys=False), encoding="utf-8")


def test_seeding_loads_every_file() -> None:
    """Every policy, passage, customer and order in the files ends up in the tables."""
    policies = read_data_file(SEED_FILES / "policies.yaml", PolicyFile).policies
    customers = read_data_file(SEED_FILES / "customers.yaml", CustomerFile).customers
    orders = read_data_file(SEED_FILES / "orders.yaml", OrderFile).orders

    report = seed(SEED_FILES, TODAY)

    passage_count = sum(len(policy.passages) for policy in policies)
    assert (report.policies.created, report.passages.created) == (len(policies), passage_count)
    assert (report.customers.created, report.orders.created) == (len(customers), len(orders))
    assert Policy.objects.count() == len(policies)
    assert PolicyPassage.objects.count() == passage_count
    assert Customer.objects.count() == len(customers)
    assert Order.objects.count() == len(orders)


def test_seeding_twice_changes_nothing() -> None:
    """The second run finds every row already as the files say."""
    seed(SEED_FILES, TODAY)

    again = seed(SEED_FILES, TODAY)

    for table in (again.policies, again.passages, again.customers, again.orders):
        assert (table.created, table.updated, table.deleted) == (0, 0, 0)


def test_orders_are_stored_as_the_file_says_with_dates_from_today() -> None:
    """Relative days become dates counted from the given day, and lines and money are kept exactly."""
    entry = read_data_file(SEED_FILES / "orders.yaml", OrderFile).orders[0]

    seed(SEED_FILES, TODAY)
    order = Order.objects.select_related("customer").get(number=entry.number)

    assert order.customer.key == entry.customer
    assert order.placed_on == TODAY + timedelta(days=entry.placed)
    assert order.delivered_on == (None if entry.delivered is None else TODAY + timedelta(days=entry.delivered))
    assert order.items == [line.model_dump() for line in entry.items]
    assert order.total_czk == entry.total_czk


def test_passages_keep_their_policy_and_order() -> None:
    """Each passage belongs to its policy, numbered from 1 in the file's order."""
    first_policy = read_data_file(SEED_FILES / "policies.yaml", PolicyFile).policies[0]

    seed(SEED_FILES, TODAY)

    stored = PolicyPassage.objects.filter(policy__key=first_policy.key).order_by("position")
    assert [passage.key for passage in stored] == [passage.key for passage in first_policy.passages]
    assert [passage.position for passage in stored] == list(range(1, len(first_policy.passages) + 1))


def record_vectors_for(folder: Path) -> None:
    """Write an embeddings.json in `folder`, with a distinct vector for each passage's current text."""
    policies = read_data_file(folder / "policies.yaml", PolicyFile).policies
    passages = [passage for policy in policies for passage in policy.passages]
    vectors = {}
    for number, passage in enumerate(passages):
        vector = [0.0] * EMBEDDING_DIMENSIONS
        vector[number] = 1.0
        vectors[passage.key] = RecordedVector(
            text_sha256=text_sha256(passage_text(passage.title.en, passage.text.en)), vector=encode_vector(vector)
        )
    write_embedding_file(folder / "embeddings.json", EmbeddingFile(vectors=vectors))


def test_passages_get_the_vectors_recorded_for_their_text(seed_copy: Path) -> None:
    """With a vector recorded for every passage, search can use all of them."""
    record_vectors_for(seed_copy)

    report = seed(seed_copy, TODAY)

    assert report.passages_waiting == 0
    assert report.vectors_changed == PolicyPassage.objects.count()
    assert not PolicyPassage.objects.filter(embedding__isnull=True).exists()


def test_without_recorded_vectors_every_passage_waits(seed_copy: Path) -> None:
    """Before the first `just embed`, passages are stored without vectors and found by keywords."""
    (seed_copy / "embeddings.json").unlink(missing_ok=True)

    report = seed(seed_copy, TODAY)

    assert report.passages_waiting == PolicyPassage.objects.count()
    assert not PolicyPassage.objects.filter(embedding__isnull=False).exists()


def test_a_passage_whose_english_text_changed_waits_for_a_new_vector(seed_copy: Path) -> None:
    """An edit to the English text retires its vector; an edit to the Czech text keeps it."""
    record_vectors_for(seed_copy)
    seed(seed_copy, TODAY)
    reworded: list[str] = []

    def reword(content: dict[str, Any]) -> None:
        """Change the English text of the first passage and the Czech text of the second."""
        passages = content["policies"][0]["passages"]
        passages[0]["text"]["en"] += " Reworded."
        passages[1]["text"]["cs"] += " Přeformulováno."
        reworded.append(passages[0]["key"])

    edit(seed_copy / "policies.yaml", reword)
    report = seed(seed_copy, TODAY)

    assert report.passages.updated == 2
    assert (report.vectors_changed, report.passages_waiting) == (1, 1)
    assert list(PolicyPassage.objects.filter(embedding__isnull=True).values_list("key", flat=True)) == reworded


def test_a_passage_removed_from_the_file_is_deleted(seed_copy: Path) -> None:
    """Retrieval never serves a passage that is no longer policy."""
    seed(seed_copy, TODAY)
    removed: list[str] = []

    def remove_first_passage(content: dict[str, Any]) -> None:
        """Drop the first passage of the first policy."""
        removed.append(content["policies"][0]["passages"].pop(0)["key"])

    edit(seed_copy / "policies.yaml", remove_first_passage)
    report = seed(seed_copy, TODAY)

    assert report.passages.deleted == 1
    assert not PolicyPassage.objects.filter(key=removed[0]).exists()


def test_a_customer_with_tickets_is_never_removed(seed_copy: Path) -> None:
    """Removing a customer who still has tickets stops the seed, and nothing is half-applied."""
    seed(seed_copy, TODAY)
    customer = Customer.objects.get(key="cus-0001")
    Ticket.objects.create(session_key="a" * 64, customer=customer, language="en", body="Where is my order?")

    def drop_customer(content: dict[str, Any]) -> None:
        """Remove cus-0001 from customers.yaml."""
        content["customers"] = [entry for entry in content["customers"] if entry["key"] != "cus-0001"]

    def drop_orders(content: dict[str, Any]) -> None:
        """Remove cus-0001's orders from orders.yaml."""
        content["orders"] = [entry for entry in content["orders"] if entry["customer"] != "cus-0001"]

    edit(seed_copy / "customers.yaml", drop_customer)
    edit(seed_copy / "orders.yaml", drop_orders)
    orders_before = Order.objects.count()

    with pytest.raises(SeedError, match="still has tickets"):
        seed(seed_copy, TODAY)

    assert Customer.objects.filter(key="cus-0001").exists()
    assert Order.objects.count() == orders_before


def test_the_command_prints_what_changed() -> None:
    """`seed_lb01` reports each table and the day its dates count from."""
    output = StringIO()

    call_command("seed_lb01", "--today", TODAY.isoformat(), stdout=output)

    assert "Orders: " in output.getvalue()
    assert f"order dates counted from {TODAY}" in output.getvalue()
    assert Order.objects.exists()


def test_the_command_reports_a_broken_file(seed_copy: Path) -> None:
    """A rule broken in a seed file stops the command with the file's name, and writes nothing."""
    edit(seed_copy / "orders.yaml", lambda content: content["orders"][0].update(total_czk=1))

    with pytest.raises(CommandError, match=re.escape("orders.yaml doesn't follow its schema")):
        call_command("seed_lb01", "--data", str(seed_copy), stdout=StringIO())

    assert not Order.objects.exists()
