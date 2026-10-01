"""Tests for the synthetic data generator (lb05/generator.py) and what it writes (lb05/warehouse_build.py).

Determinism is tested on the tiny dataset, and the rules the data keeps (keys, money, dates, the
stories placed in it) on the small one, read back through the warehouse the way a query would.
"""

from datetime import date
from pathlib import Path

import pytest
import yaml
from duckdb import ColumnExpression, ConstantExpression

from core.platform import REPOSITORY_ROOT
from lb05.generator import GENERATOR_VERSION, SIZES, generate
from lb05.semantic_layer import SemanticLayer
from lb05.warehouse import CellValue, Warehouse
from lb05.warehouse_build import (
    DATABASE_FILE,
    META_FILE,
    TABLES,
    WarehouseMetaError,
    read_meta,
    write_dataset,
)
from tests.support import DATA_AS_OF, DATA_SEED

# The digest of the tiny dataset for seed 5 and the as-of day above. It proves the same rows on any
# machine; if a deliberate change to the generator moves it, bump GENERATOR_VERSION and paste the new one.
TINY_DIGEST = "e28995a64c22a94446a238047e5e6da6d4b04778985cd1c511833081458bef0e"
TINY_ROWS = {"customers": 500, "products": 12, "orders": 1832, "order_lines": 2753, "subscriptions": 70}


def rows(warehouse: Warehouse, sql: str) -> list[tuple[CellValue, ...]]:
    """Run a query on the test dataset and return its rows."""
    return warehouse.run(sql).rows


def number(warehouse: Warehouse, sql: str) -> CellValue:
    """Run a query that returns one value, and return it."""
    return rows(warehouse, sql)[0][0]


def test_the_same_seed_and_day_give_the_same_data() -> None:
    """Two runs agree on every value, which the digest covers."""
    first = generate(SIZES["tiny"], DATA_AS_OF, DATA_SEED)
    second = generate(SIZES["tiny"], DATA_AS_OF, DATA_SEED)
    assert first.digest == second.digest == TINY_DIGEST
    assert first.row_counts() == TINY_ROWS


def test_another_seed_or_another_day_gives_other_data() -> None:
    """The digest moves with the seed and with the as-of day, since every date is relative to it."""
    base = generate(SIZES["tiny"], DATA_AS_OF, DATA_SEED).digest
    assert generate(SIZES["tiny"], DATA_AS_OF, DATA_SEED + 1).digest != base
    assert generate(SIZES["tiny"], date(2026, 11, 19), DATA_SEED).digest != base


def test_the_sizes_are_what_the_datasheet_says() -> None:
    """The full set is the datasheet's two million orders' worth of customers; small and tiny are for tests."""
    assert SIZES["full"].customers == 385_000
    assert SIZES["small"].customers == 6_000
    assert SIZES["tiny"].customers == 500


def test_the_small_dataset_has_the_expected_shape(warehouse: Warehouse) -> None:
    """The row counts the other tests rely on."""
    assert warehouse.meta.rows == {
        "customers": 6000,
        "products": 12,
        "orders": 28435,
        "order_lines": 43497,
        "subscriptions": 776,
    }


# Each table's key: how many rows share a key with another, and how many have none.
KEY_QUERIES = {
    "customers": "SELECT COUNT(*) - COUNT(DISTINCT customer_id), COUNT(*) - COUNT(customer_id) FROM customers",
    "products": "SELECT COUNT(*) - COUNT(DISTINCT product_id), COUNT(*) - COUNT(product_id) FROM products",
    "orders": "SELECT COUNT(*) - COUNT(DISTINCT order_id), COUNT(*) - COUNT(order_id) FROM orders",
    "order_lines": "SELECT COUNT(*) - COUNT(DISTINCT line_id), COUNT(*) - COUNT(line_id) FROM order_lines",
    "subscriptions": (
        "SELECT COUNT(*) - COUNT(DISTINCT subscription_id), COUNT(*) - COUNT(subscription_id) FROM subscriptions"
    ),
}

# Rows that refer to a row that is not there. A NULL refers to nothing, which is allowed.
ORPHAN_QUERIES = {
    "orders to customers": "SELECT COUNT(*) FROM orders WHERE customer_id NOT IN (SELECT customer_id FROM customers)",
    "lines to orders": "SELECT COUNT(*) FROM order_lines WHERE order_id NOT IN (SELECT order_id FROM orders)",
    "lines to products": "SELECT COUNT(*) FROM order_lines WHERE product_id NOT IN (SELECT product_id FROM products)",
    "subscriptions to customers": (
        "SELECT COUNT(*) FROM subscriptions WHERE customer_id NOT IN (SELECT customer_id FROM customers)"
    ),
    "subscriptions to products": (
        "SELECT COUNT(*) FROM subscriptions WHERE product_id NOT IN (SELECT product_id FROM products)"
    ),
    "orders to subscriptions": (
        "SELECT COUNT(*) FROM orders WHERE subscription_id IS NOT NULL "
        "AND subscription_id NOT IN (SELECT subscription_id FROM subscriptions)"
    ),
}

