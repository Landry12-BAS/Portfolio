"""The synthetic Basalt & Bean sales data behind LB-05: customers, products, orders, order lines and subscriptions.

The data is generated, never collected, and never contains a real person. A seed and an
as-of day fix it completely: the same two numbers give the same rows on any machine, because
every random number comes from PCG64's raw output through integer and basic floating-point
arithmetic only (no logarithms, no library whose last digit may differ between CPUs).

Dates are relative to the as-of day, as in LB-01's seeds: the data ends on that day, so
"last quarter" always has sales in it. Customers follow a simple renewal process (one-off
buyers who lapse, subscribers who order on a schedule, cafes that order often), and three
stories are placed relative to the as-of day so the questions have answers worth finding:

- Kenya Nyeri is out of stock for most of the last calendar quarter. Some of its repeat
  buyers switch to Ethiopia Guji for good, so Kenya Nyeri loses the most repeat buyers.
- Sales grow year on year, and rise before Christmas.
- Subscriptions are the steadiest customers; weekends hold the stall orders.

The generator builds NumPy arrays; lb05/warehouse_build.py writes them as Parquet and as the
read-only DuckDB file the service queries. The products match the coffees and equipment in
data/seed/lb01/orders.yaml, at the same prices.
"""

import hashlib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Final

import numpy as np
from numpy.typing import NDArray

from lb05.timeranges import named_ranges

# Bump when the generator's output changes, so a stale data folder is recognised.
GENERATOR_VERSION: Final = 1
# A missing date, which DuckDB reads as NULL.
NO_DATE: Final = np.datetime64("NaT", "us")
# Whole-number columns that may be empty, by table: the generator writes 0 where there is no value,
# and lb05/warehouse_build.py turns those zeros into NULLs (NumPy's masked arrays carry no NULLs into DuckDB).
NULL_WHEN_ZERO: Final = {"orders": ("subscription_id",), "products": ("bag_grams",)}

type IntArray = NDArray[np.int64]
type FloatArray = NDArray[np.float64]
type BoolArray = NDArray[np.bool_]
type Column = NDArray[np.generic] | TextColumn
type Columns = dict[str, Column]

# ---- the catalogue: the coffees and equipment of data/seed/lb01/orders.yaml --------------------

COFFEES: Final[tuple[tuple[str, str, str, int, int], ...]] = (
    # name, roast, origin, price of a 250 g bag, price of a 1000 g bag, in CZK
    ("Basalt Blend", "dark", "Blend", 289, 990),
    ("Ethiopia Guji", "light", "Ethiopia", 349, 1190),
    ("Colombia Huila", "medium", "Colombia", 319, 1090),
    ("Kenya Nyeri", "light", "Kenya", 379, 1290),
    ("Lava Decaf", "medium", "Honduras", 299, 1020),
)  # fmt: skip
EQUIPMENT: Final[tuple[tuple[str, int], ...]] = (("Basalt Hand Grinder", 1490), ("Gooseneck Kettle", 1190))
BAG_GRAMS: Final = (250, 1000)
GUJI: Final = 1
KENYA: Final = 3
# Product numbers: coffee c in bag size s is 1 + 2c + s; the equipment follows the coffees.
FIRST_EQUIPMENT_ID: Final = 1 + 2 * len(COFFEES)
GRINDS: Final = ("whole-bean", "espresso", "moka", "filter", "french-press", "cold-brew")
COUNTRIES: Final = ("CZ", "SK", "DE", "AT", "PL", "HU")
CITIES: Final[dict[str, tuple[str, ...]]] = {
    "CZ": ("Prague", "Brno", "Ostrava", "Pilsen", "Liberec", "Olomouc"),
    "SK": ("Bratislava", "Kosice", "Zilina"),
    "DE": ("Berlin", "Munich", "Dresden", "Hamburg"),
    "AT": ("Vienna", "Graz", "Linz"),
    "PL": ("Warsaw", "Krakow", "Wroclaw"),
    "HU": ("Budapest", "Debrecen"),
}
CHANNELS: Final = ("search", "instagram", "referral", "newsletter", "market_stall", "partner_cafe")
STATUSES: Final = ("processing", "roasted", "shipped", "delivered", "cancelled", "lost")
CARRIERS: Final = ("Vltava Post", "Kolo Courier")
SOURCES: Final = ("web", "subscription", "market_stall")
CANCEL_REASONS: Final = ("price", "too_much_coffee", "taste", "moved", "other")
SUBSCRIPTION_STATUSES: Final = ("active", "paused", "cancelled")
FREQUENCIES: Final = (7, 14, 28)

