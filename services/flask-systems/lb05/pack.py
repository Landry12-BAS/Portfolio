"""LB-05's eval pack: the SQL writer's production prompt and golden set, in the form Eval Lab (LB-10) runs.

The pack carries the very prompt the pipeline sends (lb05/prompts.py: `system_prompt` and the user
message's `USER_TEMPLATE`), materialised for every golden case: the resolver has already run, so the
case's inputs hold the context production would write for its question on a fixed as-of day. Nothing
in the lab needs the semantic layer, the warehouse or the resolver.

Each case is graded by rules: the reply must be the JSON object the pipeline accepts, must call the
question answerable, and its SQL must have the shape of the reference query (the same tables and
aggregate functions). Production grades by running the query against the data (lb05/golden_eval.py),
which the lab cannot do, so a pass here is weaker than execution accuracy, and the README says so.

`export_pack` checks itself before writing: the pack's templates, filled with each case's inputs, must
give exactly the messages `sql_messages` builds, or the export refuses.
"""

from datetime import date
from pathlib import Path
from typing import Any

from core.structured import ChatMessage
from lb05.golden import EVALS_DIRECTORY, GoldenCase, read_golden_set, reference_sql
from lb05.prompts import (
    SQL_ALIAS,
    SQL_MAX_TOKENS,
    USER_TEMPLATE,
    SqlAnswer,
    question_context,
    quoted,
    sql_messages,
    system_prompt,
)
from lb05.resolve import resolve
from lb05.semantic_check import load_semantic_layer
from lb05.semantic_layer import SemanticLayer
from lb10.packs import PACKS_DIRECTORY, EvalPack
from lb10.templates import from_format_string, render

# The day the pack's questions are asked on: every relative date in a case resolves against it. Fixed, so
# the pack (and so the lab's cached baselines) change only when the prompt or the golden set does.
PACK_AS_OF = date(2026, 11, 18)
PACK_NAME = "lb05-sql-writer"
PACK_FILE = PACKS_DIRECTORY / f"{PACK_NAME}.yaml"
MADE_BY = "just export-pack-lb05"
SOURCE = "services/flask-systems/lb05/prompts.py and evals/lb05/golden.yaml"


class PackMismatchError(Exception):
    """The pack's templates, filled in, did not give the messages production builds."""


def case_inputs(case: GoldenCase, layer: SemanticLayer) -> dict[str, str]:
    """Materialise one case: the context the resolver writes for its question, and the quoted question."""
    resolution = resolve(case.question, layer, PACK_AS_OF)
    return {"context": question_context(resolution), "question": quoted(case.question)}


def common_graders() -> list[dict[str, Any]]:
    """Write the rules every case shares: the reply is the JSON object the pipeline accepts, and it answers."""
    return [
        {"kind": "json_schema", "schema": SqlAnswer.model_json_schema()},
        {"kind": "json_field_equals", "path": "answerable", "expected": True},
    ]


def case_graders(case: GoldenCase) -> list[dict[str, Any]]:
    """Write the rule that grades one case on its own: the reference query's shape."""
    return [
        {
            "kind": "sql_structural",
            "path": "sql",
            "reference": reference_sql(case, PACK_AS_OF),
            "dialect": "duckdb",
            "compare": "shape",
        },
    ]


def pack_case(case: GoldenCase, layer: SemanticLayer) -> dict[str, Any]:
    """Write one golden question as a pack case."""
    return {
        "id": case.id,
        "difficulty": case.difficulty,
        "inputs": case_inputs(case, layer),
        "expected": {"sql": reference_sql(case, PACK_AS_OF), "topic": case.topic, "order": case.order},
        "graders": case_graders(case),
    }


def build_pack(layer: SemanticLayer, evals_directory: Path = EVALS_DIRECTORY) -> dict[str, Any]:
    """Build the whole pack from the semantic layer and the golden set."""
    golden = read_golden_set(evals_directory)
    return {
        "pack": PACK_NAME,
        "system": "lb-05",
        "target": {
            "name": "LB-05 SQL writer",
            "description": (
                "Writes one DuckDB query for a question about the sales data, from the semantic layer. "
                "Graded here by the shape of the query; production grades by running it."
            ),
            "source": "services/flask-systems/lb05/prompts.py",
            "alias": SQL_ALIAS,
            "model_class": "reason",
            "max_output_tokens": SQL_MAX_TOKENS,
            "output": "json",
        },
        "prompt": {"system": system_prompt(layer), "user": from_format_string(USER_TEMPLATE)},
        "variables": [],
        "common_graders": common_graders(),
        "cases": [pack_case(case, layer) for case in golden.cases],
    }


def production_messages(case: GoldenCase, layer: SemanticLayer) -> list[ChatMessage]:
    """Build the messages the pipeline would send for a case, through the pipeline's own function."""
    return sql_messages(system_prompt(layer), case.question, resolve(case.question, layer, PACK_AS_OF))


def check_matches_production(pack: EvalPack, layer: SemanticLayer, evals_directory: Path = EVALS_DIRECTORY) -> None:
    """Refuse a pack whose filled-in templates differ, for any case, from what production sends."""
    golden = read_golden_set(evals_directory)
    for case in golden.cases:
        packed = pack.case_by_id(case.id)
        rendered = [render(pack.prompt.system, packed.inputs), render(pack.prompt.user, packed.inputs)]
        expected = [message.content for message in production_messages(case, layer)]
        if rendered != expected:
            raise PackMismatchError(f"case {case.id!r} renders differently from production")


def export_pack(seed_directory: Path, evals_directory: Path = EVALS_DIRECTORY) -> tuple[dict[str, Any], EvalPack]:
    """Build the pack, read it back through the strict reader, and prove it matches production."""
    layer = load_semantic_layer(seed_directory / "lb05")
    content = build_pack(layer, evals_directory)
    pack = EvalPack.model_validate(content)
    check_matches_production(pack, layer, evals_directory)
    return content, pack
