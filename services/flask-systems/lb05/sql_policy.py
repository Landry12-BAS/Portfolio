"""The parse-tree check: what a query may be, decided on its syntax tree and never on its text.

Model-written SQL is untrusted input. This module is the first two of LB-05's layers of
SQL safety: `parse` (exactly one statement, and it is a SELECT) and `allowlist` (only the
semantic layer's tables, columns, joins and a short list of functions, and nothing
else). It also applies the third: the row cap, set on the tree and not by editing the text.

Three habits make it hard to get around:

- Everything is an allowlist. A syntax node, a function, a table or a column that is not
  listed is refused, so a construct nobody thought of is refused too.
- What runs is the checked tree. The SQL handed to DuckDB is rendered from the tree after
  it was qualified (every column named with its table, every `*` expanded to the columns
  the layer allows), never the text the model wrote. A query that sqlglot and DuckDB
  would read differently therefore can't slip through the gap: DuckDB reads sqlglot's own
  output. The rendering is checked again, and must come out the same.
- It fails closed. Any exception while checking, including the recursion limit, refuses
  the query.

The two layers after this one (the plan check and the read-only connection) are in
lb05/warehouse.py, and don't trust this one.
"""

import logging
from collections.abc import Iterator
from dataclasses import dataclass

import sqlglot
from sqlglot import exp
from sqlglot.errors import ParseError, SqlglotError
from sqlglot.optimizer.qualify import qualify
from sqlglot.optimizer.scope import Scope, traverse_scope
from sqlglot.schema import MappingSchema
from sqlglot.tokenizer_core import Token, TokenType

from lb05.safety import (
    MAX_COLUMNS,
    MAX_LITERAL_CHARS,
    MAX_NAME_CHARS,
    MAX_NODES,
    MAX_RENDERED_CHARS,
    MAX_ROWS,
    MAX_SQL_CHARS,
    MAX_TREE_DEPTH,
    Rule,
    SqlRejectedError,
)
from lb05.semantic_layer import ColumnType, SemanticLayer

# sqlglot logs the start of any statement it can't fully parse, which would put the model's SQL,
# and so fragments of a visitor's question, in the service's logs. Nothing here wants those lines.
logging.getLogger("sqlglot").disabled = True

DIALECT = "duckdb"
# How each column type the layer knows is written for sqlglot's schema.
SQL_TYPES: dict[ColumnType, str] = {"integer": "BIGINT", "text": "VARCHAR", "date": "DATE"}

# The first word of a statement that is not a query. Seeing one means an attack or a
# model that obeyed one, not a typo, so the model isn't asked to try again.
FORBIDDEN_STATEMENT_WORDS = frozenset(
    {
        "ALTER", "ANALYZE", "ATTACH", "BEGIN", "CALL", "CHECKPOINT", "COMMENT", "COMMIT", "COPY", "CREATE", "DELETE",
        "DESCRIBE", "DETACH", "DROP", "EXECUTE", "EXPLAIN", "EXPORT", "FORCE", "GRANT", "IMPORT", "INSERT", "INSTALL",
        "LOAD", "MERGE", "PRAGMA", "PREPARE", "REPLACE", "RESET", "REVOKE", "ROLLBACK", "SET", "SHOW", "SUMMARIZE",
        "TRUNCATE", "UNINSTALL", "UPDATE", "USE", "VACUUM",
    }
)  # fmt: skip

# Table functions, which read files and the network or make rows from nothing. Any function
# used as a table is refused (table_function); these names only make the message precise.
FILE_NAME_CHARACTERS = frozenset("/\\:*~")
SYSTEM_SCHEMAS = frozenset({"information_schema", "pg_catalog", "main", "temp", "system", "memory"})

