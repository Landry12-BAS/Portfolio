"""Tests for lb01.seed's checks: the real seed files pass, and each rule refuses what it should.

None of these touch the database: the checks run before anything is written.
"""

import re
from copy import deepcopy
from datetime import date
from typing import Any

import pytest
from django.conf import settings
from pydantic import ValidationError

from core.data_files import read_data_file
from lb01.models import Draft
from lb01.seed import (
    CustomerFile,
    OrderEntry,
    OrderFile,
    PolicyFile,
    SeedError,
    check_order_customers,
    day_from,
)

# A valid order to vary: two 250 g bags of Basalt Blend, delivered in Czechia.
DELIVERED_ORDER: dict[str, Any] = {
    "number": "BB-2001",
    "note": "A test order.",
    "customer": "cus-0001",
    "status": "delivered",
    "country": "CZ",
    "placed": -9,
    "roasted": -7,
    "shipped": -6,
    "delivered": -3,
    "carrier": "Vltava Post",
    "tracking_number": "VP123456789CZ",
    "items": [
        {
            "kind": "coffee",
            "product": "Basalt Blend",
            "grind": "whole-bean",
            "grams": 250,
            "quantity": 2,
            "price_czk": 289,
        }
    ],
    "shipping_czk": 89,
    "total_czk": 667,
}
# A grinder on its own: equipment, so it is never roasted.
GRINDER = {"kind": "equipment", "product": "Basalt Hand Grinder", "quantity": 1, "price_czk": 1490}


def order(**changes: Any) -> dict[str, Any]:
    """Return a copy of the valid order with some fields changed; a value of None removes the field."""
    result = deepcopy(DELIVERED_ORDER)
    for name, value in changes.items():
        if value is None:
            result.pop(name, None)
        else:
            result[name] = value
    return result


def problem_with(data: dict[str, Any]) -> str:
    """Validate an order that should fail, and return the error text."""
    with pytest.raises(ValidationError) as error:
        OrderEntry.model_validate(data)
    return str(error.value)


def test_the_seed_files_follow_every_rule() -> None:
    """The committed seed files pass every check, including the references between them."""
    folder = settings.SEED_DIR / "lb01"

    policies = read_data_file(folder / "policies.yaml", PolicyFile)
    customers = read_data_file(folder / "customers.yaml", CustomerFile)
    orders = read_data_file(folder / "orders.yaml", OrderFile)
    check_order_customers(orders, customers)

    assert policies.policies
    assert customers.customers
    assert orders.orders


def test_the_valid_order_is_valid() -> None:
    """The baseline the other tests vary passes on its own."""
    assert OrderEntry.model_validate(order()).total_czk == 667


@pytest.mark.parametrize(
    ("changes", "problem"),
    [
        ({"total_czk": 700}, "the total should be 667 CZK"),
        ({"shipping_czk": 0, "total_czk": 578}, "delivery should cost 89 CZK"),
        ({"country": "SK", "shipping_czk": 89}, "delivery should cost 159 CZK"),
        ({"country": "DE", "shipping_czk": 89}, "delivery should cost 290 CZK"),
        ({"carrier": "Kolo Courier", "country": "SK", "tracking_number": "KC-12345"}, "Czech Republic only"),
        ({"items": [GRINDER], "roasted": None, "shipping_czk": 89, "total_czk": 1579}, "delivery should cost 0 CZK"),
    ],
)
def test_money_follows_the_delivery_cost_policy(changes: dict[str, Any], problem: str) -> None:
    """Delivery costs come from shipping.costs, and totals must add up."""
    assert problem in problem_with(order(**changes))


def test_standard_delivery_is_free_from_1000_czk() -> None:
    """At 1,000 CZK of goods, standard delivery in Czechia costs nothing, and charging for it is refused."""
    big_order = order(
        items=[{**DELIVERED_ORDER["items"][0], "grams": 1000, "quantity": 1, "price_czk": 1000}],
        shipping_czk=0,
        total_czk=1000,
    )

    assert OrderEntry.model_validate(big_order).shipping_czk == 0
    assert "delivery should cost 0 CZK" in problem_with({**big_order, "shipping_czk": 89, "total_czk": 1089})


@pytest.mark.parametrize(
    ("changes", "problem"),
    [
        ({"delivered": None}, "a delivered order needs a delivered date"),
        ({"status": "processing"}, "a processing order can't have a roasted date"),
        ({"status": "shipped"}, "a shipped order can't have a delivered date"),
        ({"shipped": None, "delivered": None, "status": "lost"}, "a lost order needs a shipped date"),
        ({"roasted": None}, "a delivered order needs a roasted date"),
        ({"items": [GRINDER], "shipping_czk": 0, "total_czk": 1490}, "can't have a roasted date"),
        ({"shipped": -10}, "can't ship before it is placed"),
        ({"roasted": -5, "shipped": -6}, "can't ship before it is roasted"),
        ({"delivered": -7}, "can't be delivered before it ships"),
        ({"placed": 1}, "less than or equal to 0"),
    ],
)
def test_dates_follow_the_status_and_each_other(changes: dict[str, Any], problem: str) -> None:
    """Each status needs its dates, equipment is never roasted, and nothing happens out of order."""
    assert problem in problem_with(order(**changes))


