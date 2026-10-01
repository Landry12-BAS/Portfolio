"""Tests for the parse-tree check (lb05/sql_policy.py): what it accepts, and what it refuses and why."""

import logging

import pytest

from lb05 import sql_policy
from lb05.safety import MAX_ROWS, Layer, Rule, SqlRejectedError
from lb05.semantic_layer import SemanticLayer
from lb05.sql_policy import SqlPolicy, ValidatedQuery

# Queries a question can reasonably need: each must be accepted.
ACCEPTED = {
    "count": "SELECT COUNT(*) FROM orders",
    "trailing-semicolons": "SELECT COUNT(*) FROM orders;;;",
    "semicolon-in-a-string": "SELECT 'a; DROP TABLE orders' AS note",
    "quoted-identifiers": 'SELECT "orders"."order_id" FROM "orders"',
    "tabs-and-line-breaks": "SELECT\t1\r\nFROM\torders",
    "join": (
        "SELECT orders.status, SUM(order_lines.line_total_czk) AS revenue "
        "FROM orders JOIN order_lines ON order_lines.order_id = orders.order_id GROUP BY 1"
    ),
    "join-by-alias": (
        "SELECT o.order_id FROM orders AS o JOIN order_lines AS l ON l.order_id = o.order_id WHERE l.quantity > 1"
    ),
    "left-join": (
        "SELECT c.customer_id FROM customers AS c LEFT JOIN orders AS o ON o.customer_id = c.customer_id "
        "WHERE o.order_id IS NULL"
    ),
    "join-with-an-extra-condition": (
        "SELECT COUNT(*) FROM orders "
        "JOIN order_lines ON order_lines.order_id = orders.order_id AND order_lines.quantity > 1"
    ),
    "three-tables": (
        "SELECT products.name, COUNT(*) FROM orders "
        "JOIN order_lines ON order_lines.order_id = orders.order_id "
        "JOIN products ON products.product_id = order_lines.product_id GROUP BY 1"
    ),
    "date-truncation": "SELECT DATE_TRUNC('month', ordered_at) AS m, COUNT(*) FROM orders GROUP BY m ORDER BY m",
    "date-arithmetic": "SELECT order_id FROM orders WHERE ordered_at > DATE '2026-01-01' + INTERVAL 1 DAY",
    "date-parts": "SELECT EXTRACT(year FROM ordered_at), YEAR(ordered_at), DAYNAME(ordered_at) FROM orders",
    "date-difference": "SELECT DATE_DIFF('day', signup_date, DATE '2026-11-18') FROM customers",
    "between-and-in": (
        "SELECT order_id FROM orders WHERE ordered_at BETWEEN DATE '2026-01-01' AND DATE '2026-03-31' "
        "AND status IN ('shipped', 'delivered')"
    ),
    "like": "SELECT city FROM customers WHERE city LIKE 'P%' OR city ILIKE '%ve'",
    "case": "SELECT CASE WHEN total_czk > 1000 THEN 'big' ELSE 'small' END AS size, COUNT(*) FROM orders GROUP BY 1",
    "casts": "SELECT CAST(total_czk AS DOUBLE) / 3, total_czk::DECIMAL(10, 2) FROM orders",
    "filter-clause": "SELECT SUM(total_czk) FILTER (WHERE status = 'delivered') FROM orders",
    "distinct-and-having": (
        "SELECT status, COUNT(DISTINCT customer_id) AS buyers FROM orders GROUP BY status HAVING COUNT(*) > 5"
    ),
    "window-functions": (
        "SELECT customer_id, ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY ordered_at) AS n, "
        "LAG(total_czk) OVER (PARTITION BY customer_id ORDER BY ordered_at ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) "
        "FROM orders"
    ),
    "statistics": (
        "SELECT STDDEV(total_czk), VARIANCE(total_czk), MEDIAN(total_czk), QUANTILE_CONT(total_czk, 0.9) FROM orders"
    ),
    "subquery-in": "SELECT * FROM orders WHERE order_id IN (SELECT order_id FROM order_lines WHERE quantity > 2)",
    "correlated-exists": (
        "SELECT order_id FROM orders WHERE EXISTS "
        "(SELECT 1 FROM order_lines WHERE order_lines.order_id = orders.order_id)"
    ),
    "derived-table": (
        "SELECT t.status FROM (SELECT status, COUNT(*) AS n FROM orders GROUP BY status) AS t WHERE t.n > 1"
    ),
    "with-queries": (
        "WITH big AS (SELECT order_id FROM orders WHERE total_czk > 1000) "
        "SELECT COUNT(*) FROM big JOIN order_lines ON order_lines.order_id = big.order_id"
    ),
    "with-queries-joined-on-any-columns": (
        "WITH a AS (SELECT customer_id, ordered_at FROM orders), b AS (SELECT customer_id, signup_date FROM customers) "
        "SELECT COUNT(*) FROM a JOIN b ON a.customer_id = b.customer_id AND a.ordered_at > b.signup_date"
    ),
    "set-operation": "SELECT city FROM customers UNION SELECT ship_country FROM orders",
    "select-without-from": "SELECT 1 + 1 AS two",
    "string-functions": (
        "SELECT UPPER(city) || ', ' || CONCAT(country, '!'), LENGTH(city), SUBSTRING(city, 1, 3) FROM customers"
    ),
    "coalesce-and-nullif": "SELECT COALESCE(subscription_id, 0), NULLIF(total_czk, 0) FROM orders",
}