# Rows where the money does not add up: each query counts the exceptions, and there must be none.
MONEY_QUERIES = {
    "a line's total is quantity times price less discount": (
        "SELECT COUNT(*) FROM order_lines WHERE line_total_czk <> quantity * unit_price_czk - discount_czk"
    ),
    "a line is sold at the product's list price": (
        "SELECT COUNT(*) FROM order_lines AS l JOIN products AS p ON p.product_id = l.product_id "
        "WHERE l.unit_price_czk <> p.price_czk"
    ),
    "an order's total is its lines plus delivery": (
        "SELECT COUNT(*) FROM orders AS o "
        "JOIN (SELECT order_id, SUM(line_total_czk) AS items FROM order_lines GROUP BY 1) AS l "
        "ON l.order_id = o.order_id "
        "WHERE o.total_czk <> l.items + o.shipping_czk"
    ),
    "every order has a line": (
        "SELECT COUNT(*) FROM orders AS o "
        "WHERE NOT EXISTS (SELECT 1 FROM order_lines AS l WHERE l.order_id = o.order_id)"
    ),
}

# Things that happen before they could: each query counts the exceptions, and there must be none.
DATE_QUERIES = {
    "an order before its customer registered": (
        "SELECT COUNT(*) FROM orders AS o JOIN customers AS c ON c.customer_id = o.customer_id "
        "WHERE o.ordered_at < c.signup_date"
    ),
    "a subscription before its customer registered": (
        "SELECT COUNT(*) FROM subscriptions AS s JOIN customers AS c ON c.customer_id = s.customer_id "
        "WHERE s.started_at < c.signup_date"
    ),
    "a cancellation before the start": "SELECT COUNT(*) FROM subscriptions WHERE cancelled_at < started_at",
}


@pytest.mark.parametrize("table", KEY_QUERIES)
def test_every_key_is_unique_and_present(warehouse: Warehouse, table: str) -> None:
    """Each table's key identifies one row: none repeats and none is missing."""
    assert rows(warehouse, KEY_QUERIES[table]) == [(0, 0)]


@pytest.mark.parametrize("reference", ORPHAN_QUERIES)
def test_every_reference_points_at_a_row(warehouse: Warehouse, reference: str) -> None:
    """No order, line or subscription refers to a row that is not there."""
    assert number(warehouse, ORPHAN_QUERIES[reference]) == 0


@pytest.mark.parametrize("rule", MONEY_QUERIES)
def test_the_money_adds_up(warehouse: Warehouse, rule: str) -> None:
    """Prices, discounts, delivery and totals agree, for every line and every order."""
    assert number(warehouse, MONEY_QUERIES[rule]) == 0


def test_the_data_ends_on_the_as_of_day(warehouse: Warehouse) -> None:
    """The last order is on the as-of day, so nothing is dated after it."""
    assert number(warehouse, "SELECT MAX(ordered_at) FROM orders") == DATA_AS_OF.isoformat()


@pytest.mark.parametrize("rule", DATE_QUERIES)
def test_nothing_happens_before_it_could(warehouse: Warehouse, rule: str) -> None:
    """A customer's orders and subscriptions come after they registered, and a cancellation after the start."""
    assert number(warehouse, DATE_QUERIES[rule]) == 0


def test_a_subscription_is_cancelled_exactly_when_it_has_a_date_and_a_reason(warehouse: Warehouse) -> None:
    """Only cancelled subscriptions carry a cancellation date and reason."""
    found = rows(
        warehouse,
        "SELECT status, COUNT(*), COUNT(cancelled_at), COUNT(cancel_reason) FROM subscriptions GROUP BY 1 ORDER BY 1",
    )
    for status, total, with_date, with_reason in found:
        expected = total if status == "cancelled" else 0
        assert (with_date, with_reason) == (expected, expected), status


def test_subscription_orders_are_the_ones_with_a_subscription(warehouse: Warehouse) -> None:
    """The source says `subscription` exactly when the order has a subscription."""
    mismatched = number(
        warehouse, "SELECT COUNT(*) FROM orders WHERE (source = 'subscription') <> (subscription_id IS NOT NULL)"
    )
    assert mismatched == 0


