"""Loads LB-01's synthetic data from data/seed/lb01 into the lb01 schema.

The seed files are the source of truth: seeding makes the policy, customer and order
tables match them, and running it twice changes nothing. Every file is checked against
the schemas below before anything is written, so a typo stops the seed with a message
naming the file and the field instead of reaching a demo. The checks also hold the data
to the written policies: a delivery cost or an order total that contradicts
policies.yaml is refused, because drafts cite both side by side. Visitor tickets are
never touched.
"""

import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Annotated, Any, Literal, Self

from django.db import models, transaction
from django.db.models import ProtectedError
from pydantic import Field, StringConstraints, model_validator

from core.data_files import Key, StrictEntry, Text, read_data_file
from lb01.embeddings import EmbeddingFile, passage_text, read_embedding_file
from lb01.models import Customer, Order, Policy, PolicyPassage

# A policy title or passage, trimmed, never empty, and short enough to cite precisely.
PolicyText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1_200)]
# A day relative to the seed's "today": 0 is today, -3 three days before. Never in the future.
RelativeDay = Annotated[int, Field(ge=-365, le=0)]
# The grinds Basalt & Bean sells (the coffee.grinds passage).
Grind = Literal["whole-bean", "espresso", "moka", "filter", "french-press", "cold-brew"]
# The two fictional carriers.
Carrier = Literal["Vltava Post", "Kolo Courier"]


@dataclass(frozen=True)
class TrackingFormat:
    """What a carrier's tracking numbers look like, as a pattern and as an example for error messages."""

    pattern: re.Pattern[str]
    example: str


TRACKING_FORMATS = {
    "Vltava Post": TrackingFormat(re.compile(r"VP\d{9}CZ"), "VP123456789CZ"),
    "Kolo Courier": TrackingFormat(re.compile(r"KC-\d{5}"), "KC-12345"),
}

# Delivery costs from the shipping.costs passage, in whole crowns.
STANDARD_DELIVERY_CZK = 89
FREE_DELIVERY_FROM_CZK = 1_000
COURIER_DELIVERY_CZK = 149
SLOVAKIA_DELIVERY_CZK = 159
EU_DELIVERY_CZK = 290

# The dates each order status needs (True) or rules out (False). Where the table is
# silent about the roast date, the order's contents decide (check_status_dates).
STATUS_DATES: dict[str, dict[str, bool]] = {
    Order.Status.PROCESSING: {"roasted": False, "shipped": False, "delivered": False},
    Order.Status.ROASTED: {"roasted": True, "shipped": False, "delivered": False},
    Order.Status.SHIPPED: {"shipped": True, "delivered": False},
    Order.Status.DELIVERED: {"shipped": True, "delivered": True},
    Order.Status.LOST: {"shipped": True, "delivered": False},
    Order.Status.CANCELLED: {"roasted": False, "shipped": False, "delivered": False},
}
# Statuses whose parcel has left the roastery, so it must have a tracking number. A
# roasted order may already have one: it is packed and labelled, waiting for the carrier.
SENT_STATUSES = frozenset({Order.Status.SHIPPED, Order.Status.DELIVERED, Order.Status.LOST})


class SeedError(Exception):
    """The seed files contradict each other, or seeding would lose a visitor's data."""


class Translated(StrictEntry):
    """A text in both of the site's languages."""

    en: PolicyText
    cs: PolicyText


class PassageEntry(StrictEntry):
    """One citable passage, as policies.yaml writes it."""

    key: Key
    title: Translated
    text: Translated


class PolicyEntry(StrictEntry):
    """One policy and its passages, in the order the policy page shows them."""

    key: Key
    title: Translated
    passages: list[PassageEntry] = Field(min_length=1)

    @model_validator(mode="after")
    def _check_passage_keys(self) -> Self:
        """Require every passage key to start with its policy's key, as in `returns.withdrawal`."""
        for passage in self.passages:
            if not passage.key.startswith(f"{self.key}."):
                raise ValueError(f"passage {passage.key!r} must start with {self.key!r} and a dot")
        return self