def test_coffee_may_be_roasted_before_the_order_ships_from_stock() -> None:
    """A roast date before the order date is allowed: that is how stale coffee reaches a customer."""
    assert OrderEntry.model_validate(order(roasted=-40)).roasted == -40


@pytest.mark.parametrize(
    ("changes", "problem"),
    [
        ({"tracking_number": ""}, "a delivered order needs a tracking number"),
        ({"tracking_number": "VP123"}, "look like VP123456789CZ"),
        (
            {"status": "processing", "roasted": None, "shipped": None, "delivered": None},
            "a processing order has no label yet",
        ),
    ],
)
def test_tracking_numbers_follow_the_carrier(changes: dict[str, Any], problem: str) -> None:
    """Sent parcels carry a tracking number in their carrier's format; unlabelled ones carry none."""
    assert problem in problem_with(order(**changes))


def test_errors_name_the_order() -> None:
    """A rule's message starts with the order number, so a long file's problem is easy to find."""
    assert "BB-2001: the total should be" in problem_with(order(total_czk=1))


def test_an_unknown_field_is_refused() -> None:
    """A misspelt or unquoted field is an error, never dropped: YAML splits `{en: a, b}` at the comma."""
    assert "Extra inputs are not permitted" in problem_with(order(colour="blue"))


def test_a_product_sold_at_two_prices_is_refused() -> None:
    """The same bag of the same coffee costs the same in every order."""
    cheaper = order(
        number="BB-2002",
        items=[{**DELIVERED_ORDER["items"][0], "quantity": 1, "price_czk": 250}],
        total_czk=339,
    )

    with pytest.raises(ValidationError, match="Basalt Blend is sold at two prices"):
        OrderFile.model_validate({"orders": [order(), cheaper]})


def test_order_numbers_are_unique() -> None:
    """Two orders can't share a number."""
    with pytest.raises(ValidationError, match="order number 'BB-2001' appears more than once"):
        OrderFile.model_validate({"orders": [order(), order()]})


def test_passage_keys_belong_to_their_policy_and_are_unique() -> None:
    """A passage key starts with its policy's key, and no key repeats, since citations use them."""
    passage = {"key": "returns.withdrawal", "title": {"en": "T", "cs": "T"}, "text": {"en": "E", "cs": "C"}}
    policy = {"key": "returns", "title": {"en": "Returns", "cs": "Vrácení"}, "passages": [passage]}

    with pytest.raises(ValidationError, match="must start with 'shipping' and a dot"):
        PolicyFile.model_validate({"policies": [{**policy, "key": "shipping"}]})
    with pytest.raises(ValidationError, match=re.escape("passage key 'returns.withdrawal' appears more than once")):
        PolicyFile.model_validate({"policies": [{**policy, "passages": [passage, passage]}]})


def test_a_passage_needs_both_languages() -> None:
    """A passage without its Czech text is refused."""
    passage = {"key": "returns.withdrawal", "title": {"en": "T", "cs": "T"}, "text": {"en": "English only"}}

    with pytest.raises(ValidationError, match=re.escape("text.cs")):
        PolicyFile.model_validate(
            {"policies": [{"key": "returns", "title": {"en": "R", "cs": "V"}, "passages": [passage]}]}
        )


@pytest.mark.parametrize("email", ["sam.carter@gmail.com", "sam@example.com", "Sam@example.test"])
def test_customer_emails_use_only_the_reserved_test_domain(email: str) -> None:
    """A seeded address can never reach a real inbox."""
    customer = {"key": "cus-0001", "name": "Sam Carter", "email": email, "language": "en"}

    with pytest.raises(ValidationError, match="email"):
        CustomerFile.model_validate({"customers": [customer]})


def test_an_order_for_an_unknown_customer_is_refused() -> None:
    """Orders may belong only to customers in customers.yaml."""
    customers = CustomerFile.model_validate(
        {"customers": [{"key": "cus-0002", "name": "Priya Nair", "email": "priya@example.test", "language": "en"}]}
    )

    with pytest.raises(SeedError, match=re.escape("BB-2001 belongs to cus-0001, who isn't in customers.yaml")):
        check_order_customers(OrderFile.model_validate({"orders": [order()]}), customers)


def test_relative_days_become_dates() -> None:
    """0 is the seed's today, negative days come before it, and no date stays no date."""
    today = date(2026, 10, 1)

    assert day_from(today, 0) == today
    assert day_from(today, -3) == date(2026, 9, 28)
    assert day_from(today, None) is None


def test_a_draft_reads_as_one_paragraph() -> None:
    """A draft's text joins its sentences and leaves the citations out."""
    draft = Draft(
        sentences=[
            {"text": "Sorry about the bag.", "citations": ["passage:damaged.torn-bags"]},
            {"text": "A new one is on its way.", "citations": []},
        ]
    )

    assert draft.text() == "Sorry about the bag. A new one is on its way."