def test_equipment_has_no_bag_roast_or_origin(warehouse: Warehouse) -> None:
    """Only coffee has a bag size, a roast and an origin."""
    found = rows(
        warehouse,
        "SELECT kind, COUNT(*), COUNT(bag_grams), COUNT(roast), COUNT(origin) FROM products GROUP BY 1 ORDER BY 1",
    )
    assert found == [("coffee", 10, 10, 10, 10), ("equipment", 2, 0, 0, 0)]


def count_outside(warehouse: Warehouse, table: str, column: str, listed: list[str | int]) -> int:
    """Count the values of a column that are not in a list, with the relational API and so with no SQL text to build."""
    values = ColumnExpression(column)
    outside = values.isnotnull() & ~values.isin(*[ConstantExpression(value) for value in listed])
    counted = warehouse._connection.table(table).filter(outside).count("*").fetchone()
    assert counted is not None
    return int(counted[0])


def test_values_stay_inside_the_lists_the_layer_gives(layer: SemanticLayer, warehouse: Warehouse) -> None:
    """A column the layer lists the values of holds no other value, so a question that uses them finds rows."""
    checked = 0
    for table in layer.tables:
        for column in table.columns:
            if column.values:
                assert count_outside(warehouse, table.name, column.name, column.values) == 0, (
                    f"{table.name}.{column.name}"
                )
                checked += 1
    assert checked >= 15


def test_market_stall_orders_are_taken_at_weekends(warehouse: Warehouse) -> None:
    """The stall is open on Saturday and Sunday only (DuckDB counts Sunday as 0 and Saturday as 6)."""
    days = rows(warehouse, "SELECT DISTINCT DAYOFWEEK(ordered_at) FROM orders WHERE source = 'market_stall' ORDER BY 1")
    assert days == [(0,), (6,)]


def test_the_data_holds_no_real_people(warehouse: Warehouse) -> None:
    """Emails are numbered addresses on a reserved test domain, and every payment reference is unique."""
    assert number(warehouse, "SELECT COUNT(*) FROM customers WHERE email NOT LIKE 'customer-%@example.test'") == 0
    assert number(warehouse, "SELECT COUNT(DISTINCT email) FROM customers") == 6000
    assert number(warehouse, "SELECT COUNT(*) - COUNT(DISTINCT payment_reference) FROM orders") == 0


def units_by_quarter(warehouse: Warehouse) -> dict[tuple[str, str], int]:
    """Count the bags sold of the two coffees in the story, by the first day of each quarter."""
    found = rows(
        warehouse,
        "SELECT p.name, DATE_TRUNC('quarter', o.ordered_at), SUM(l.quantity) "
        "FROM orders AS o JOIN order_lines AS l ON l.order_id = o.order_id "
        "JOIN products AS p ON p.product_id = l.product_id "
        "WHERE p.name IN ('Kenya Nyeri', 'Ethiopia Guji') AND o.status NOT IN ('cancelled', 'lost') GROUP BY 1, 2",
    )
    return {(str(name), str(quarter)[:10]): int(str(units)) for name, quarter, units in found}


def test_kenya_nyeri_runs_out_of_stock_last_quarter_and_guji_takes_its_buyers(warehouse: Warehouse) -> None:
    """The story the headline question finds: Kenya Nyeri sells far less in the last quarter, Ethiopia Guji far more."""
    units = units_by_quarter(warehouse)
    assert units["Kenya Nyeri", "2026-07-01"] < 0.5 * units["Kenya Nyeri", "2026-04-01"]
    assert units["Ethiopia Guji", "2026-07-01"] > 1.5 * units["Ethiopia Guji", "2026-04-01"]


def test_sales_grow_year_on_year(warehouse: Warehouse) -> None:
    """Revenue in the last quarter is well above the same quarter a year earlier."""
    found = rows(
        warehouse,
        "SELECT DATE_TRUNC('quarter', o.ordered_at), SUM(l.line_total_czk) "
        "FROM orders AS o JOIN order_lines AS l ON l.order_id = o.order_id "
        "WHERE o.status NOT IN ('cancelled', 'lost') GROUP BY 1",
    )
    revenue = {str(quarter)[:10]: int(str(total)) for quarter, total in found}
    assert revenue["2026-07-01"] > 1.2 * revenue["2025-07-01"]


def test_orders_rise_before_christmas(warehouse: Warehouse) -> None:
    """December has more orders a day than November, and November more than the summer."""
    found = rows(warehouse, "SELECT MONTH(ordered_at), COUNT(*) FROM orders WHERE YEAR(ordered_at) = 2025 GROUP BY 1")
    per_month = {int(str(month)): int(str(count)) for month, count in found}
    assert per_month[12] / 31 > 1.05 * (per_month[11] / 30)
    assert per_month[11] / 30 > per_month[7] / 31