# The syntax nodes a query may be made of. Anything else is refused.
ALLOWED_NODES: frozenset[type[exp.Expr]] = frozenset(
    {
        exp.Select, exp.Union, exp.Intersect, exp.Except, exp.Subquery, exp.With, exp.CTE, exp.TableAlias, exp.From,
        exp.Join, exp.Where, exp.Group, exp.Having, exp.Order, exp.Ordered, exp.Limit, exp.Distinct, exp.Window,
        exp.WindowSpec, exp.Filter, exp.Table, exp.Column, exp.Identifier, exp.Star, exp.Alias, exp.Literal,
        exp.Boolean, exp.Null, exp.DataType, exp.DataTypeParam, exp.Var, exp.Interval, exp.And, exp.Or, exp.Not,
        exp.Paren, exp.EQ, exp.NEQ, exp.GT, exp.GTE, exp.LT, exp.LTE, exp.Between, exp.In, exp.Like, exp.ILike,
        exp.Is, exp.Exists, exp.Add, exp.Sub, exp.Mul, exp.Div, exp.IntDiv, exp.Mod, exp.Neg, exp.DPipe,
    }
)  # fmt: skip

# The functions a query may call, with the name the model is told to write. Anything else is
# refused, which includes every function sqlglot does not know by name (all of DuckDB's file,
# network, system and random functions among them) and the clock: the data's own "today" is
# given to the model as dates, so an answer never depends on when it was asked.
ALLOWED_FUNCTIONS: dict[type[exp.Expr], str] = {
    exp.Sum: "SUM", exp.Count: "COUNT", exp.CountIf: "COUNT_IF", exp.Avg: "AVG", exp.Min: "MIN", exp.Max: "MAX",
    exp.Median: "MEDIAN", exp.Round: "ROUND", exp.Abs: "ABS", exp.Floor: "FLOOR", exp.Ceil: "CEIL",
    exp.Greatest: "GREATEST", exp.Least: "LEAST", exp.Coalesce: "COALESCE", exp.Nullif: "NULLIF", exp.If: "IF",
    exp.Case: "CASE", exp.Lower: "LOWER", exp.Upper: "UPPER", exp.Length: "LENGTH", exp.Concat: "CONCAT",
    exp.Substring: "SUBSTRING", exp.TimestampTrunc: "DATE_TRUNC", exp.DateTrunc: "DATE_TRUNC", exp.Year: "YEAR",
    exp.Month: "MONTH", exp.Quarter: "QUARTER", exp.Day: "DAY", exp.Week: "WEEK", exp.DayOfWeek: "DAYOFWEEK",
    exp.Dayname: "DAYNAME", exp.Monthname: "MONTHNAME", exp.DateDiff: "DATE_DIFF", exp.DateAdd: "DATE_ADD",
    exp.Extract: "EXTRACT", exp.Exists: "EXISTS", exp.RowNumber: "ROW_NUMBER", exp.Rank: "RANK",
    exp.DenseRank: "DENSE_RANK",
    exp.Lag: "LAG", exp.Lead: "LEAD", exp.FirstValue: "FIRST_VALUE", exp.Cast: "CAST", exp.TryCast: "TRY_CAST",
    exp.Stddev: "STDDEV", exp.StddevPop: "STDDEV_POP", exp.StddevSamp: "STDDEV_SAMP", exp.Variance: "VARIANCE",
    exp.VariancePop: "VAR_POP", exp.PercentileCont: "QUANTILE_CONT", exp.PercentileDisc: "QUANTILE_DISC",
    exp.Quantile: "QUANTILE", exp.Corr: "CORR",
}  # fmt: skip