class PolicyFile(StrictEntry):
    """The whole of policies.yaml."""

    policies: list[PolicyEntry] = Field(min_length=1)

    @model_validator(mode="after")
    def _check_unique_keys(self) -> Self:
        """Refuse a policy or passage key used twice, since citations name passages by key."""
        require_unique([policy.key for policy in self.policies], "policy key")
        require_unique([passage.key for policy in self.policies for passage in policy.passages], "passage key")
        return self


class CustomerEntry(StrictEntry):
    """One synthetic customer."""

    key: Key
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
    # Only the reserved .test domain, so a seeded address can never reach a real inbox.
    email: Annotated[str, StringConstraints(pattern=r"^[a-z0-9]+(?:\.[a-z0-9]+)*@example\.test$")]
    language: Literal["en", "cs"]


class CustomerFile(StrictEntry):
    """The whole of customers.yaml."""

    customers: list[CustomerEntry] = Field(min_length=1)

    @model_validator(mode="after")
    def _check_unique_customers(self) -> Self:
        """Refuse a customer key or email address used twice."""
        require_unique([customer.key for customer in self.customers], "customer key")
        require_unique([customer.email for customer in self.customers], "customer email")
        return self


class CoffeeLine(StrictEntry):
    """An order line for coffee: which one, how it is ground, and the bag size."""

    kind: Literal["coffee"]
    product: Annotated[str, StringConstraints(min_length=1, max_length=60)]
    grind: Grind
    grams: Literal[250, 1_000]
    quantity: int = Field(ge=1, le=10)
    price_czk: int = Field(ge=1)


class EquipmentLine(StrictEntry):
    """An order line for brewing equipment."""

    kind: Literal["equipment"]
    product: Annotated[str, StringConstraints(min_length=1, max_length=60)]
    quantity: int = Field(ge=1, le=10)
    price_czk: int = Field(ge=1)


# One line of an order; `kind` says which of the two it is.
OrderLine = Annotated[CoffeeLine | EquipmentLine, Field(discriminator="kind")]


class OrderEntry(StrictEntry):
    """One synthetic order, with its dates relative to the seed's "today"."""

    number: Annotated[str, StringConstraints(pattern=r"^BB-\d{4}$")]
    # The scenario the order exists for. It is for people reading the file and is never
    # loaded, so no model ever sees the answer it hints at.
    note: Text
    customer: Key
    status: Order.Status
    country: Annotated[str, StringConstraints(pattern=r"^[A-Z]{2}$")]
    placed: RelativeDay
    roasted: RelativeDay | None = None
    shipped: RelativeDay | None = None
    delivered: RelativeDay | None = None
    carrier: Carrier
    tracking_number: Annotated[str, StringConstraints(max_length=40)] = ""
    items: list[OrderLine] = Field(min_length=1)
    shipping_czk: int = Field(ge=0)
    total_czk: int = Field(ge=1)

    @model_validator(mode="after")
    def _check_order(self) -> Self:
        """Hold the order to its status, its dates, its tracking number and the delivery-cost policy."""
        try:
            check_status_dates(self)
            check_date_order(self)
            check_tracking_number(self)
            check_money(self)
        except ValueError as error:
            raise ValueError(f"{self.number}: {error}") from None
        return self

    def has_coffee(self) -> bool:
        """Tell whether any line is coffee, which is what gets roasted."""
        return any(line.kind == "coffee" for line in self.items)

    def items_czk(self) -> int:
        """Add up the lines, before delivery."""
        return sum(line.price_czk * line.quantity for line in self.items)


class OrderFile(StrictEntry):
    """The whole of orders.yaml."""

    orders: list[OrderEntry] = Field(min_length=1)

    @model_validator(mode="after")
    def _check_orders(self) -> Self:
        """Refuse a repeated order number, and a product sold at two prices."""
        require_unique([order.number for order in self.orders], "order number")
        check_consistent_prices(self.orders)
        return self