def accepted(policy: SqlPolicy, sql: str) -> ValidatedQuery:
    """Check a query that must be accepted, and return what the check made of it."""
    return policy.validate(sql)


def refused(policy: SqlPolicy, sql: str) -> SqlRejectedError:
    """Check a query that must be refused, and return the refusal."""
    with pytest.raises(SqlRejectedError) as stopped:
        policy.validate(sql)
    return stopped.value


@pytest.mark.parametrize("sql", ACCEPTED.values(), ids=ACCEPTED.keys())
def test_accepts_the_queries_a_question_needs(policy: SqlPolicy, sql: str) -> None:
    """Everyday analytical SQL passes, and always comes back with a row cap."""
    checked = accepted(policy, sql)
    assert checked.row_limit <= MAX_ROWS
    assert "LIMIT" in checked.sql


@pytest.mark.parametrize("sql", ACCEPTED.values(), ids=ACCEPTED.keys())
def test_what_runs_is_a_fixed_point_of_the_check(policy: SqlPolicy, sql: str) -> None:
    """The rendered SQL is accepted again and renders the same: DuckDB runs exactly what was checked."""
    first = accepted(policy, sql).sql
    assert accepted(policy, first).sql == first


def test_the_layers_reference_queries_are_accepted(layer: SemanticLayer, policy: SqlPolicy) -> None:
    """The worked examples in the semantic layer pass the check (the layer's loader already requires it)."""
    for metric in layer.metrics:
        if metric.pattern is not None:
            accepted(policy, metric.pattern)


def test_a_star_is_expanded_to_the_columns_the_layer_lists(policy: SqlPolicy) -> None:
    """The hidden columns exist in the database, but never come out of a star."""
    customers = accepted(policy, "SELECT * FROM customers").sql
    orders = accepted(policy, "SELECT * FROM orders").sql
    assert "email" not in customers
    assert "payment_reference" not in orders
    assert "customers.country" in customers
    assert "orders.shipping_czk" in orders


def test_columns_are_named_with_their_tables(policy: SqlPolicy) -> None:
    """Every column in the rendered SQL is qualified, so it can't be read as anything else."""
    rendered = accepted(policy, "SELECT status, total_czk FROM orders WHERE status = 'delivered'").sql
    assert "orders.status" in rendered
    assert "orders.total_czk" in rendered


def test_comments_are_not_passed_on(policy: SqlPolicy) -> None:
    """A comment never reaches DuckDB, whatever it says."""
    rendered = accepted(policy, "SELECT 1 /* a secret */ -- another\nFROM orders").sql
    assert "secret" not in rendered
    assert "another" not in rendered
    assert "--" not in rendered
    assert "/*" not in rendered


def test_nested_comments_read_as_duckdb_reads_them(policy: SqlPolicy) -> None:
    """DuckDB nests block comments, and so does the parser: what looks like a second statement is inside one comment."""
    checked = accepted(policy, "SELECT 1 /* a /* b */ ; DROP TABLE orders; /* c */ */")
    assert "DROP" not in checked.sql


