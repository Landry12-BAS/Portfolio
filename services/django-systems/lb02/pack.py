"""LB-02's eval pack: the Booking Concierge's planner on a visitor's first message, for Eval Lab (LB-10).

The concierge is a tool-calling model behind a state machine: what it may call depends on where the
booking stands, and the State block it reads comes from the database. Only the first turn of a
conversation can be materialised without that machinery, because every conversation starts from the
same place: the `details` step, nothing recorded, no search made. So the pack holds the first message
of every golden conversation (evals/lb02/golden.yaml) whose first turn the golden set grades, masked as
the service masks it before the model
sees it, with the system prompt and State block production writes for a fresh conversation on a fixed
day, and the tools offered at that step, exactly as `tool_definitions` describes them.

The model's reply is tool calls, so the lab asks for them and grades the JSON it writes of them: which
tool was called first, the arguments the golden set names (the offering, the party size, the part of the
day, the name), how many tools were called when none should be, and forbidden text. The exporter checks
itself: the pack's templates, filled with a case's inputs, must give exactly the messages `fit_history`
builds, or it refuses.
"""

from datetime import date, datetime, time
from pathlib import Path
from typing import Any

from core.data_files import read_data_file
from core.packs import from_format_string, render, require_same
from lb02.booking import bookable_days
from lb02.concierge import CHAT_ALIAS
from lb02.golden import GoldenCase, GoldenSet, Turn, read_golden_set
from lb02.languages import language_name
from lb02.limits import MAX_PARTY_SIZE
from lb02.models import ROASTERY_TIME_ZONE
from lb02.privacy import mask
from lb02.prompts import (
    CHAT_MAX_TOKENS,
    SYSTEM_PROMPT,
    OfferingFacts,
    StateFacts,
    fit_history,
    offering_lines,
    state_block,
    system_prompt,
    tool_definitions,
)
from lb02.seed import CalendarFile
from lb02.states import Step, Tool

# The day the pack's conversations happen on, a Thursday morning in Prague: the calendar's days count from
# it. Fixed, so the pack changes only when the prompt, the tools, the offerings or the golden set do.
PACK_TODAY = date(2026, 10, 1)
PACK_NOW = datetime.combine(PACK_TODAY, time(9, 0), tzinfo=ROASTERY_TIME_ZONE)
PACK_NAME = "lb02-planner"
MADE_BY = "just export-pack-lb02"
SOURCE = "services/django-systems/lb02/prompts.py, evals/lb02/golden.yaml and data/seed/lb02/offerings.yaml"
# The scenarios whose first message tests the rules rather than the happy path.
HARD_SCENARIOS = frozenset({"injection", "prompt_leak", "out_of_scope", "handoff", "real_email", "language_switch"})
# The lab writes the reply's tool calls as JSON: the first call's name and arguments sit at these paths.
FIRST_TOOL = "tool_calls.0.name"
FIRST_ARGUMENTS = "tool_calls.0.arguments"


def offering_facts(seed_directory: Path) -> list[OfferingFacts]:
    """Describe the offerings for the prompt from the seed file, as the concierge does from the database."""
    calendar = read_data_file(seed_directory / "offerings.yaml", CalendarFile)
    return [
        OfferingFacts(entry.key, entry.title.en, entry.duration_minutes, entry.capacity, entry.price_czk)
        for entry in calendar.offerings
    ]


def fresh_state() -> str:
    """Write the State block of a conversation that has just begun."""
    return state_block(StateFacts(step=Step.DETAILS))


def system_template() -> str:
    """Write the system message as a template: the rules with their placeholders, then the fresh State."""
    return f"{from_format_string(SYSTEM_PROMPT)}\n{fresh_state()}"


def system_inputs(language: str, offerings: list[OfferingFacts]) -> dict[str, str]:
    """Fill the system prompt's variables for one conversation, exactly as `system_prompt` formats them."""
    first_day, last_day = bookable_days(PACK_NOW)
    return {
        "language": language_name(language),
        "offerings": offering_lines(offerings),
        "today": f"{PACK_TODAY:%A} {PACK_TODAY.isoformat()}",
        "first_day": f"{first_day:%a} {first_day.isoformat()}",
        "last_day": f"{last_day:%a} {last_day.isoformat()}",
        "party_limit": str(MAX_PARTY_SIZE),
    }


def difficulty_of(case: GoldenCase) -> str:
    """Rate a case: a scenario about the rules is hard, a Czech conversation medium, the rest easy."""
    if HARD_SCENARIOS & set(case.covers):
        return "hard"
    if case.language == "cs":
        return "medium"
    return "easy"


