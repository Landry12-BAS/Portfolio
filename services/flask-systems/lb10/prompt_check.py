"""Checking a visitor's edited prompt before anything runs: plain text, within the limit, with the pack's variables.

A prompt is the one thing a visitor writes. It is held to the datasheet's limit (4,000 characters), to plain
text (no control characters but line breaks and tabs), and to the pack's variables: a prompt that drops a
placeholder the production prompt fills, or adds one the pack doesn't know, would render into something the
cases can't fill, so it is refused with a sentence that names the variables. The prompt is also hashed here,
which is how it is named in the cache and the trace: its text never goes into either.
"""

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass

from lb10.limits import MAX_PROMPT_CHARS
from lb10.packs import EvalPack
from lb10.templates import placeholders

# How many variable names a message lists before it stops.
MAX_NAMED = 6


@dataclass(frozen=True)
class PromptProblem:
    """One reason a prompt is refused: a stable code and a sentence for people."""

    code: str
    message: str


def names(variables: Sequence[str]) -> str:
    """List variable names for a message, as `{{name}}`, at most a few."""
    shown = [f"{{{{{name}}}}}" for name in variables[:MAX_NAMED]]
    more = f" and {len(variables) - MAX_NAMED} more" if len(variables) > MAX_NAMED else ""
    return ", ".join(shown) + more


def check_prompt(text: str, pack: EvalPack) -> list[PromptProblem]:
    """Return every reason the prompt can't run on the pack, or an empty list when it can."""
    problems: list[PromptProblem] = []
    if not text.strip():
        problems.append(PromptProblem("empty", "The prompt is empty."))
    if len(text) > MAX_PROMPT_CHARS:
        problems.append(
            PromptProblem(
                "too_long", f"The prompt is {len(text):,} characters; at most {MAX_PROMPT_CHARS:,} are allowed."
            )
        )
    if any(not character.isprintable() and character not in "\n\r\t" for character in text):
        problems.append(PromptProblem("not_text", "The prompt holds control characters; it must be plain text."))
    found = placeholders(text)
    missing = [name for name in pack.variables if name not in found]
    unknown = [name for name in found if name not in pack.variables]
    if missing:
        problems.append(
            PromptProblem("missing_variables", f"The prompt dropped a variable the cases fill: {names(missing)}.")
        )
    if unknown:
        problems.append(
            PromptProblem(
                "unknown_variables", f"The prompt names a variable this pack does not have: {names(unknown)}."
            )
        )
    return problems


def prompt_hash(text: str) -> str:
    """Name a prompt by the SHA-256 of its text: the key the cache and the trace use, never the text itself."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def production_prompt_hash(pack: EvalPack) -> str:
    """Return the hash of the production prompt the pack carries."""
    return prompt_hash(pack.prompt.system)


def is_production_prompt(text: str, pack: EvalPack) -> bool:
    """Tell whether an edited prompt is still, character for character, the production prompt."""
    return text == pack.prompt.system