# The only words that may stand alone as a `Var` node: the date parts of INTERVAL, EXTRACT and DATE_TRUNC.
DATE_PARTS = frozenset(
    {"year", "quarter", "month", "week", "day", "dow", "dayofweek", "doy", "dayofyear", "isodow", "hour", "minute"}
)
# The types a cast may name.
ALLOWED_TYPES = frozenset(
    {
        exp.DataType.Type.INT, exp.DataType.Type.BIGINT, exp.DataType.Type.SMALLINT, exp.DataType.Type.DOUBLE,
        exp.DataType.Type.FLOAT, exp.DataType.Type.DECIMAL, exp.DataType.Type.VARCHAR, exp.DataType.Type.TEXT,
        exp.DataType.Type.CHAR, exp.DataType.Type.DATE, exp.DataType.Type.BOOLEAN, exp.DataType.Type.TIMESTAMP,
    }
)  # fmt: skip

# For the nodes that carry flags and clauses, the only arguments they may use. A node with any
# other argument set (SELECT ... INTO, FOR UPDATE, a recursive WITH, GROUP BY ALL, ...) is refused.
ALLOWED_ARGUMENTS: dict[type[exp.Expr], frozenset[str]] = {
    exp.Select: frozenset(
        {"expressions", "from_", "joins", "where", "group", "having", "order", "limit", "distinct", "with_"}
    ),
    exp.Union: frozenset({"this", "expression", "distinct", "order", "limit", "with_"}),
    exp.Intersect: frozenset({"this", "expression", "distinct", "order", "limit", "with_"}),
    exp.Except: frozenset({"this", "expression", "distinct", "order", "limit", "with_"}),
    exp.Subquery: frozenset({"this", "alias", "order", "limit"}),
    exp.With: frozenset({"expressions"}),
    exp.CTE: frozenset({"this", "alias"}),
    exp.Table: frozenset({"this", "alias"}),
    exp.Join: frozenset({"this", "kind", "side", "on"}),
    exp.Group: frozenset({"expressions"}),
    exp.Order: frozenset({"expressions"}),
    exp.Ordered: frozenset({"this", "desc", "nulls_first"}),
    exp.Limit: frozenset({"expression"}),
    exp.Distinct: frozenset({"expressions"}),
    exp.Window: frozenset({"this", "partition_by", "order", "spec", "over"}),
    exp.WindowSpec: frozenset({"kind", "start", "start_side", "end", "end_side"}),
    exp.Column: frozenset({"this", "table"}),
    exp.Star: frozenset(),
    exp.Cast: frozenset({"this", "to"}),
    exp.In: frozenset({"this", "expressions", "query"}),
}  # fmt: skip


@dataclass(frozen=True)
class ValidatedQuery:
    """A query that passed the parse-tree check: the SQL to run, and what it touches.

    `sql` is rendered from the checked tree, with the row cap set, and is the only text
    DuckDB ever sees. `limit_applied` says whether the cap changed the query: it was
    added, or it lowered a larger limit the query asked for.
    """

    sql: str
    tables: tuple[str, ...]
    joins: int
    row_limit: int
    limit_applied: bool


def reject(rule: Rule, message: str) -> SqlRejectedError:
    """Make the exception that stops a query, for a check to raise."""
    return SqlRejectedError(rule, message)


def short(text: str, limit: int = 60) -> str:
    """Return a fragment of the query fit to quote in a message: one line, printable, and short."""
    flat = "".join(character if character.isprintable() else " " for character in text).strip()
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def describe_parse_error(error: SqlglotError) -> str:
    """Say what sqlglot didn't understand, in a short plain sentence without the query's text."""
    if isinstance(error, ParseError) and error.errors:
        detail = error.errors[0]
        where = f"line {detail.get('line')}, column {detail.get('col')}"
        return f"{short(str(detail.get('description', 'unexpected syntax')), 80)} ({where})"
    return "the query could not be read"


def check_text(sql: str, max_chars: int) -> None:
    """Refuse empty text, text longer than `max_chars`, and control characters other than line breaks and tabs."""
    if not sql.strip():
        raise reject(Rule.EMPTY, "The query is empty.")
    if len(sql) > max_chars:
        raise reject(Rule.TOO_LONG, f"The query is longer than {max_chars} characters; write a shorter one.")
    if any(not character.isprintable() and character not in "\n\r\t" for character in sql):
        raise reject(Rule.INVALID_CHARACTERS, "The query holds control characters.")