def require_unique(values: list[str], what: str) -> None:
    """Raise if any value appears more than once, naming the first repeat."""
    seen: set[str] = set()
    for value in values:
        if value in seen:
            raise ValueError(f"{what} {value!r} appears more than once")
        seen.add(value)


def check_status_dates(order: OrderEntry) -> None:
    """Require the dates the order's status implies, and refuse the ones it rules out."""
    rules = dict(STATUS_DATES[order.status])
    # Only coffee is roasted: an order of equipment alone never has a roast date, and an
    # order with coffee in it has one once it has been sent.
    if not order.has_coffee():
        rules["roasted"] = False
    elif order.status in SENT_STATUSES:
        rules["roasted"] = True
    for name, needed in rules.items():
        present = getattr(order, name) is not None
        if needed and not present:
            raise ValueError(f"a {order.status} order needs a {name} date")
        if present and not needed:
            raise ValueError(f"a {order.status} order can't have a {name} date")


def check_date_order(order: OrderEntry) -> None:
    """Refuse dates out of sequence. Roasting may come before the order: coffee can ship from stock."""
    if order.shipped is not None:
        if order.shipped < order.placed:
            raise ValueError("an order can't ship before it is placed")
        if order.roasted is not None and order.shipped < order.roasted:
            raise ValueError("an order can't ship before it is roasted")
    if order.delivered is not None and order.shipped is not None and order.delivered < order.shipped:
        raise ValueError("an order can't be delivered before it ships")


def check_tracking_number(order: OrderEntry) -> None:
    """Require a tracking number, in the carrier's format, once the parcel has been sent."""
    if order.status in SENT_STATUSES and not order.tracking_number:
        raise ValueError(f"a {order.status} order needs a tracking number")
    if order.status not in SENT_STATUSES | {Order.Status.ROASTED} and order.tracking_number:
        raise ValueError(f"a {order.status} order has no label yet, so it can't have a tracking number")
    tracking = TRACKING_FORMATS[order.carrier]
    if order.tracking_number and not tracking.pattern.fullmatch(order.tracking_number):
        raise ValueError(f"{order.carrier} tracking numbers look like {tracking.example}")


def check_money(order: OrderEntry) -> None:
    """Require the delivery cost from the shipping.costs passage, and a total that adds up."""
    expected = delivery_cost(order.carrier, order.country, order.items_czk())
    if order.shipping_czk != expected:
        raise ValueError(f"delivery should cost {expected} CZK under shipping.costs, not {order.shipping_czk}")
    if order.total_czk != order.items_czk() + order.shipping_czk:
        raise ValueError(f"the total should be {order.items_czk() + order.shipping_czk} CZK, not {order.total_czk}")


def delivery_cost(carrier: str, country: str, items_czk: int) -> int:
    """Return what delivery costs under the shipping.costs passage; the courier rides in Czechia only."""
    if carrier == "Kolo Courier":
        if country != "CZ":
            raise ValueError("Kolo Courier delivers in the Czech Republic only")
        return COURIER_DELIVERY_CZK
    if country == "CZ":
        return 0 if items_czk >= FREE_DELIVERY_FROM_CZK else STANDARD_DELIVERY_CZK
    if country == "SK":
        return SLOVAKIA_DELIVERY_CZK
    return EU_DELIVERY_CZK


def check_consistent_prices(orders: Iterable[OrderEntry]) -> None:
    """Refuse a product that costs one price in one order and another elsewhere."""
    prices: dict[tuple[str, int | None], int] = {}
    for order in orders:
        for line in order.items:
            product = (line.product, line.grams if isinstance(line, CoffeeLine) else None)
            if prices.setdefault(product, line.price_czk) != line.price_czk:
                raise ValueError(f"{line.product} is sold at two prices ({order.number})")


