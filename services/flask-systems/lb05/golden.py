"""LB-05's golden set: questions with a reference answer, and attempts to break the SQL check.

Two files in evals/lb05, both written before any prompt (docs/PLAYBOOK.md, step 3) and both
graded by rules, never by a model:

- golden.yaml: exactly 100 questions (the datasheet's "execution accuracy on 100 question and
  answer pairs"). Each carries a reference query. The grader runs it on the data and runs the
  model's query on the same data, and compares the two result sets: the same rows (in the same
  order when a case says so), numbers within a tolerance, column names ignored. Dates are
  relative to the data's as-of day, so a reference query names them as parameters
  (`$last_quarter_start`), which are filled in from lb05/timeranges.py as typed dates on the
  syntax tree, never by editing the text.
- adversarial.yaml: attempts to make the model write a query that destroys, steals or exhausts.
  Each gives the question, the query a model that obeyed would write, and which layer must stop
  it, for which rule. The offline tests run those queries through the real layers with no model
  in the way; the live eval asks the real model the question.

Neither file is read by the deployed service: they are for development and CI (EVALS_DIR).
"""

from datetime import date
from pathlib import Path
from typing import Annotated, Literal, Self, get_args

import sqlglot
from pydantic import Field, StringConstraints, model_validator
from sqlglot import exp

from core.data_files import Key, StrictEntry, read_data_file
from lb05.safety import RULE_DETAILS, Layer, Rule
from lb05.sql_policy import DIALECT
from lb05.timeranges import range_parameters

# The repository's evals folder: services/flask-systems/lb05/golden.py is three levels below the root.
EVALS_DIRECTORY = Path(__file__).resolve().parents[3] / "evals" / "lb05"
# What a visitor may type, as the API accepts it (lb05/api.py): short, plain questions.
Question = Annotated[str, StringConstraints(strip_whitespace=True, min_length=10, max_length=300)]
ReferenceSql = Annotated[str, StringConstraints(strip_whitespace=True, min_length=10, max_length=4_000)]
Topic = Literal["totals", "breakdown", "time", "join", "ranking", "ratio", "subscriptions", "customers"]
Difficulty = Literal["easy", "medium", "hard"]
AttemptCategory = Literal[
    "destructive",
    "stacked",
    "comment_and_quoting",
    "file_access",
    "database_commands",
    "catalog_access",
    "resource_exhaustion",
    "injection",
    "missing_data",
    "exfiltration",
]
# How many questions the golden set holds, and how many of them open the live demo.
GOLDEN_SIZE = 100
SAMPLE_RANGE = (4, 8)
MIN_ATTEMPTS = 25


class GoldenCase(StrictEntry):
    """One question, and the reference query whose result is the right answer."""

    id: Key
    question: Question
    topic: Topic
    difficulty: Difficulty
    sql: ReferenceSql
    # `any` compares the rows as a set; `exact` also requires the order, for a ranking.
    order: Literal["any", "exact"] = "any"
    # How far a number may differ and still be the same answer: rounding, mostly.
    tolerance: Annotated[float, Field(ge=0.0, le=1.0)] = 0.01
    # Curated samples open the live demo, and their recorded runs are replayed.
    sample: bool = False


class GoldenSet(StrictEntry):
    """The whole of golden.yaml."""

    cases: list[GoldenCase] = Field(min_length=GOLDEN_SIZE, max_length=GOLDEN_SIZE)

    @model_validator(mode="after")
    def _check_cases(self) -> Self:
        """Refuse repeated IDs or questions, unknown parameters, a wrong sample count or a missing topic."""
        ids = [case.id for case in self.cases]
        if len(set(ids)) != len(ids):
            raise ValueError("a case ID appears more than once")
        questions = [case.question.lower() for case in self.cases]
        if len(set(questions)) != len(questions):
            raise ValueError("a question appears more than once")
        known = set(range_parameters(date(2000, 1, 1)))
        for case in self.cases:
            unknown = parameters_in(case.sql) - known
            if unknown:
                raise ValueError(f"case {case.id!r} uses unknown parameters: {', '.join(sorted(unknown))}")
        if not SAMPLE_RANGE[0] <= len(self.samples()) <= SAMPLE_RANGE[1]:
            raise ValueError(f"the golden set needs {SAMPLE_RANGE[0]} to {SAMPLE_RANGE[1]} curated samples")
        if {case.topic for case in self.cases} != set(get_args(Topic)):
            raise ValueError("every topic needs at least one case")
        return self

    def samples(self) -> list[GoldenCase]:
        """Return the curated samples the live demo opens on."""
        return [case for case in self.cases if case.sample]