def tokenize(sql: str) -> list[Token]:
    """Split the text into tokens, which is where an unterminated string or comment shows."""
    try:
        return sqlglot.tokenize(sql, read=DIALECT)
    except SqlglotError:
        raise reject(Rule.SYNTAX_ERROR, "The query has an unterminated string, quote or comment.") from None
    except RecursionError:
        raise reject(Rule.TOO_COMPLEX, "The query is too complicated to read.") from None


def check_single_statement(tokens: list[Token]) -> None:
    """Refuse a second statement: after a semicolon, only more semicolons may follow."""
    for position, token in enumerate(tokens):
        if token.token_type != TokenType.SEMICOLON:
            continue
        if any(later.token_type != TokenType.SEMICOLON for later in tokens[position + 1 :]):
            raise reject(
                Rule.MULTIPLE_STATEMENTS, "Send exactly one statement, without a second one after a semicolon."
            )


def check_first_word(tokens: list[Token]) -> None:
    """Refuse a statement that starts with a word that only a non-query statement starts with."""
    first = next((token for token in tokens if token.token_type != TokenType.SEMICOLON), None)
    if first is None:
        raise reject(Rule.EMPTY, "The query is empty.")
    word = first.text.upper()
    if word in FORBIDDEN_STATEMENT_WORDS:
        raise reject(Rule.NOT_SELECT, f"Only SELECT queries are allowed, not {word}.")


def parse_statement(sql: str) -> exp.Expr:
    """Parse the text into the one statement it holds."""
    try:
        statements = sqlglot.parse(sql, read=DIALECT)
    except RecursionError:
        raise reject(Rule.TOO_COMPLEX, "The query is nested too deeply to read.") from None
    except SqlglotError as error:
        raise reject(Rule.SYNTAX_ERROR, f"The query isn't valid DuckDB SQL: {describe_parse_error(error)}.") from None
    found = [statement for statement in statements if statement is not None]
    if not found:
        raise reject(Rule.EMPTY, "The query is empty.")
    if len(found) > 1:
        raise reject(Rule.MULTIPLE_STATEMENTS, "Send exactly one statement.")
    return found[0]


def query_of(statement: exp.Expr) -> exp.Query:
    """Return the query a statement is, unwrapping parentheses, or refuse a statement that is not one."""
    root = statement
    while isinstance(root, exp.Subquery) and not root.args.get("alias"):
        if root.args.get("order") or root.args.get("limit"):
            raise reject(
                Rule.CONSTRUCT_NOT_ALLOWED, "Don't put ORDER BY or LIMIT after a query wrapped in parentheses."
            )
        root = root.this
    if not isinstance(root, exp.Select | exp.SetOperation):
        kind = type(root).__name__.upper()
        raise reject(Rule.NOT_SELECT, f"Only SELECT queries are allowed, not {kind}.")
    return root


def measure(root: exp.Expr) -> list[exp.Expr]:
    """Return every node of the tree, refusing a tree that is too big or too deep to check in reasonable time."""
    try:
        nodes = list(root.walk())
        if len(nodes) > MAX_NODES or max(node.depth for node in nodes) > MAX_TREE_DEPTH:
            raise reject(Rule.TOO_COMPLEX, "The query is too large or too deeply nested; simplify it.")
    except RecursionError:
        raise reject(Rule.TOO_COMPLEX, "The query is nested too deeply to check.") from None
    return nodes


def table_name_problem(name: str, known: set[str], defined: set[str]) -> SqlRejectedError | None:
    """Say why a table name can't be used, or return None when it is one of the layer's or a CTE the query defines."""
    lowered = name.lower()
    if lowered in known or lowered in defined:
        return None
    if any(character in FILE_NAME_CHARACTERS for character in name) or name.startswith("."):
        return reject(Rule.FILE_ACCESS, "A table can't be a file or a URL; use the tables the layer lists.")
    return reject(
        Rule.UNKNOWN_TABLE, f"The table {short(name)!r} isn't available. Use only: {', '.join(sorted(known))}."
    )