def test_a_smaller_limit_is_kept_and_a_larger_one_is_lowered(policy: SqlPolicy) -> None:
    """The row cap is a ceiling: a query that asks for fewer rows gets fewer."""
    own = accepted(policy, "SELECT * FROM orders LIMIT 5")
    assert (own.row_limit, own.limit_applied) == (5, False)
    larger = accepted(policy, "SELECT * FROM orders LIMIT 5000")
    assert (larger.row_limit, larger.limit_applied) == (MAX_ROWS, True)
    none = accepted(policy, "SELECT * FROM orders")
    assert (none.row_limit, none.limit_applied) == (MAX_ROWS, True)
    assert none.sql.rstrip().endswith(f"LIMIT {MAX_ROWS}")


def test_the_cap_also_covers_a_set_operation(policy: SqlPolicy) -> None:
    """A UNION is one query, and the cap is set on the whole of it."""
    checked = accepted(policy, "SELECT city FROM customers UNION ALL SELECT ship_country FROM orders")
    assert checked.row_limit == MAX_ROWS
    assert checked.sql.rstrip().endswith(f"LIMIT {MAX_ROWS}")


def test_it_reports_the_tables_and_joins_a_query_uses(policy: SqlPolicy) -> None:
    """The physical tables read and the number of joins are reported, for the trace."""
    checked = accepted(
        policy,
        "WITH big AS (SELECT order_id FROM orders WHERE total_czk > 1000) "
        "SELECT COUNT(*) FROM big JOIN order_lines ON order_lines.order_id = big.order_id",
    )
    assert checked.tables == ("order_lines", "orders")
    assert checked.joins == 1


