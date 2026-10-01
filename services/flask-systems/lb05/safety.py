"""LB-05's safety vocabulary: the layers that stop a query, the rules they apply, and the operating limits.

Every way a query can be stopped has a name. `Layer` says which defence did it, and
`Rule` says what it found, so a visitor, a span and a test can all say the same thing:
"stopped by the allowlist: a table function". The limits are the datasheet's operating
limits (docs/STACK.md, LB-05), enforced in code and never taken from the environment, so a
deployment cannot widen them by accident.
"""

from enum import StrEnum

# The datasheet's operating limits.
MAX_ROWS = 1_000
STATEMENT_TIMEOUT_SECONDS = 5.0
QUESTIONS_PER_DAY = 25
# Calls to models for one question: the SQL (with a repair), one self-correction (with a
# repair) and the explanation. The gateway's per-run cap in routing.yaml is the same number.
MAX_MODEL_CALLS = 5
# How long one question may take in all, model waits included.
QUESTION_DEADLINE_SECONDS = 90.0

# Limits on the SQL itself, so a query can't be a burden before it ever runs.
MAX_SQL_CHARS = 4_000
# The checked query is longer than the one written: every column is named with its table and every * is spelt out.
MAX_RENDERED_CHARS = 12_000
MAX_COLUMNS = 12
MAX_TREE_DEPTH = 40
MAX_NODES = 4_000
MAX_LITERAL_CHARS = 200
MAX_NAME_CHARS = 63
# The plan check (EXPLAIN) refuses a query it expects to produce more rows than this at any step.
MAX_PLAN_ROWS = 100_000_000


class Layer(StrEnum):
    """The defences a query passes through, in order. Each can stop it."""

    # One statement, parsed, and a SELECT: the first half of the parse-tree check.
    PARSE = "parse"
    # Only the layer's tables, columns, joins and functions: the second half of the parse-tree check.
    ALLOWLIST = "allowlist"
    # The query plan, read without running anything.
    EXPLAIN = "explain"
    # The DuckDB connection: read-only, no external access, configuration locked, memory limited.
    CONNECTION = "connection"
    # The row cap applied to the parse tree.
    ROW_LIMIT = "row_limit"
    # The statement timeout.
    TIMEOUT = "timeout"


class Rule(StrEnum):
    """What a layer found wrong. Each rule belongs to one layer and is either worth a second try or not."""

    EMPTY = "empty"
    TOO_LONG = "too_long"
    INVALID_CHARACTERS = "invalid_characters"
    SYNTAX_ERROR = "syntax_error"
    TOO_COMPLEX = "too_complex"
    MULTIPLE_STATEMENTS = "multiple_statements"
    NOT_SELECT = "not_select"
    CATALOG_ACCESS = "catalog_access"
    FILE_ACCESS = "file_access"
    TABLE_FUNCTION = "table_function"
    UNKNOWN_TABLE = "unknown_table"
    UNKNOWN_COLUMN = "unknown_column"
    FUNCTION_NOT_ALLOWED = "function_not_allowed"
    CONSTRUCT_NOT_ALLOWED = "construct_not_allowed"
    JOIN_NOT_ALLOWED = "join_not_allowed"
    LIMIT_NOT_ALLOWED = "limit_not_allowed"
    TOO_MANY_COLUMNS = "too_many_columns"
    UNSTABLE_RENDERING = "unstable_rendering"
    CHECK_FAILED = "check_failed"
    BINDER_ERROR = "binder_error"
    PLAN_TOO_LARGE = "plan_too_large"
    CROSS_PRODUCT = "cross_product"
    CONNECTION_REFUSED = "connection_refused"
    RUNTIME_ERROR = "runtime_error"
    OUT_OF_MEMORY = "out_of_memory"
    TIMEOUT = "timeout"
    # Not a refusal: the query is accepted and its result is cut to the row cap.
    ROW_CAP = "row_cap"


# Each rule's layer, and whether the model deserves one more try. A rule that means "this
# query is an attack" is never retried; one that means "this query is a mistake" is.
RULE_DETAILS: dict[Rule, tuple[Layer, bool]] = {
    Rule.EMPTY: (Layer.PARSE, True),
    Rule.TOO_LONG: (Layer.PARSE, True),
    Rule.INVALID_CHARACTERS: (Layer.PARSE, False),
    Rule.SYNTAX_ERROR: (Layer.PARSE, True),
    Rule.TOO_COMPLEX: (Layer.PARSE, True),
    Rule.MULTIPLE_STATEMENTS: (Layer.PARSE, False),
    Rule.NOT_SELECT: (Layer.PARSE, False),
    Rule.CATALOG_ACCESS: (Layer.ALLOWLIST, False),
    Rule.FILE_ACCESS: (Layer.ALLOWLIST, False),
    Rule.TABLE_FUNCTION: (Layer.ALLOWLIST, False),
    Rule.UNKNOWN_TABLE: (Layer.ALLOWLIST, True),
    Rule.UNKNOWN_COLUMN: (Layer.ALLOWLIST, True),
    Rule.FUNCTION_NOT_ALLOWED: (Layer.ALLOWLIST, True),
    Rule.CONSTRUCT_NOT_ALLOWED: (Layer.ALLOWLIST, True),
    Rule.JOIN_NOT_ALLOWED: (Layer.ALLOWLIST, True),
    Rule.LIMIT_NOT_ALLOWED: (Layer.ALLOWLIST, True),
    Rule.TOO_MANY_COLUMNS: (Layer.ALLOWLIST, True),
    Rule.UNSTABLE_RENDERING: (Layer.ALLOWLIST, True),
    Rule.CHECK_FAILED: (Layer.ALLOWLIST, False),
    Rule.BINDER_ERROR: (Layer.EXPLAIN, True),
    Rule.PLAN_TOO_LARGE: (Layer.EXPLAIN, True),
    Rule.CROSS_PRODUCT: (Layer.EXPLAIN, True),
    Rule.CONNECTION_REFUSED: (Layer.CONNECTION, False),
    Rule.RUNTIME_ERROR: (Layer.CONNECTION, True),
    Rule.OUT_OF_MEMORY: (Layer.CONNECTION, True),
    Rule.TIMEOUT: (Layer.TIMEOUT, True),
    Rule.ROW_CAP: (Layer.ROW_LIMIT, False),
}


class SqlRejectedError(Exception):
    """A query was stopped, by one layer, for one rule.

    `message` is written for the model that wrote the query and for the visitor who
    watches it being stopped. It is never the visitor's own question, and it quotes at
    most short fragments of the query, which the visitor can already see.
    """

    def __init__(self, rule: Rule, message: str) -> None:
        """Stop a query for `rule`, saying why in `message`."""
        super().__init__(message)
        self.rule = rule
        self.message = message
        self.layer, self.retryable = RULE_DETAILS[rule]