def check_tables(nodes: list[exp.Expr], layer: SemanticLayer) -> None:
    """Refuse a table that is a function, sits outside the layer, or reaches into a catalog or another schema."""
    known = set(layer.allowed_columns())
    defined = {cte.alias_or_name.lower() for cte in nodes if isinstance(cte, exp.CTE)}
    for node in nodes:
        if not isinstance(node, exp.Table):
            continue
        if isinstance(node.parent, exp.Into):
            raise reject(Rule.CONSTRUCT_NOT_ALLOWED, "SELECT ... INTO isn't allowed: queries only read.")
        if not isinstance(node.this, exp.Identifier):
            raise reject(Rule.TABLE_FUNCTION, "A function can't be used as a table; use the tables the layer lists.")
        if node.args.get("db") or node.args.get("catalog"):
            raise reject(Rule.CATALOG_ACCESS, "Name tables plainly, without a schema or a database in front.")
        problem = table_name_problem(node.name, known, defined)
        if problem is not None:
            raise problem


def function_name(node: exp.Func) -> str:
    """Return the name of a function node as a query would write it."""
    return node.name if isinstance(node, exp.Anonymous) else node.sql_name()


def refusal_for(node: exp.Expr) -> SqlRejectedError:
    """Build the refusal for a node on neither list: a function that isn't allowed, or a construct that isn't."""
    if isinstance(node, exp.Func):
        allowed = ", ".join(sorted(set(ALLOWED_FUNCTIONS.values())))
        return reject(
            Rule.FUNCTION_NOT_ALLOWED,
            f"The function {short(function_name(node), 40)} isn't allowed. Allowed functions: {allowed}.",
        )
    return reject(Rule.CONSTRUCT_NOT_ALLOWED, f"{type(node).__name__} isn't allowed in a query.")


def is_unset(value: object) -> bool:
    """Tell whether a node's argument is empty: absent, false, blank or an empty list."""
    return value is None or value is False or value == "" or (isinstance(value, list) and not value)


def check_arguments(node: exp.Expr) -> None:
    """Refuse a node that uses a clause or flag its kind may not."""
    allowed = ALLOWED_ARGUMENTS.get(type(node))
    if allowed is None:
        return
    for name, value in node.args.items():
        if is_unset(value) or name in allowed:
            continue
        raise reject(Rule.CONSTRUCT_NOT_ALLOWED, f"{type(node).__name__} with {name.rstrip('_')} isn't allowed.")


def check_leaf(node: exp.Expr) -> None:
    """Hold the small leaf nodes to their limits: date parts only for `Var`, plain types only for casts, short text."""
    if isinstance(node, exp.Var) and node.name.lower() not in DATE_PARTS:
        raise reject(Rule.CONSTRUCT_NOT_ALLOWED, f"The word {short(node.name, 30)!r} isn't allowed here.")
    if isinstance(node, exp.DataType) and node.this not in ALLOWED_TYPES:
        raise reject(Rule.CONSTRUCT_NOT_ALLOWED, f"Casting to {short(node.sql(DIALECT), 30)} isn't allowed.")
    if isinstance(node, exp.Literal) and len(node.name) > MAX_LITERAL_CHARS:
        raise reject(Rule.CONSTRUCT_NOT_ALLOWED, f"A value longer than {MAX_LITERAL_CHARS} characters isn't allowed.")
    if isinstance(node, exp.Identifier) and len(node.name) > MAX_NAME_CHARS:
        raise reject(Rule.CONSTRUCT_NOT_ALLOWED, f"A name longer than {MAX_NAME_CHARS} characters isn't allowed.")