# What each refusal must say: the layer, the rule, and whether a second try is worth it.
REFUSED = {
    "empty": ("", Layer.PARSE, Rule.EMPTY),
    "blank": ("  \n\t ", Layer.PARSE, Rule.EMPTY),
    "only-semicolons": (";;", Layer.PARSE, Rule.EMPTY),
    "too-long": ("SELECT " + "1," * 3000 + "1", Layer.PARSE, Rule.TOO_LONG),
    "control-character": ("SELECT 1\x07", Layer.PARSE, Rule.INVALID_CHARACTERS),
    "zero-width-space": ("SELECT\u200b1", Layer.PARSE, Rule.INVALID_CHARACTERS),
    "syntax": ("SELECT * FROM", Layer.PARSE, Rule.SYNTAX_ERROR),
    "unterminated-string": ("SELECT 'abc", Layer.PARSE, Rule.SYNTAX_ERROR),
    "two-statements": ("SELECT 1; SELECT 2", Layer.PARSE, Rule.MULTIPLE_STATEMENTS),
    "statement-after-comment": ("SELECT 1; -- x\nSELECT 2", Layer.PARSE, Rule.MULTIPLE_STATEMENTS),
    "not-a-query": ("DELETE FROM orders", Layer.PARSE, Rule.NOT_SELECT),
    "with-but-not-a-query": ("WITH x AS (SELECT 1) DELETE FROM orders", Layer.PARSE, Rule.NOT_SELECT),
    "values": ("VALUES (1), (2)", Layer.PARSE, Rule.NOT_SELECT),
    "order-after-parentheses": ("(SELECT 1) ORDER BY 1", Layer.ALLOWLIST, Rule.CONSTRUCT_NOT_ALLOWED),
    "schema-in-front": ("SELECT * FROM main.orders", Layer.ALLOWLIST, Rule.CATALOG_ACCESS),
    "path-as-table": ("SELECT * FROM '/etc/passwd'", Layer.ALLOWLIST, Rule.FILE_ACCESS),
    "windows-path-as-table": ('SELECT * FROM "C:\\data\\x.csv"', Layer.ALLOWLIST, Rule.FILE_ACCESS),
    "table-function": ("SELECT * FROM range(10)", Layer.ALLOWLIST, Rule.TABLE_FUNCTION),
    "unknown-table": ("SELECT * FROM employees", Layer.ALLOWLIST, Rule.UNKNOWN_TABLE),
    "file-name-without-a-path": ("SELECT * FROM 'data.csv'", Layer.ALLOWLIST, Rule.UNKNOWN_TABLE),
    "hidden-column": ("SELECT email FROM customers", Layer.ALLOWLIST, Rule.UNKNOWN_COLUMN),
    "unknown-column": ("SELECT nothing FROM orders", Layer.ALLOWLIST, Rule.UNKNOWN_COLUMN),
    "ambiguous-column": (
        "SELECT customer_id FROM orders JOIN customers ON customers.customer_id = orders.customer_id",
        Layer.ALLOWLIST,
        Rule.UNKNOWN_COLUMN,
    ),
    "column-of-another-table": ("SELECT orders.country FROM orders", Layer.ALLOWLIST, Rule.UNKNOWN_COLUMN),
    "unknown-function": ("SELECT frobnicate(1)", Layer.ALLOWLIST, Rule.FUNCTION_NOT_ALLOWED),
    "random": ("SELECT RANDOM()", Layer.ALLOWLIST, Rule.FUNCTION_NOT_ALLOWED),
    "the-clock": ("SELECT * FROM orders WHERE ordered_at > CURRENT_DATE", Layer.ALLOWLIST, Rule.FUNCTION_NOT_ALLOWED),
    "string-aggregate": ("SELECT STRING_AGG(status, ',') FROM orders", Layer.ALLOWLIST, Rule.FUNCTION_NOT_ALLOWED),
    "list-aggregate": ("SELECT LIST(status) FROM orders", Layer.ALLOWLIST, Rule.FUNCTION_NOT_ALLOWED),
    "group-by-all": ("SELECT status, COUNT(*) FROM orders GROUP BY ALL", Layer.ALLOWLIST, Rule.CONSTRUCT_NOT_ALLOWED),
    "offset": ("SELECT * FROM orders LIMIT 5 OFFSET 5", Layer.ALLOWLIST, Rule.CONSTRUCT_NOT_ALLOWED),
    "qualify": ("SELECT 1 FROM orders QUALIFY ROW_NUMBER() OVER () = 1", Layer.ALLOWLIST, Rule.CONSTRUCT_NOT_ALLOWED),
    "sample": ("SELECT * FROM orders TABLESAMPLE 10 PERCENT", Layer.ALLOWLIST, Rule.CONSTRUCT_NOT_ALLOWED),
    "recursive-with": (
        "WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t) SELECT n FROM t",
        Layer.ALLOWLIST,
        Rule.CONSTRUCT_NOT_ALLOWED,
    ),
    "rollup": (
        "SELECT status, COUNT(*) FROM orders GROUP BY ROLLUP (status)",
        Layer.ALLOWLIST,
        Rule.CONSTRUCT_NOT_ALLOWED,
    ),
    "placeholder": ("SELECT * FROM orders WHERE order_id = $1", Layer.ALLOWLIST, Rule.CONSTRUCT_NOT_ALLOWED),
    "star-modifier": ("SELECT * EXCLUDE (status) FROM orders", Layer.ALLOWLIST, Rule.CONSTRUCT_NOT_ALLOWED),
    "select-into": ("SELECT * INTO copy FROM orders", Layer.ALLOWLIST, Rule.CONSTRUCT_NOT_ALLOWED),
    "values-as-a-table": ("SELECT * FROM (VALUES (1)) AS v(x)", Layer.ALLOWLIST, Rule.CONSTRUCT_NOT_ALLOWED),
    "cast-to-json": ("SELECT CAST(status AS JSON) FROM orders", Layer.ALLOWLIST, Rule.CONSTRUCT_NOT_ALLOWED),
    "cast-to-a-list-type": ("SELECT CAST(1 AS INTEGER[])", Layer.ALLOWLIST, Rule.CONSTRUCT_NOT_ALLOWED),
    "date-part-that-is-a-word": (
        "SELECT EXTRACT(banana FROM ordered_at) FROM orders",
        Layer.ALLOWLIST,
        Rule.CONSTRUCT_NOT_ALLOWED,
    ),
    "right-join": (
        "SELECT 1 FROM orders RIGHT JOIN customers ON customers.customer_id = orders.customer_id",
        Layer.ALLOWLIST,
        Rule.JOIN_NOT_ALLOWED,
    ),
    "full-join": (
        "SELECT 1 FROM orders FULL JOIN customers ON customers.customer_id = orders.customer_id",
        Layer.ALLOWLIST,
        Rule.JOIN_NOT_ALLOWED,
    ),
    "cross-join": ("SELECT 1 FROM orders CROSS JOIN customers", Layer.ALLOWLIST, Rule.JOIN_NOT_ALLOWED),
    "comma-join": ("SELECT 1 FROM orders, customers", Layer.ALLOWLIST, Rule.JOIN_NOT_ALLOWED),
    "join-without-a-condition": ("SELECT 1 FROM orders JOIN customers", Layer.ALLOWLIST, Rule.JOIN_NOT_ALLOWED),
    "join-on-an-inequality": (
        "SELECT 1 FROM orders JOIN customers ON customers.customer_id > orders.customer_id",
        Layer.ALLOWLIST,
        Rule.JOIN_NOT_ALLOWED,
    ),
    "join-on-undeclared-columns": (
        "SELECT 1 FROM orders JOIN customers ON customers.city = orders.carrier",
        Layer.ALLOWLIST,
        Rule.JOIN_NOT_ALLOWED,
    ),
    "join-using": (
        "SELECT 1 FROM orders JOIN customers USING (customer_id)",
        Layer.ALLOWLIST,
        Rule.CONSTRUCT_NOT_ALLOWED,
    ),
    "natural-join": ("SELECT 1 FROM orders NATURAL JOIN customers", Layer.ALLOWLIST, Rule.CONSTRUCT_NOT_ALLOWED),
    "join-with-a-condition-that-ignores-the-new-table": (
        "SELECT 1 FROM orders JOIN customers ON orders.customer_id = orders.customer_id",
        Layer.ALLOWLIST,
        Rule.JOIN_NOT_ALLOWED,
    ),
    "limit-that-is-text": ("SELECT * FROM orders LIMIT '5'", Layer.ALLOWLIST, Rule.LIMIT_NOT_ALLOWED),
    "limit-that-is-a-fraction": ("SELECT * FROM orders LIMIT 1.5", Layer.ALLOWLIST, Rule.LIMIT_NOT_ALLOWED),
    "limit-that-is-negative": ("SELECT * FROM orders LIMIT -1", Layer.ALLOWLIST, Rule.LIMIT_NOT_ALLOWED),
    "limit-that-is-a-query": ("SELECT * FROM orders LIMIT (SELECT 5)", Layer.ALLOWLIST, Rule.LIMIT_NOT_ALLOWED),
    "too-many-columns": (
        "SELECT orders.order_id AS c0, orders.order_id AS c1, orders.order_id AS c2, orders.order_id AS c3, "
        "orders.order_id AS c4, orders.order_id AS c5, orders.order_id AS c6, orders.order_id AS c7, "
        "orders.order_id AS c8, orders.order_id AS c9, orders.order_id AS c10, orders.order_id AS c11, "
        "orders.order_id AS c12 FROM orders",
        Layer.ALLOWLIST,
        Rule.TOO_MANY_COLUMNS,
    ),
}