# ---- how customers behave --------------------------------------------------------------------

COUNTRY_WEIGHTS: Final = (0.62, 0.12, 0.10, 0.06, 0.06, 0.04)
CHANNEL_WEIGHTS: Final = (0.30, 0.20, 0.15, 0.12, 0.13, 0.10)
# Which coffee a customer favours; Kenya Nyeri is the connoisseurs' choice, so its repeat buyers are many.
FAVORITE_WEIGHTS: Final = (0.27, 0.19, 0.18, 0.24, 0.12)
GRIND_WEIGHTS: Final = (0.38, 0.20, 0.08, 0.22, 0.08, 0.04)
BUSINESS_SHARE: Final = 0.06
SUBSCRIBER_SHARE: Final = {"home": 0.12, "business": 0.20}
EXISTING_SHARE: Final = 0.30
LARGE_BAG_SHARE: Final = {"home": 0.12, "business": 0.75}
# Days between a one-off buyer's orders, and the chance in a hundred that each order is their last.
HOME_GAPS: Final = (28, 42, 56, 84, 120, 180)
HOME_GAP_WEIGHTS: Final = (0.18, 0.25, 0.22, 0.18, 0.10, 0.07)
BUSINESS_GAPS: Final = (7, 10, 14, 21)
BUSINESS_GAP_WEIGHTS: Final = (0.20, 0.30, 0.30, 0.20)
SUBSCRIBER_FREQUENCY_WEIGHTS: Final = (0.15, 0.45, 0.40)
CHURN_PERCENT: Final = {"home": 30, "business": 3, "subscriber": 4}
# How a gap is stretched or squeezed from one order to the next, in percent.
GAP_FACTORS: Final = (60, 80, 100, 125, 160)
GAP_FACTOR_WEIGHTS: Final = (0.12, 0.23, 0.30, 0.23, 0.12)
# The share of orders kept on each weekday, Monday first: people order less on Sundays.
WEEKDAY_KEEP: Final = (0.95, 1.0, 1.0, 1.0, 0.98, 0.92, 0.78)
MARKET_STALL_SHARE: Final = 0.35
CHRISTMAS_BUYER_SHARE: Final = 0.09
CHRISTMAS_SEASON_START: Final = (11, 15)
CHRISTMAS_SEASON_DAYS: Final = 38
STOCKOUT_MARGIN_DAYS: Final = 3
STOCKOUT_SUBSTITUTE_PERCENT: Final = 92
STOCKOUT_SWITCH_PERCENT: Final = 70

# ---- what an order holds ---------------------------------------------------------------------

LINES_HOME: Final = (0.58, 0.27, 0.11, 0.04)
LINES_BUSINESS: Final = (0.20, 0.30, 0.30, 0.20)
FAVORITE_LINE_SHARE: Final = 0.6
EQUIPMENT_LINE_SHARE: Final = 0.07
QUANTITY_WEIGHTS: Final = (0.80, 0.15, 0.05)
SUBSCRIPTION_DISCOUNT_PERCENT: Final = 10
FREE_DELIVERY_FROM_CZK: Final = 1_000
STANDARD_DELIVERY_CZK: Final = 89
COURIER_DELIVERY_CZK: Final = 149
SLOVAKIA_DELIVERY_CZK: Final = 159
EU_DELIVERY_CZK: Final = 290
COURIER_SHARE: Final = 0.18
CANCEL_REASON_WEIGHTS: Final = (0.28, 0.24, 0.14, 0.10, 0.24)
PAUSED_SHARE: Final = 0.04
# Order status by age in days: for each age bucket (from, weights over STATUSES).
STATUS_BY_AGE: Final[tuple[tuple[int, tuple[float, ...]], ...]] = (
    (10, (0.0, 0.0, 0.0, 0.962, 0.035, 0.003)),
    (5, (0.0, 0.0, 0.38, 0.55, 0.06, 0.01)),
    (2, (0.0, 0.30, 0.45, 0.17, 0.08, 0.0)),
    (1, (0.30, 0.40, 0.22, 0.0, 0.08, 0.0)),
    (0, (0.70, 0.22, 0.0, 0.0, 0.08, 0.0)),
)  # fmt: skip