@dataclass
class TableChanges:
    """How many rows of one table a seed run created, updated and deleted."""

    created: int = 0
    updated: int = 0
    deleted: int = 0

    def count(self, change: str) -> None:
        """Count one row's change: "created", "updated" or "unchanged"."""
        if change == "created":
            self.created += 1
        elif change == "updated":
            self.updated += 1

    def describe(self) -> str:
        """Put the counts in words, such as "2 created, 1 updated, 0 deleted"."""
        return f"{self.created} created, {self.updated} updated, {self.deleted} deleted"


@dataclass
class SeedReport:
    """What a seed run changed, table by table."""

    policies: TableChanges = field(default_factory=TableChanges)
    passages: TableChanges = field(default_factory=TableChanges)
    customers: TableChanges = field(default_factory=TableChanges)
    orders: TableChanges = field(default_factory=TableChanges)
    # Passages whose vector was set, replaced or removed, and those still without one.
    vectors_changed: int = 0
    passages_waiting: int = 0

    def lines(self) -> list[str]:
        """Describe the run, one table per line, for the seed command to print."""
        return [
            f"Policies: {self.policies.describe()}",
            f"Passages: {self.passages.describe()}",
            f"Passage vectors: {self.vectors_changed} changed, {self.passages_waiting} waiting for `just embed`",
            f"Customers: {self.customers.describe()}",
            f"Orders: {self.orders.describe()}",
        ]


def seed(directory: Path, today: date) -> SeedReport:
    """Check the seed files in `directory`, then make the lb01 tables match them in one transaction.

    `today` is the day the orders' relative dates count from. The passages' vectors come
    from embeddings.json, when it has one for a passage's current text. A file that
    doesn't follow its schema raises core.data_files.DataFileError; files that
    contradict each other, or a customer removed while their tickets remain, raise
    SeedError.
    """
    policy_file = read_data_file(directory / "policies.yaml", PolicyFile)
    customer_file = read_data_file(directory / "customers.yaml", CustomerFile)
    order_file = read_data_file(directory / "orders.yaml", OrderFile)
    recorded_vectors = read_embedding_file(directory / "embeddings.json")
    check_order_customers(order_file, customer_file)

    report = SeedReport()
    try:
        with transaction.atomic(using="lb01"):
            sync_policies(policy_file, report)
            sync_passage_vectors(recorded_vectors, report)
            customer_ids = sync_customers(customer_file, report)
            sync_orders(order_file, customer_ids, today, report)
            delete_missing_customers(customer_file, report)
    except ProtectedError as error:
        tickets = sorted({str(row) for row in error.protected_objects})
        raise SeedError(f"A customer removed from customers.yaml still has tickets: {', '.join(tickets)}") from None
    return report


def check_order_customers(order_file: OrderFile, customer_file: CustomerFile) -> None:
    """Refuse an order whose customer isn't in customers.yaml."""
    known = {customer.key for customer in customer_file.customers}
    for order in order_file.orders:
        if order.customer not in known:
            raise SeedError(f"Order {order.number} belongs to {order.customer}, who isn't in customers.yaml.")


def sync_policies(policy_file: PolicyFile, report: SeedReport) -> None:
    """Make the policies and their passages match the file."""
    for policy_position, policy_entry in enumerate(policy_file.policies, start=1):
        change, policy = upsert(
            Policy,
            {"key": policy_entry.key},
            {"title_en": policy_entry.title.en, "title_cs": policy_entry.title.cs, "position": policy_position},
        )
        report.policies.count(change)
        for position, entry in enumerate(policy_entry.passages, start=1):
            change, _ = upsert(
                PolicyPassage,
                {"key": entry.key},
                {
                    "policy_id": policy.pk,
                    "position": position,
                    "title_en": entry.title.en,
                    "title_cs": entry.title.cs,
                    "text_en": entry.text.en,
                    "text_cs": entry.text.cs,
                },
            )
            report.passages.count(change)
    wanted_passages = [passage.key for policy in policy_file.policies for passage in policy.passages]
    report.passages.deleted = delete_rows_except(PolicyPassage.objects.all(), "key", wanted_passages)
    report.policies.deleted = delete_rows_except(
        Policy.objects.all(), "key", [policy.key for policy in policy_file.policies]
    )