def argument_graders(turn: Turn) -> list[dict[str, Any]]:
    """Write the rules for the arguments the golden set names on the first tool call."""
    graders: list[dict[str, Any]] = []
    for tool, arguments in turn.expect.args.items():
        if tool != Tool.UPDATE_DETAILS:
            continue
        if arguments.offering is not None:
            graders.append(
                {"kind": "json_field_equals", "path": f"{FIRST_ARGUMENTS}.offering", "expected": arguments.offering}
            )
        if arguments.party_size is not None:
            graders.append(
                {"kind": "json_field_equals", "path": f"{FIRST_ARGUMENTS}.party_size", "expected": arguments.party_size}
            )
        if arguments.part_of_day is not None:
            graders.append(
                {
                    "kind": "json_field_equals",
                    "path": f"{FIRST_ARGUMENTS}.part_of_day",
                    "expected": str(arguments.part_of_day),
                }
            )
        if arguments.name_contains is not None:
            graders.append({"kind": "contains_all", "values": [arguments.name_contains]})
    return graders


def case_graders(turn: Turn) -> list[dict[str, Any]]:
    """Write the rules for one first turn: the tool called (or none), its arguments, and forbidden text."""
    graders: list[dict[str, Any]] = []
    tools = turn.expect.tools
    if tools is not None and not tools:
        graders.append({"kind": "json_field_equals", "path": "tool_call_count", "expected": 0})
    elif tools:
        graders.append({"kind": "json_field_equals", "path": FIRST_TOOL, "expected": str(tools[0])})
    graders.extend(argument_graders(turn))
    if turn.expect.never:
        graders.append({"kind": "contains_none", "values": list(turn.expect.never)})
    return graders


def pack_case(case: GoldenCase, offerings: list[OfferingFacts]) -> dict[str, Any]:
    """Write one conversation's first turn as a pack case."""
    turn = case.turns[0]
    return {
        "id": case.id,
        "difficulty": difficulty_of(case),
        "inputs": {**system_inputs(case.language, offerings), "message": mask(turn.say).text},
        "expected": {
            "tools": [str(tool) for tool in turn.expect.tools] if turn.expect.tools is not None else None,
            "args": {
                str(tool): arguments.model_dump(mode="json", exclude_none=True)
                for tool, arguments in turn.expect.args.items()
            },
            "never": list(turn.expect.never),
        },
        "graders": case_graders(turn),
    }


def tool_specs(offerings: list[OfferingFacts]) -> list[dict[str, Any]]:
    """Describe the tools offered at the details step, as production defines them."""
    return [
        {"name": tool.name, "description": tool.description, "parameters": tool.parameters}
        for tool in tool_definitions(Step.DETAILS, [offering.key for offering in offerings])
    ]


def build_pack(golden: GoldenSet, offerings: list[OfferingFacts]) -> dict[str, Any]:
    """Build the whole pack from the golden set and the offerings."""
    return {
        "pack": PACK_NAME,
        "system": "lb-02",
        "target": {
            "name": "LB-02 booking planner",
            "description": (
                "Reads a visitor's first message to the booking concierge and records what they want with "
                "the update_details tool, or declines what is not a booking."
            ),
            "source": "services/django-systems/lb02/prompts.py",
            "alias": CHAT_ALIAS,
            "model_class": "tools",
            "max_output_tokens": CHAT_MAX_TOKENS,
            "output": "tool_calls",
        },
        "prompt": {"system": system_template(), "user": "{{message}}"},
        "variables": ["language", "offerings", "today", "first_day", "last_day", "party_limit"],
        "tools": tool_specs(offerings),
        "common_graders": [],
        "cases": [pack_case(case, offerings) for case in gradable_cases(golden)],
    }


def gradable_cases(golden: GoldenSet) -> list[GoldenCase]:
    """Return the conversations whose first turn the golden set grades at all.

    A first turn that only moves the conversation on, with no tool, argument or forbidden text named,
    is graded by production's eval over the whole conversation and has no place in a one-turn pack.
    """
    return [case for case in golden.cases if case_graders(case.turns[0])]


def check_matches_production(pack: dict[str, Any], golden: GoldenSet, offerings: list[OfferingFacts]) -> None:
    """Refuse a pack whose filled-in templates differ from the messages `fit_history` builds for a first turn."""
    cases_by_id = {case["id"]: case for case in pack["cases"]}
    first_day, last_day = bookable_days(PACK_NOW)
    tools = tool_definitions(Step.DETAILS, [offering.key for offering in offerings])
    for case in gradable_cases(golden):
        inputs = cases_by_id[case.id]["inputs"]
        rendered = [render(pack["prompt"]["system"], inputs), render(pack["prompt"]["user"], inputs)]
        system = system_prompt(case.language, PACK_TODAY, first_day, last_day, offerings)
        messages = fit_history(system, fresh_state(), [], mask(case.turns[0].say).text, tools)
        require_same(rendered, [message.content or "" for message in messages], case.id)


def export_pack(seed_directory: Path, golden_path: Path | None = None) -> dict[str, Any]:
    """Build the pack from the golden set and the offerings, proven to match production."""
    golden = read_golden_set(golden_path)
    offerings = offering_facts(seed_directory)
    pack = build_pack(golden, offerings)
    check_matches_production(pack, golden, offerings)
    return pack