@dataclass(frozen=True)
class TextColumn:
    """A column of text kept as whole numbers: each code is a position in `names`, and a name that is None means NULL.

    DuckDB takes a NumPy column of Python strings slowly (a fixed fraction of a second for each
    one, however short), and a lookup in a list by an integer quickly. So the generator keeps
    text as codes, and the writer turns them back into text inside DuckDB (lb05/warehouse_build.py).
    """

    codes: IntArray
    names: tuple[str | None, ...]

    def __len__(self) -> int:
        """Return how many values the column holds."""
        return int(self.codes.size)


@dataclass(frozen=True)
class Size:
    """How much data to generate: how many customers, and how many days of history ending at the as-of day."""

    name: str
    customers: int
    history_days: int


# The full set is about two million orders (2,020,822 for seed 5); the small one is what tests and evals run on.
SIZES: Final = {
    "full": Size("full", customers=385_000, history_days=1_095),
    "small": Size("small", customers=6_000, history_days=760),
    "tiny": Size("tiny", customers=500, history_days=400),
}


class Draws:
    """A deterministic source of random numbers: PCG64's raw stream, turned into numbers with plain arithmetic."""

    def __init__(self, seed: int) -> None:
        """Start the stream for `seed`."""
        self._bits = np.random.PCG64(seed)

    def uniform(self, count: int) -> FloatArray:
        """Return `count` numbers in [0, 1), each from 53 random bits."""
        if count == 0:
            return np.empty(0, dtype=np.float64)
        raw = self._bits.random_raw(count)
        return (raw >> np.uint64(11)).astype(np.float64) * (1.0 / 9_007_199_254_740_992.0)

    def below(self, limit: int | IntArray, count: int) -> IntArray:
        """Return `count` whole numbers from 0 up to, not including, `limit` (one limit, or one per number)."""
        return (self.uniform(count) * limit).astype(np.int64)

    def choice(self, weights: Sequence[float], count: int) -> IntArray:
        """Return `count` positions in `weights`, each chosen in proportion to its weight."""
        cumulative = np.cumsum(np.asarray(weights, dtype=np.float64))
        cumulative /= cumulative[-1]
        return np.searchsorted(cumulative, self.uniform(count), side="right").astype(np.int64)

    def chance(self, probability: float, count: int) -> BoolArray:
        """Return `count` yes/no answers, each yes with the given probability."""
        return self.uniform(count) < probability


@dataclass
class Customers:
    """The customers, as columns, with the traits that drive how they order (not all of them are stored)."""

    count: int
    country: IntArray
    city: IntArray
    business: BoolArray
    signup_day: IntArray
    channel: IntArray
    favorite: IntArray
    large_bag: BoolArray
    grind: IntArray
    subscriber: BoolArray
    gap_days: IntArray
    churn_percent: IntArray
    first_day: IntArray


@dataclass
class Orders:
    """Every order as columns, in order of date, with the customer index each belongs to."""

    customer: IntArray
    day: IntArray
    subscription_order: BoolArray
    market_stall: BoolArray


@dataclass(frozen=True)
class Dataset:
    """A generated dataset: its tables as columns, the as-of day, and a digest that proves what was generated."""

    tables: dict[str, Columns]
    as_of: date
    seed: int
    size: Size
    digest: str

    def row_counts(self) -> dict[str, int]:
        """Return how many rows each table has."""
        return {name: column_length(next(iter(columns.values()))) for name, columns in self.tables.items()}


def column_length(column: Column) -> int:
    """Return how many values a column holds, whether it is numbers, dates or text."""
    return len(column) if isinstance(column, TextColumn) else int(column.size)


def numbers(columns: Columns, name: str) -> NDArray[np.generic]:
    """Return a column that holds numbers or dates, refusing a text column."""
    column = columns[name]
    if isinstance(column, TextColumn):
        raise TypeError(f"The column {name} holds text, not numbers.")
    return column