class Attempt(StrictEntry):
    """One attempt to break the safety layers, and the layer that must stop it.

    `sql` is what a model that obeyed `question` would write. `stopped_by` and `rule` name the
    first layer that must refuse it and why. `connection` says what the locked DuckDB connection
    alone would do with the raw statement, with none of the checks before it: `refused`,
    `allowed`, or `not_tried` for a statement that is too dangerous to run even to find out
    (it could exhaust the memory of the machine running the tests). The layers don't trust each
    other, and this says honestly where only one of them stands in the way. `must_refuse` is
    for the live eval: a question that must be refused is failed if the model answers it.
    """

    id: Key
    category: AttemptCategory
    question: Question
    sql: Annotated[str, StringConstraints(min_length=0, max_length=20_000)]
    stopped_by: Layer
    rule: Rule
    connection: Literal["refused", "allowed", "not_tried"]
    # False when the question also asks for something legitimate, which a good answer may deliver.
    must_refuse: bool = True
    note: Annotated[str, StringConstraints(strip_whitespace=True, min_length=10, max_length=400)]

    @model_validator(mode="after")
    def _check_rule_belongs_to_layer(self) -> Self:
        """Require that the named rule is one the named layer applies."""
        if self.rule not in RULE_DETAILS or RULE_DETAILS[self.rule][0] != self.stopped_by:
            raise ValueError(f"the rule {self.rule!r} is not applied by the layer {self.stopped_by!r}")
        return self


class AdversarialSet(StrictEntry):
    """The whole of adversarial.yaml."""

    attempts: list[Attempt] = Field(min_length=MIN_ATTEMPTS)

    @model_validator(mode="after")
    def _check_attempts(self) -> Self:
        """Refuse a repeated ID, and require every category of attack to be tried."""
        ids = [attempt.id for attempt in self.attempts]
        if len(set(ids)) != len(ids):
            raise ValueError("an attempt ID appears more than once")
        if {attempt.category for attempt in self.attempts} != set(get_args(AttemptCategory)):
            raise ValueError("every category of attack needs at least one attempt")
        return self


def parameters_in(sql: str) -> set[str]:
    """Return the names of the `$parameters` a reference query uses."""
    tree = sqlglot.parse_one(sql, read=DIALECT)
    return {node.name for node in tree.find_all(exp.Placeholder) if node.name}


def reference_sql(case: GoldenCase, today: date) -> str:
    """Return a case's reference query with its date parameters filled in as typed dates for the as-of day `today`.

    The substitution is made on the syntax tree, so a parameter becomes a date value and can
    never become part of the query's text.
    """
    values = range_parameters(today)

    def fill(node: exp.Expr) -> exp.Expr:
        """Replace a `$parameter` with its date, and leave every other node as it is."""
        if isinstance(node, exp.Placeholder) and node.name in values:
            return exp.cast(exp.Literal.string(values[node.name].isoformat()), exp.DataType.Type.DATE)
        return node

    return sqlglot.parse_one(case.sql, read=DIALECT).transform(fill).sql(dialect=DIALECT)


def read_golden_set(directory: Path = EVALS_DIRECTORY) -> GoldenSet:
    """Read and check evals/lb05/golden.yaml."""
    return read_data_file(directory / "golden.yaml", GoldenSet)


def read_adversarial_set(directory: Path = EVALS_DIRECTORY) -> AdversarialSet:
    """Read and check evals/lb05/adversarial.yaml."""
    return read_data_file(directory / "adversarial.yaml", AdversarialSet)