def sync_passage_vectors(recorded: EmbeddingFile | None, report: SeedReport) -> None:
    """Give each passage the recorded vector made from its current English text, or none until one is recorded.

    A passage without a vector is still found by its keywords; `just embed` records the
    vectors that are missing.
    """
    for passage in PolicyPassage.objects.only("key", "title_en", "text_en", "embedding"):
        text = passage_text(passage.title_en, passage.text_en)
        wanted = recorded.vector_for(passage.key, text) if recorded is not None else None
        current = None if passage.embedding is None else [float(value) for value in passage.embedding]
        if current != wanted:
            passage.embedding = wanted
            passage.save(update_fields=["embedding"])
            report.vectors_changed += 1
        if wanted is None:
            report.passages_waiting += 1


def sync_customers(customer_file: CustomerFile, report: SeedReport) -> dict[str, int]:
    """Create or update every customer in the file, and return each one's row ID by key."""
    customer_ids: dict[str, int] = {}
    for entry in customer_file.customers:
        change, customer = upsert(
            Customer,
            {"key": entry.key},
            {"name": entry.name, "email": entry.email, "language": entry.language},
        )
        report.customers.count(change)
        customer_ids[entry.key] = customer.pk
    return customer_ids


def sync_orders(order_file: OrderFile, customer_ids: dict[str, int], today: date, report: SeedReport) -> None:
    """Make the orders match the file, turning relative days into dates counted from `today`."""
    for entry in order_file.orders:
        change, _ = upsert(
            Order,
            {"number": entry.number},
            {
                "customer_id": customer_ids[entry.customer],
                "status": entry.status,
                "country": entry.country,
                "placed_on": day_from(today, entry.placed),
                "roasted_on": day_from(today, entry.roasted),
                "shipped_on": day_from(today, entry.shipped),
                "delivered_on": day_from(today, entry.delivered),
                "carrier": entry.carrier,
                "tracking_number": entry.tracking_number,
                "items": [line.model_dump() for line in entry.items],
                "shipping_czk": entry.shipping_czk,
                "total_czk": entry.total_czk,
            },
        )
        report.orders.count(change)
    report.orders.deleted = delete_rows_except(
        Order.objects.all(), "number", [order.number for order in order_file.orders]
    )


def delete_missing_customers(customer_file: CustomerFile, report: SeedReport) -> None:
    """Delete customers no longer in the file, once their orders are gone."""
    wanted = [customer.key for customer in customer_file.customers]
    report.customers.deleted = delete_rows_except(Customer.objects.all(), "key", wanted)


def day_from(today: date, offset: int | None) -> date | None:
    """Turn a relative day (0 today, -3 three days before) into a date, keeping "no date" as None."""
    return None if offset is None else today + timedelta(days=offset)


def upsert[Row: models.Model](model: type[Row], lookup: dict[str, Any], values: dict[str, Any]) -> tuple[str, Row]:
    """Create the row, update only the fields that differ, or leave it alone, and say which.

    Returns "created", "updated" or "unchanged", with the row.
    """
    row = model._default_manager.filter(**lookup).first()
    if row is None:
        return "created", model._default_manager.create(**lookup, **values)
    changed = [name for name, value in values.items() if getattr(row, name) != value]
    if not changed:
        return "unchanged", row
    for name in changed:
        setattr(row, name, values[name])
    row.save(update_fields=changed)
    return "updated", row


def delete_rows_except(rows: models.QuerySet[Any], key_field: str, keep: list[str]) -> int:
    """Delete the rows whose key isn't in `keep`, and return how many rows went (not counting cascades)."""
    doomed = rows.exclude(**{f"{key_field}__in": keep})
    count = doomed.count()
    doomed.delete()
    return count