def labels(names: Sequence[str | None], indexes: IntArray) -> TextColumn:
    """Look up a label for each index: the column is the indexes, and the labels they point at."""
    return TextColumn(indexes.astype(np.int64), tuple(names))


def day_to_date64(day: IntArray, first_day: date) -> NDArray[np.datetime64]:
    """Turn day numbers (0 is `first_day`) into dates DuckDB reads as timestamps, cast to DATE when written."""
    start = np.datetime64(first_day.isoformat(), "D")
    return (start + day.astype("timedelta64[D]")).astype("datetime64[us]")


def make_customers(size: Size, draws: Draws) -> Customers:
    """Draw every customer's country, segment, tastes and ordering rhythm."""
    count = size.customers
    country = draws.choice(COUNTRY_WEIGHTS, count)
    city = np.zeros(count, dtype=np.int64)
    for index, name in enumerate(COUNTRIES):
        here = np.flatnonzero(country == index)
        weights = [1.0 / (position + 1) for position in range(len(CITIES[name]))]
        city[here] = draws.choice(weights, here.size)
    business = draws.chance(BUSINESS_SHARE, count)
    subscriber = draws.uniform(count) < np.where(business, SUBSCRIBER_SHARE["business"], SUBSCRIBER_SHARE["home"])
    large_bag = draws.uniform(count) < np.where(business, LARGE_BAG_SHARE["business"], LARGE_BAG_SHARE["home"])
    gap_days = pick_gaps(business, subscriber, draws)
    churn = np.where(
        subscriber, CHURN_PERCENT["subscriber"], np.where(business, CHURN_PERCENT["business"], CHURN_PERCENT["home"])
    )
    signup_day, first_day = pick_start_days(size, gap_days, draws)
    return Customers(
        count=count,
        country=country,
        city=city,
        business=business,
        signup_day=signup_day,
        channel=draws.choice(CHANNEL_WEIGHTS, count),
        favorite=draws.choice(FAVORITE_WEIGHTS, count),
        large_bag=large_bag,
        grind=draws.choice(GRIND_WEIGHTS, count),
        subscriber=subscriber,
        gap_days=gap_days,
        churn_percent=churn.astype(np.int64),
        first_day=first_day,
    )


def pick_gaps(business: BoolArray, subscriber: BoolArray, draws: Draws) -> IntArray:
    """Choose each customer's usual number of days between orders: a delivery schedule for subscribers."""
    count = business.size
    home = np.asarray(HOME_GAPS, dtype=np.int64)[draws.choice(HOME_GAP_WEIGHTS, count)]
    cafe = np.asarray(BUSINESS_GAPS, dtype=np.int64)[draws.choice(BUSINESS_GAP_WEIGHTS, count)]
    schedule = np.asarray(FREQUENCIES, dtype=np.int64)[draws.choice(SUBSCRIBER_FREQUENCY_WEIGHTS, count)]
    return np.where(subscriber, schedule, np.where(business, cafe, home)).astype(np.int64)


def pick_start_days(size: Size, gap_days: IntArray, draws: Draws) -> tuple[IntArray, IntArray]:
    """Choose when each customer registered and when their first order in the data falls.

    Some customers existed before the data begins (they registered up to two years earlier
    and order from the first days on); the rest register during it, more of them as time goes on.
    """
    count = gap_days.size
    existing = draws.chance(EXISTING_SHARE, count)
    earlier = -1 - draws.below(730, count)
    first_draw = draws.uniform(count)
    second_draw = draws.uniform(count)
    joined = (np.maximum(first_draw, second_draw) * size.history_days).astype(np.int64)
    signup_day = np.where(existing, earlier, joined)
    first_order = np.where(existing, draws.below(gap_days, count), joined + draws.below(3, count))
    return signup_day.astype(np.int64), first_order.astype(np.int64)