@pytest.mark.parametrize(("sql", "stopped_by", "rule"), REFUSED.values(), ids=REFUSED.keys())
def test_refuses_what_it_must_and_names_the_layer_and_rule(
    policy: SqlPolicy, sql: str, stopped_by: Layer, rule: Rule
) -> None:
    """Each refusal names the layer that made it and the rule it broke."""
    refusal = refused(policy, sql)
    assert (refusal.layer, refusal.rule) == (stopped_by, rule)
    assert refusal.message


@pytest.mark.parametrize(
    ("sql", "retryable"),
    [
        ("DROP TABLE orders", False),
        ("SELECT 1; SELECT 2", False),
        ("SELECT * FROM read_csv('/etc/passwd')", False),
        ("SELECT * FROM '/etc/passwd'", False),
        ("SELECT * FROM main.orders", False),
        ("SELECT email FROM customers", True),
        ("SELECT * FROM employees", True),
        ("SELECT frobnicate(1)", True),
        ("SELECT * FROM orders CROSS JOIN customers", True),
        ("SELECT * FROM", True),
    ],
)
def test_attacks_are_not_retried_and_mistakes_are(policy: SqlPolicy, sql: str, retryable: bool) -> None:
    """A model that wrote an attack is not asked to try again; one that made a mistake is."""
    assert refused(policy, sql).retryable is retryable


def test_the_message_for_an_unknown_function_lists_what_is_allowed(policy: SqlPolicy) -> None:
    """The refusal teaches the model the way out: the allowed functions are named."""
    message = refused(policy, "SELECT frobnicate(1)").message
    assert "frobnicate" in message
    assert "SUM" in message
    assert "QUANTILE_CONT" in message