def test_the_products_match_the_catalogue_of_the_order_lookup_tool(warehouse: Warehouse) -> None:
    """LB-01's seed names coffees and equipment at prices; LB-05's products are the same, at the same prices."""
    seed = yaml.safe_load((REPOSITORY_ROOT / "data" / "seed" / "lb01" / "orders.yaml").read_text(encoding="utf-8"))
    products = {
        (str(name), None if grams is None else int(grams)): int(price)
        for name, grams, price in rows(warehouse, "SELECT name, bag_grams, price_czk FROM products")
        if isinstance(name, str) and isinstance(price, int) and (grams is None or isinstance(grams, int))
    }
    seen = 0
    for order in seed["orders"]:
        for item in order["items"]:
            grams = item.get("grams") if item["kind"] == "coffee" else None
            assert products[(item["product"], grams)] == item["price_czk"], item["product"]
            seen += 1
    assert seen >= 20


def test_the_hidden_columns_are_in_the_data_and_not_in_the_layer(layer: SemanticLayer, warehouse: Warehouse) -> None:
    """The warehouse holds the two columns the layer leaves out, so the allowlist has something to hide."""
    assert number(warehouse, "SELECT COUNT(email) FROM customers") == 6000
    assert number(warehouse, "SELECT COUNT(payment_reference) FROM orders") == 28435
    assert "email" not in layer.allowed_columns()["customers"]
    assert "payment_reference" not in layer.allowed_columns()["orders"]


def test_the_database_holds_the_same_tables_the_layer_describes(layer: SemanticLayer, warehouse: Warehouse) -> None:
    """The warehouse matches the semantic layer, which is checked when the service starts."""
    warehouse.check_matches(layer)


def test_writing_a_dataset_leaves_parquet_a_database_and_a_record(tmp_path: Path) -> None:
    """The folder holds a Parquet file per table, the DuckDB file and meta.json, and nothing else."""
    directory = tmp_path / "data"
    meta = write_dataset(generate(SIZES["tiny"], DATA_AS_OF, DATA_SEED), directory)
    names = {path.name for path in directory.iterdir()}
    assert names == {f"{table}.parquet" for table in TABLES} | {DATABASE_FILE, META_FILE}
    assert meta.digest == TINY_DIGEST
    assert meta.generator_version == GENERATOR_VERSION
    assert (meta.as_of, meta.seed, meta.size, meta.rows) == (DATA_AS_OF, DATA_SEED, "tiny", TINY_ROWS)
    assert not [path for path in tmp_path.iterdir() if path.name.startswith(".")]


def test_writing_again_replaces_the_folder_whole(tmp_path: Path) -> None:
    """A second write swaps the new data in, and leaves no staging folder behind."""
    directory = tmp_path / "data"
    write_dataset(generate(SIZES["tiny"], DATA_AS_OF, DATA_SEED), directory)
    meta = write_dataset(generate(SIZES["tiny"], DATA_AS_OF, DATA_SEED + 1), directory)
    assert meta.seed == DATA_SEED + 1
    assert read_meta(directory).seed == DATA_SEED + 1
    assert sorted(path.name for path in tmp_path.iterdir()) == ["data"]


def test_a_folder_without_a_record_is_not_a_dataset(tmp_path: Path) -> None:
    """The service refuses a folder with no meta.json, and says how to make one."""
    with pytest.raises(WarehouseMetaError, match="just seed-lb05"):
        read_meta(tmp_path)


def test_a_malformed_record_is_refused(tmp_path: Path) -> None:
    """A meta.json that is not valid is refused, and the message names the file."""
    (tmp_path / META_FILE).write_text('{"as_of": "yesterday"}', encoding="utf-8")
    with pytest.raises(WarehouseMetaError, match=r"meta\.json"):
        read_meta(tmp_path)


def test_data_from_another_generator_version_is_refused(tmp_path: Path) -> None:
    """A folder an older generator wrote is not served: its columns may not be the ones the layer describes."""
    directory = tmp_path / "data"
    meta = write_dataset(generate(SIZES["tiny"], DATA_AS_OF, DATA_SEED), directory)
    record = directory / META_FILE
    record.write_text(
        record.read_text(encoding="utf-8").replace(
            f'"generator_version": {meta.generator_version}', '"generator_version": 0'
        ),
        encoding="utf-8",
    )
    with pytest.raises(WarehouseMetaError, match="another generator version"):
        read_meta(directory)