def simulate_renewals(customers: Customers, horizon: int, draws: Draws) -> tuple[IntArray, IntArray, BoolArray]:
    """Play every customer's orders forward day by day, and return who ordered when, and who lapsed.

    A customer orders, waits their usual gap (stretched or squeezed a little), and orders again
    until they lapse, which happens after each order with their own probability, or the data ends.
    Returns the customer index and day of every order, and for each customer whether they lapsed.
    """
    next_day = customers.first_day.copy()
    active = np.flatnonzero(next_day < horizon)
    owners: list[IntArray] = []
    days: list[IntArray] = []
    lapsed = np.zeros(customers.count, dtype=np.bool_)
    factors = np.asarray(GAP_FACTORS, dtype=np.int64)
    while active.size:
        owners.append(active)
        days.append(next_day[active].copy())
        stays = draws.below(100, active.size) >= customers.churn_percent[active]
        lapsed[active[~stays]] = True
        steady = customers.subscriber[active]
        factor = np.where(steady, 100, factors[draws.choice(GAP_FACTOR_WEIGHTS, active.size)])
        next_day[active] += np.maximum(1, customers.gap_days[active] * factor // 100)
        active = active[stays & (next_day[active] < horizon)]
    return np.concatenate(owners), np.concatenate(days), lapsed


def add_christmas_orders(
    customers: Customers, horizon: int, first_day: date, draws: Draws
) -> tuple[IntArray, IntArray]:
    """Pick the extra orders placed in each pre-Christmas season by customers who are already registered."""
    owners: list[IntArray] = []
    days: list[IntArray] = []
    for year in range(first_day.year, first_day.year + horizon // 365 + 2):
        season_start = (date(year, *CHRISTMAS_SEASON_START) - first_day).days
        if season_start + CHRISTMAS_SEASON_DAYS <= 0 or season_start >= horizon:
            continue
        eligible = np.flatnonzero(customers.signup_day <= season_start)
        buyers = eligible[draws.chance(CHRISTMAS_BUYER_SHARE, eligible.size)]
        owners.append(buyers)
        days.append(np.clip(season_start + draws.below(CHRISTMAS_SEASON_DAYS, buyers.size), 0, horizon - 1))
    if not owners:
        return np.empty(0, dtype=np.int64), np.empty(0, dtype=np.int64)
    return np.concatenate(owners), np.concatenate(days)


def make_orders(customers: Customers, size: Size, first_day: date, draws: Draws) -> tuple[Orders, BoolArray]:
    """Turn the renewal process and the Christmas rush into dated orders, thinned by weekday, in date order.

    Also returns, for each customer, whether their subscription lapsed.
    """
    horizon = size.history_days
    renewal_owner, renewal_day, lapsed = simulate_renewals(customers, horizon, draws)
    extra_owner, extra_day = add_christmas_orders(customers, horizon, first_day, draws)
    owner = np.concatenate([renewal_owner, extra_owner])
    day = np.concatenate([renewal_day, extra_day])
    # A subscriber's renewals are deliveries; everything else, a Christmas order included, is an ordinary order.
    subscription_order = np.concatenate(
        [customers.subscriber[renewal_owner], np.zeros(extra_owner.size, dtype=np.bool_)]
    )
    weekday = (first_day.weekday() + day) % 7
    keep = subscription_order | (draws.uniform(day.size) < np.asarray(WEEKDAY_KEEP)[weekday])
    owner, day, subscription_order, weekday = owner[keep], day[keep], subscription_order[keep], weekday[keep]
    market_stall = ~subscription_order & (weekday >= 5) & draws.chance(MARKET_STALL_SHARE, day.size)
    order = np.lexsort((owner, day))
    return Orders(owner[order], day[order], subscription_order[order], market_stall[order]), lapsed


def stockout_window(today: date, first_day: date) -> tuple[int, int]:
    """Return the first and last day number Kenya Nyeri is out of stock: most of the last calendar quarter."""
    last_quarter = named_ranges(today)["last_quarter"]
    start = last_quarter.start + timedelta(days=STOCKOUT_MARGIN_DAYS)
    end = last_quarter.end - timedelta(days=STOCKOUT_MARGIN_DAYS)
    return (start - first_day).days, (end - first_day).days


def lines_per_order(orders: Orders, customers: Customers, draws: Draws) -> IntArray:
    """Choose how many lines each order has: one for a subscription delivery, a few for the rest."""
    count = orders.day.size
    home = draws.choice(LINES_HOME, count) + 1
    cafe = draws.choice(LINES_BUSINESS, count) + 1
    chosen = np.where(customers.business[orders.customer], cafe, home)
    return np.where(orders.subscription_order, 1, chosen).astype(np.int64)


def coffee_for_lines(
    owner: IntArray, day: IntArray, subscription: BoolArray, customers: Customers, window: tuple[int, int], draws: Draws
) -> IntArray:
    """Choose the coffee on each line, and apply the Kenya Nyeri stockout and the switch it causes.

    Customers mostly buy their favourite. While Kenya Nyeri is out of stock most people who
    wanted it buy Ethiopia Guji instead; some of the favourite's fans never come back to it.
    Subscriptions are untouched: their delivery is held back, not swapped.
    """
    count = owner.size
    favorite = customers.favorite[owner]
    own_choice = np.where(draws.chance(FAVORITE_LINE_SHARE, count), favorite, draws.choice(FAVORITE_WEIGHTS, count))
    coffee = np.where(subscription, favorite, own_choice)
    start, end = window
    in_window = (day >= start) & (day <= end)
    hit = np.zeros(customers.count, dtype=np.bool_)
    hit[owner[in_window]] = True
    switched = (
        (customers.favorite == KENYA)
        & hit
        & ~customers.subscriber
        & draws.chance(STOCKOUT_SWITCH_PERCENT / 100, customers.count)
    )
    wanted_kenya = (coffee == KENYA) & ~subscription
    swapped_now = in_window & wanted_kenya & (draws.below(100, count) < STOCKOUT_SUBSTITUTE_PERCENT)
    swapped_later = (day >= start) & wanted_kenya & switched[owner]
    return np.where(swapped_now | swapped_later, GUJI, coffee).astype(np.int64)


def make_lines(orders: Orders, customers: Customers, window: tuple[int, int], draws: Draws) -> tuple[Columns, IntArray]:
    """Build the order lines and return them with the number of lines each order has."""
    per_order = lines_per_order(orders, customers, draws)
    line_order = np.repeat(np.arange(orders.day.size, dtype=np.int64), per_order)
    owner = orders.customer[line_order]
    day = orders.day[line_order]
    subscription = orders.subscription_order[line_order]
    count = line_order.size
    equipment = ~subscription & draws.chance(EQUIPMENT_LINE_SHARE, count)
    coffee = coffee_for_lines(owner, day, subscription, customers, window, draws)
    flip = ~subscription & draws.chance(0.15, count)
    large = customers.large_bag[owner] ^ flip
    product = np.where(equipment, FIRST_EQUIPMENT_ID + draws.choice((0.55, 0.45), count), 1 + 2 * coffee + large)
    grind = np.where(
        subscription | draws.chance(0.8, count), customers.grind[owner], draws.choice(GRIND_WEIGHTS, count)
    )
    cafe_quantity = 1 + draws.below(6, count)
    quantity = np.where(
        customers.business[owner] & ~equipment, cafe_quantity, 1 + draws.choice(QUANTITY_WEIGHTS, count)
    )
    quantity = np.where(equipment | (subscription & ~customers.business[owner]), 1, quantity)
    prices = product_prices()
    unit_price = prices[product]
    discount = np.where(subscription, quantity * unit_price * SUBSCRIPTION_DISCOUNT_PERCENT // 100, 0)
    columns: Columns = {
        "line_id": np.arange(1, count + 1, dtype=np.int64),
        "order_id": line_order + 1,
        "product_id": product.astype(np.int16),
        "grind": labels([*GRINDS, None], np.where(equipment, len(GRINDS), grind)),
        "quantity": quantity.astype(np.int16),
        "unit_price_czk": unit_price.astype(np.int32),
        "discount_czk": discount.astype(np.int32),
        "line_total_czk": (quantity * unit_price - discount).astype(np.int32),
    }
    return columns, line_order


def product_prices() -> IntArray:
    """Return the list price of every product, indexed by product number (index 0 is unused)."""
    prices = [0]
    for _, _, _, small, large in COFFEES:
        prices += [small, large]
    prices += [price for _, price in EQUIPMENT]
    return np.asarray(prices, dtype=np.int64)


def make_products() -> Columns:
    """Build the products table: each coffee in two bag sizes, then the equipment."""
    names: list[str] = []
    kinds: list[str] = []
    grams: list[int | None] = []
    prices: list[int] = []
    roasts: list[str | None] = []
    origins: list[str | None] = []
    for name, roast, origin, small, large in COFFEES:
        for size, price in zip(BAG_GRAMS, (small, large), strict=True):
            names.append(name)
            kinds.append("coffee")
            grams.append(size)
            prices.append(price)
            roasts.append(roast)
            origins.append(origin)
    for name, price in EQUIPMENT:
        names.append(name)
        kinds.append("equipment")
        grams.append(None)
        prices.append(price)
        roasts.append(None)
        origins.append(None)
    return {
        "product_id": np.arange(1, len(names) + 1, dtype=np.int16),
        "name": text_column(names),
        "kind": text_column(kinds),
        "bag_grams": np.asarray([0 if gram is None else gram for gram in grams], dtype=np.int16),
        "price_czk": np.asarray(prices, dtype=np.int32),
        "roast": text_column(roasts),
        "origin": text_column(origins),
    }


def text_column(values: Sequence[str | None]) -> TextColumn:
    """Make a text column from Python strings, where None becomes a NULL; each distinct value is named once."""
    names = tuple(dict.fromkeys(values))
    position = {name: index for index, name in enumerate(names)}
    return TextColumn(np.asarray([position[value] for value in values], dtype=np.int64), names)


def make_customer_table(customers: Customers, first_day: date) -> Columns:
    """Build the customers table. The email is stored but kept out of the semantic layer, so no question can read it."""
    ids = np.arange(1, customers.count + 1, dtype=np.int64)
    city_names = [city for name in COUNTRIES for city in CITIES[name]]
    offsets = np.cumsum([0] + [len(CITIES[name]) for name in COUNTRIES])[:-1]
    return {
        "customer_id": ids,
        "country": labels(COUNTRIES, customers.country),
        "city": labels(city_names, np.asarray(offsets)[customers.country] + customers.city),
        "segment": labels(["home", "business"], customers.business.astype(np.int64)),
        "signup_date": day_to_date64(customers.signup_day, first_day),
        "acquisition_channel": labels(CHANNELS, customers.channel),
        "email": np.char.add(np.char.add("customer-", ids.astype("U")), "@example.test"),
    }


def status_for_age(age: IntArray, draws: Draws) -> IntArray:
    """Choose each order's status from its age: old orders are done, recent ones are still in progress."""
    status = np.zeros(age.size, dtype=np.int64)
    claimed = np.zeros(age.size, dtype=np.bool_)
    for from_age, weights in STATUS_BY_AGE:
        bucket = (age >= from_age) & ~claimed
        status[bucket] = draws.choice(weights, int(bucket.sum()))
        claimed |= bucket
    return status


def delivery_cost(ship_country: IntArray, courier: BoolArray, items_czk: IntArray) -> IntArray:
    """Work out delivery by the shipping.costs policy in data/seed/lb01/policies.yaml (couriers: Czechia only)."""
    czech = ship_country == COUNTRIES.index("CZ")
    standard = np.where(items_czk >= FREE_DELIVERY_FROM_CZK, 0, STANDARD_DELIVERY_CZK)
    abroad = np.where(ship_country == COUNTRIES.index("SK"), SLOVAKIA_DELIVERY_CZK, EU_DELIVERY_CZK)
    return np.where(czech, np.where(courier, COURIER_DELIVERY_CZK, standard), abroad).astype(np.int64)


def make_order_table(
    orders: Orders,
    customers: Customers,
    lines: Columns,
    line_order: IntArray,
    first_day: date,
    today_day: int,
    draws: Draws,
) -> Columns:
    """Build the orders table: dates, status, delivery, and totals that add up from the lines."""
    count = orders.day.size
    items = np.bincount(
        line_order, weights=numbers(lines, "line_total_czk").astype(np.float64), minlength=count
    ).astype(np.int64)
    home_country = customers.country[orders.customer]
    gift = ~draws.chance(0.97, count)
    ship_country = np.where(gift, draws.choice(COUNTRY_WEIGHTS, count), home_country)
    courier = (ship_country == COUNTRIES.index("CZ")) & draws.chance(COURIER_SHARE, count)
    shipping = delivery_cost(ship_country, courier, items)
    subscription_of = np.cumsum(customers.subscriber) * customers.subscriber
    sub_id = np.where(orders.subscription_order, subscription_of[orders.customer], 0)
    source = np.where(orders.subscription_order, 1, np.where(orders.market_stall, 2, 0))
    return {
        "order_id": np.arange(1, count + 1, dtype=np.int64),
        "customer_id": orders.customer + 1,
        "ordered_at": day_to_date64(orders.day, first_day),
        "status": labels(STATUSES, status_for_age(today_day - orders.day, draws)),
        "ship_country": labels(COUNTRIES, ship_country),
        "carrier": labels(CARRIERS, courier.astype(np.int64)),
        "source": labels(SOURCES, source),
        "subscription_id": sub_id.astype(np.int64),
        "shipping_czk": shipping.astype(np.int32),
        "total_czk": (items + shipping).astype(np.int32),
        "payment_reference": (900_000_000 + np.arange(count, dtype=np.int64) * 7919 % 99_999_989),
    }


def make_subscription_table(
    customers: Customers, orders: Orders, lapsed: BoolArray, size: Size, first_day: date, draws: Draws
) -> Columns:
    """Build the subscriptions table: one per subscriber, active, paused or cancelled by how their orders ended."""
    subscribers = np.flatnonzero(customers.subscriber)
    count = subscribers.size
    last_delivery = np.full(customers.count, -1, dtype=np.int64)
    delivered = orders.subscription_order
    np.maximum.at(last_delivery, orders.customer[delivered], orders.day[delivered])
    ended = lapsed[subscribers]
    cancelled_day = last_delivery[subscribers] + customers.gap_days[subscribers]
    cancelled = ended & (cancelled_day < size.history_days) & (last_delivery[subscribers] >= 0)
    paused = ~cancelled & draws.chance(PAUSED_SHARE, count)
    status = np.where(cancelled, 2, np.where(paused, 1, 0))
    coffee = customers.favorite[subscribers]
    return {
        "subscription_id": np.arange(1, count + 1, dtype=np.int64),
        "customer_id": subscribers + 1,
        "product_id": (1 + 2 * coffee + customers.large_bag[subscribers]).astype(np.int16),
        "grind": labels(GRINDS, customers.grind[subscribers]),
        "frequency_days": customers.gap_days[subscribers].astype(np.int16),
        "started_at": day_to_date64(
            np.maximum(customers.signup_day[subscribers], customers.first_day[subscribers] - draws.below(2, count)),
            first_day,
        ),
        "status": labels(SUBSCRIPTION_STATUSES, status),
        "cancelled_at": np.where(cancelled, day_to_date64(cancelled_day, first_day), NO_DATE),
        "cancel_reason": labels(
            [*CANCEL_REASONS, None],
            np.where(cancelled, draws.choice(CANCEL_REASON_WEIGHTS, count), len(CANCEL_REASONS)),
        ),
    }


def digest_of(tables: Mapping[str, Columns]) -> str:
    """Return a SHA-256 over every column of every table in a fixed order, so equal data has an equal digest."""
    hasher = hashlib.sha256()
    for table in sorted(tables):
        for name in sorted(tables[table]):
            column = tables[table][name]
            if isinstance(column, TextColumn):
                hasher.update(f"{table}.{name}:text:{len(column)}".encode())
                hasher.update("\x1f".join("\x00" if value is None else value for value in column.names).encode())
                hasher.update(np.ascontiguousarray(column.codes).tobytes())
            else:
                hasher.update(f"{table}.{name}:{column.dtype}:{column.size}".encode())
                hasher.update(np.ascontiguousarray(column).tobytes())
    return hasher.hexdigest()


def generate(size: Size, today: date, seed: int) -> Dataset:
    """Generate the whole dataset for a size, an as-of day and a seed."""
    draws = Draws(seed)
    first_day = today - timedelta(days=size.history_days - 1)
    customers = make_customers(size, draws)
    orders, lapsed = make_orders(customers, size, first_day, draws)
    window = stockout_window(today, first_day)
    lines, line_order = make_lines(orders, customers, window, draws)
    tables: dict[str, Columns] = {
        "customers": make_customer_table(customers, first_day),
        "products": make_products(),
        "orders": make_order_table(orders, customers, lines, line_order, first_day, size.history_days - 1, draws),
        "order_lines": lines,
        "subscriptions": make_subscription_table(customers, orders, lapsed, size, first_day, draws),
    }
    return Dataset(tables=tables, as_of=today, seed=seed, size=size, digest=digest_of(tables))
