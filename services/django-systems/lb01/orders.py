"""The order-lookup tool: what LB-01's drafts may say about an order, and for whom.

The tool looks an order up on the ticket's own customer only. Another customer's order
is reported exactly like one that doesn't exist, so a ticket can't learn anything about
it, not even that it exists, however it asks. The facts come out as plain text in a
fixed form, which is what the draft reads and what the claim check holds its numbers to.
"""

from dataclasses import dataclass
from decimal import Decimal

from lb01.models import Customer, Order


@dataclass(frozen=True)
class OrderLookup:
    """The tool's answer: the order number asked about, whether it was found, and the facts to cite."""

    number: str
    found: bool
    facts: str

    @property
    def source_id(self) -> str:
        """The ID a draft cites these facts by, such as `order:BB-1042`."""
        return f"order:{self.number}"


def look_up_order(number: str, customer: Customer) -> OrderLookup:
    """Find an order on `customer`'s account only; any other order is simply not found."""
    order = Order.objects.filter(number=number, customer=customer).first()
    if order is None:
        return OrderLookup(number=number, found=False, facts=f"Order {number} is not on this customer's account.")
    return OrderLookup(number=number, found=True, facts=describe_order(order))


def describe_order(order: Order) -> str:
    """Write out an order's facts in one fixed form, with ISO dates and whole crowns."""
    lines = [f"Order {order.number}: {Order.Status(order.status).label.lower()}."]
    dates = [
        ("placed", order.placed_on),
        ("roasted", order.roasted_on),
        ("shipped", order.shipped_on),
        ("delivered", order.delivered_on),
    ]
    known_dates = [f"{event} {day.isoformat()}" for event, day in dates if day is not None]
    lines.append(f"Dates: {', '.join(known_dates)}.")
    tracking = f", tracking number {order.tracking_number}" if order.tracking_number else ""
    lines.append(f"Ships to {order.country} with {order.carrier}{tracking}.")
    lines.append("Items: " + "; ".join(describe_line(line) for line in order.items) + ".")
    lines.append(f"Delivery {crowns(order.shipping_czk)} CZK. Total {crowns(order.total_czk)} CZK.")
    return " ".join(lines)


def describe_line(line: dict[str, object]) -> str:
    """Write out one order line, such as `2 x Basalt Blend, whole-bean, 250 g, at 289 CZK each`."""
    details = [str(line["product"])]
    if line.get("kind") == "coffee":
        details.append(str(line["grind"]))
        details.append(f"{line['grams']} g")
    return f"{line['quantity']} x {', '.join(details)}, at {line['price_czk']} CZK each"


def crowns(amount: Decimal) -> str:
    """Write an amount in whole crowns, as the shop prices everything."""
    return str(int(amount))