def check_nodes(nodes: list[exp.Expr]) -> None:
    """Hold every node of the tree to the allowlist: its kind (a node or a function), its arguments and its contents.

    Some syntax nodes are functions in sqlglot's class tree (`And` and `Or` among them), so a
    node is first looked up on both lists, and only one on neither is refused.
    """
    for node in nodes:
        if type(node) not in ALLOWED_NODES and type(node) not in ALLOWED_FUNCTIONS:
            raise refusal_for(node)
        check_arguments(node)
        check_leaf(node)


def strip_comments(root: exp.Expr) -> None:
    """Remove every comment from the tree.

    sqlglot keeps comments and writes them back out, so a comment would travel into the SQL
    DuckDB runs. Nothing a comment says matters to a query, and none is worth the risk of a
    comment that doesn't stay one.
    """
    for node in root.walk():
        node.comments = None


def check_with_clauses(nodes: list[exp.Expr]) -> None:
    """Refuse a recursive WITH, which can run for ever, with a message that offers the alternative."""
    for node in nodes:
        if isinstance(node, exp.With) and node.args.get("recursive"):
            raise reject(Rule.CONSTRUCT_NOT_ALLOWED, "WITH RECURSIVE isn't allowed; use ordinary WITH queries.")


def build_schema(layer: SemanticLayer) -> MappingSchema:
    """Describe the layer's tables and columns to sqlglot, which qualifies columns against them."""
    tables: dict[str, object] = {
        table: {column: SQL_TYPES[kind] for column, kind in columns.items()}
        for table, columns in layer.column_types().items()
    }
    return MappingSchema(tables, dialect=DIALECT)


def qualify_query(query: exp.Query, layer: SemanticLayer) -> exp.Query:
    """Name every column with its table and expand every `*` to the columns the layer allows.

    A column that isn't in the layer, or that can't be told apart from another, is refused.
    """
    try:
        qualified = qualify(
            query.copy(),
            schema=build_schema(layer),
            dialect=DIALECT,
            validate_qualify_columns=True,
            expand_stars=True,
            identify=False,
        )
    except RecursionError:
        raise reject(Rule.TOO_COMPLEX, "The query is nested too deeply to check.") from None
    except SqlglotError as error:
        text = str(error).splitlines()[0] if str(error) else "a column could not be resolved"
        raise reject(
            Rule.UNKNOWN_COLUMN,
            f"{short(text, 100)}. Use only the columns the layer lists for the tables in the query, and qualify a "
            "column that two tables share with its table.",
        ) from None
    if not isinstance(qualified, exp.Query):
        raise reject(Rule.NOT_SELECT, "Only SELECT queries are allowed.")
    return qualified


def source_of(scope: Scope, alias: str) -> exp.Table | Scope | None:
    """Find what an alias names, a table or a query; a correlated subquery also sees its parents' aliases."""
    current: Scope | None = scope
    while current is not None:
        if alias in current.sources:
            found = current.sources[alias]
            return found if isinstance(found, exp.Table | Scope) else None
        current = current.parent if current.is_subquery else None
    return None


def check_columns(query: exp.Query, layer: SemanticLayer) -> list[str]:
    """Check each column of a qualified query against the layer, and return the physical tables it reads.

    A column must be named with a table or query in scope. When that is a physical table,
    the column must be one the layer lists for it, so a column the data holds but the
    layer leaves out is refused even if sqlglot let it through.
    """
    allowed = layer.allowed_columns()
    physical: set[str] = set()
    for scope in traverse_scope(query):
        for named in scope.sources.values():
            if isinstance(named, exp.Table):
                physical.add(named.name.lower())
        outside = sorted(physical - set(allowed))
        if outside:
            raise reject(
                Rule.UNKNOWN_TABLE,
                f"The table {short(outside[0])!r} isn't available. Use only: {', '.join(sorted(allowed))}.",
            )
        for column in scope.columns:
            source = source_of(scope, column.table)
            if source is None:
                raise reject(
                    Rule.UNKNOWN_COLUMN, f"The column {short(column.sql(DIALECT), 40)!r} can't be matched to a table."
                )
            if isinstance(source, exp.Table) and column.name.lower() not in allowed.get(
                source.name.lower(), frozenset()
            ):
                raise reject(
                    Rule.UNKNOWN_COLUMN,
                    f"The column {short(source.name + '.' + column.name, 60)!r} isn't available. "
                    f"Columns of {source.name}: {', '.join(sorted(allowed.get(source.name.lower(), frozenset())))}.",
                )
    return sorted(physical)