def test_the_message_for_a_refused_join_lists_the_declared_joins(policy: SqlPolicy) -> None:
    """A refused join says which joins the layer declares."""
    message = refused(policy, "SELECT 1 FROM orders, customers").message
    assert "customers.customer_id = orders.customer_id" in message


def test_the_message_for_an_unknown_table_lists_the_tables(policy: SqlPolicy) -> None:
    """An unknown table's refusal lists the tables there are, so the model can say the data isn't there."""
    message = refused(policy, "SELECT * FROM employees").message
    assert "customers" in message
    assert "subscriptions" in message


def test_a_syntax_error_says_where_and_does_not_repeat_the_query(policy: SqlPolicy) -> None:
    """The message points at a line and column, and never quotes the text that was sent."""
    message = refused(policy, "SELECT secret_marker_text FROM WHERE").message
    assert "line 1" in message
    assert "secret_marker_text" not in message


def test_a_very_deeply_nested_query_is_refused_without_a_crash(policy: SqlPolicy) -> None:
    """Parentheses nested past the recursion limit are refused as too complex, not allowed to raise."""
    sql = "SELECT " + "(" * 1500 + "1" + ")" * 1500
    assert refused(policy, sql).rule == Rule.TOO_COMPLEX


def test_a_query_with_very_many_nodes_is_refused(policy: SqlPolicy) -> None:
    """A long sum has too many nodes to check in reasonable time."""
    sql = "SELECT " + "+".join(["1"] * 1900)
    assert refused(policy, sql).rule == Rule.TOO_COMPLEX


def test_sqlglot_does_not_log_the_query(policy: SqlPolicy, caplog: pytest.LogCaptureFixture) -> None:
    """The parser's own logging is off, so a visitor's words never reach the service's logs through it."""
    with caplog.at_level(logging.DEBUG):
        refused(policy, "SELECT visitor_marker_words FROM")
    assert not [record for record in caplog.records if record.name.startswith("sqlglot")]
    assert "visitor_marker_words" not in caplog.text


def test_a_bug_in_a_check_refuses_the_query(policy: SqlPolicy, monkeypatch: pytest.MonkeyPatch) -> None:
    """Any exception while checking fails closed: the query is refused, and the exception's text is not passed on."""

    def broken(*_: object) -> None:
        """Fail the way a bug would."""
        raise RuntimeError("internal detail that must not leak")

    monkeypatch.setattr(sql_policy, "check_tree", broken)
    refusal = refused(policy, "SELECT 1")
    assert (refusal.layer, refusal.rule, refusal.retryable) == (Layer.ALLOWLIST, Rule.CHECK_FAILED, False)
    assert "internal detail" not in refusal.message


def test_running_out_of_stack_is_a_refusal(policy: SqlPolicy, monkeypatch: pytest.MonkeyPatch) -> None:
    """A recursion error anywhere in the check is a refusal for complexity."""

    def too_deep(*_: object) -> None:
        """Run out of stack."""
        raise RecursionError

    monkeypatch.setattr(sql_policy, "check_tree", too_deep)
    assert refused(policy, "SELECT 1").rule == Rule.TOO_COMPLEX


def test_a_rendering_that_would_change_is_refused(policy: SqlPolicy, monkeypatch: pytest.MonkeyPatch) -> None:
    """If checking the checked query gives a different query, the pair of renderings disagree and nothing runs."""
    real = SqlPolicy.check_once
    calls: list[str] = []

    def drifting(self: SqlPolicy, sql: str, max_chars: int) -> ValidatedQuery:
        """Render a different text on the second pass."""
        checked = real(self, sql, max_chars)
        calls.append(sql)
        if len(calls) == 2:
            return ValidatedQuery(
                checked.sql + " ", checked.tables, checked.joins, checked.row_limit, checked.limit_applied
            )
        return checked

    monkeypatch.setattr(SqlPolicy, "check_once", drifting)
    assert refused(policy, "SELECT 1").rule == Rule.UNSTABLE_RENDERING


def test_the_rendering_has_its_own_length_limit(policy: SqlPolicy, monkeypatch: pytest.MonkeyPatch) -> None:
    """The checked query is longer than the one written, so it has its own, larger limit."""
    monkeypatch.setattr(sql_policy, "MAX_RENDERED_CHARS", 40)
    assert refused(policy, "SELECT status, COUNT(*) FROM orders GROUP BY status").rule == Rule.TOO_LONG
