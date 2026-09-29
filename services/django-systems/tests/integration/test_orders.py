"""Integration tests for the order-lookup tool: it tells a customer about their own orders and nothing else."""

from datetime import date

import pytest
from django.conf import settings

from lb01.models import Customer
from lb01.orders import look_up_order
from lb01.seed import seed

pytestmark = [pytest.mark.integration, pytest.mark.django_db(databases=["lb01"])]


@pytest.fixture(autouse=True)
def seeded() -> None:
    """Load the synthetic customers and orders, with dates counted from 1 October 2026."""
    seed(settings.SEED_DIR / "lb01", date(2026, 10, 1))


def test_a_customers_own_order_is_described_in_full() -> None:
    """Status, dates, carrier, tracking, lines and money all appear, in one fixed form."""
    lookup = look_up_order("BB-1040", Customer.objects.get(key="cus-0001"))

    assert lookup.found
    assert lookup.source_id == "order:BB-1040"
    assert lookup.facts == (
        "Order BB-1040: delivered. "
        "Dates: placed 2026-09-22, roasted 2026-09-24, shipped 2026-09-25, delivered 2026-09-28. "
        "Ships to CZ with Vltava Post, tracking number VP481920337CZ. "
        "Items: 2 x Basalt Blend, whole-bean, 250 g, at 289 CZK each. "
        "Delivery 89 CZK. Total 667 CZK."
    )


def test_equipment_is_described_without_grind_or_weight() -> None:
    """A grinder has no grind and no bag size."""
    lookup = look_up_order("BB-1049", Customer.objects.get(key="cus-0005"))

    assert "Items: 1 x Basalt Hand Grinder, at 1490 CZK each." in lookup.facts


def test_another_customers_order_looks_exactly_like_a_missing_one() -> None:
    """A ticket learns nothing about someone else's order, not even that it exists."""
    sam = Customer.objects.get(key="cus-0001")

    someone_elses = look_up_order("BB-1049", sam)
    missing = look_up_order("BB-9999", sam)

    assert not someone_elses.found
    assert someone_elses.facts == "Order BB-1049 is not on this customer's account."
    assert missing.facts.replace("BB-9999", "BB-1049") == someone_elses.facts