def conditions_of(condition: exp.Expr | None) -> Iterator[exp.Expr]:
    """Yield the conditions a join's ON clause is made of: the parts of its top-level ANDs."""
    if condition is None:
        return
    if isinstance(condition, exp.And):
        yield from conditions_of(condition.this)
        yield from conditions_of(condition.expression)
    else:
        yield condition


def joined_alias(join: exp.Join) -> str:
    """Return the alias a joined table or query goes by."""
    return str(join.this.alias_or_name)


def physical_table(scope: Scope, alias: str) -> str | None:
    """Return the physical table an alias stands for, or None when it names a query (a CTE or derived table)."""
    source = source_of(scope, alias)
    return source.name.lower() if isinstance(source, exp.Table) else None


def is_key_equality(condition: exp.Expr, scope: Scope, new_alias: str, earlier: set[str], layer: SemanticLayer) -> bool:
    """Tell whether a condition equates a column of the joined table with a column of one before it, by a declared join.

    When either side is a query rather than a physical table, any two columns may be equated.
    """
    if not isinstance(condition, exp.EQ):
        return False
    left, right = condition.this, condition.expression
    if not isinstance(left, exp.Column) or not isinstance(right, exp.Column):
        return False
    aliases = {left.table, right.table}
    if new_alias not in aliases or len(aliases) != 2 or not (aliases - {new_alias}) <= earlier:
        return False
    tables = (physical_table(scope, left.table), physical_table(scope, right.table))
    if None in tables:
        return True
    pair = frozenset({(str(tables[0]), left.name.lower()), (str(tables[1]), right.name.lower())})
    return pair in layer.join_pairs()


def check_join(join: exp.Join, scope: Scope, earlier: set[str], layer: SemanticLayer) -> None:
    """Hold one join to the rules: an inner or left join, with an ON clause that includes a declared key equality."""
    if join.args.get("kind") not in (None, "INNER", "OUTER") or join.args.get("side") not in (None, "LEFT"):
        raise reject(Rule.JOIN_NOT_ALLOWED, "Only INNER and LEFT joins are allowed.")
    new_alias = joined_alias(join)
    on = join.args.get("on")
    if on is None:
        raise reject(
            Rule.JOIN_NOT_ALLOWED,
            join_advice(layer, "Join tables with JOIN ... ON; a join without a condition is a cross join."),
        )
    if not any(is_key_equality(part, scope, new_alias, earlier, layer) for part in conditions_of(on)):
        raise reject(
            Rule.JOIN_NOT_ALLOWED, join_advice(layer, "Every join needs an ON condition equating two declared keys.")
        )


def join_advice(layer: SemanticLayer, first: str) -> str:
    """Write the message for a refused join, ending with the joins the layer allows."""
    allowed = "; ".join(
        " = ".join(sorted(f"{table}.{column}" for table, column in pair))
        for pair in sorted(layer.join_pairs(), key=sorted)
    )
    return f"{first} Declared joins: {allowed}. Joins between WITH queries may equate any of their columns."


def check_joins(query: exp.Query, layer: SemanticLayer) -> int:
    """Hold every join of the query to the rules, and return how many there are."""
    count = 0
    for scope in traverse_scope(query):
        select = scope.expression
        if not isinstance(select, exp.Select):
            continue
        from_clause = select.args.get("from_")
        earlier = {from_clause.this.alias_or_name} if from_clause is not None else set()
        for join in select.args.get("joins") or []:
            check_join(join, scope, earlier, layer)
            earlier.add(joined_alias(join))
            count += 1
    return count


def limit_of(query: exp.Query) -> int | None:
    """Return the query's own row limit, None when it has none, or refuse a limit that is not a plain whole number."""
    limit = query.args.get("limit")
    if limit is None:
        return None
    amount = limit.expression
    if not isinstance(amount, exp.Literal) or amount.is_string or not amount.is_int:
        raise reject(Rule.LIMIT_NOT_ALLOWED, "LIMIT must be a plain whole number.")
    return int(amount.name)


def apply_row_limit(query: exp.Query) -> tuple[int, bool]:
    """Set the row cap on the tree: keep a smaller limit the query asked for, otherwise use the cap.

    Returns the limit in force and whether the cap changed anything. The limit is set on the
    parsed tree, not by adding text to the query, so no quoting or comment trick can hide it.
    """
    own = limit_of(query)
    if own is not None and own <= MAX_ROWS:
        return own, False
    query.limit(MAX_ROWS, copy=False)
    return MAX_ROWS, True


def check_width(query: exp.Query) -> None:
    """Refuse a query that returns more columns than a table on the page can show."""
    if len(query.selects) > MAX_COLUMNS:
        raise reject(
            Rule.TOO_MANY_COLUMNS, f"The query returns {len(query.selects)} columns; at most {MAX_COLUMNS} are allowed."
        )


def check_tree(root: exp.Expr, layer: SemanticLayer) -> None:
    """Run the checks that need only the tree as written: tables, node kinds, functions, arguments."""
    nodes = measure(root)
    check_tables(nodes, layer)
    check_with_clauses(nodes)
    check_nodes(nodes)


class SqlPolicy:
    """The parse-tree check for one semantic layer."""

    def __init__(self, layer: SemanticLayer) -> None:
        """Check queries against `layer`'s tables, columns and joins."""
        self.layer = layer

    def validate(self, sql: str) -> ValidatedQuery:
        """Check a query and return the SQL to run, or raise SqlRejectedError naming the layer and the rule.

        The query is checked, rendered from its checked tree, and the rendering is checked
        again: it has to be accepted and to render the same, or the query is refused.
        """
        try:
            checked = self.check_once(sql, MAX_SQL_CHARS)
            again = self.check_once(checked.sql, MAX_RENDERED_CHARS)
        except SqlRejectedError:
            raise
        except RecursionError:
            raise reject(Rule.TOO_COMPLEX, "The query is too complicated to check.") from None
        except Exception:  # noqa: BLE001 - a bug in a parser or a check must refuse the query, never let it through
            raise reject(Rule.CHECK_FAILED, "The query could not be checked, so it was not run.") from None
        if again.sql != checked.sql:
            raise reject(Rule.UNSTABLE_RENDERING, "The query can't be written down unambiguously; simplify it.")
        return checked

    def check_once(self, sql: str, max_chars: int) -> ValidatedQuery:
        """Run every check on the text once, and render the checked tree."""
        check_text(sql, max_chars)
        tokens = tokenize(sql)
        check_single_statement(tokens)
        check_first_word(tokens)
        query = query_of(parse_statement(sql))
        strip_comments(query)
        check_tree(query, self.layer)
        qualified = qualify_query(query, self.layer)
        check_tree(qualified, self.layer)
        tables = check_columns(qualified, self.layer)
        joins = check_joins(qualified, self.layer)
        check_width(qualified)
        limit, applied = apply_row_limit(qualified)
        return ValidatedQuery(
            sql=qualified.sql(dialect=DIALECT, pretty=True),
            tables=tuple(tables),
            joins=joins,
            row_limit=limit,
            limit_applied=applied,
        )
