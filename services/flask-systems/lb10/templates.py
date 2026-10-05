"""Prompt templates as the eval packs store them: text with `{{name}}` placeholders, filled from a case's inputs.

A pack must carry the very prompt production runs, so each system's exporter turns its own template into
this form and the lab fills it back in exactly. The syntax is deliberately small: a placeholder is two
braces around a plain name, nothing is escaped, and a lone brace is just a brace, so a JSON example in a
prompt never has to be rewritten. The regular expression that finds placeholders is fixed here and never
built from a string.
"""

import re
from collections.abc import Mapping

# A placeholder: `{{ticket}}`. Names are lowercase words joined by underscores.
PLACEHOLDER = re.compile(r"\{\{([a-z][a-z0-9_]*)\}\}")
# Python's own format-string markers, which the exporters translate from.
FORMAT_OPEN = "\x00"
FORMAT_CLOSE = "\x01"


class TemplateError(ValueError):
    """A template names a variable the inputs don't hold, or an input the template doesn't use."""


def placeholders(text: str) -> list[str]:
    """Return the distinct placeholder names in a template, in the order they first appear."""
    seen: list[str] = []
    for match in PLACEHOLDER.finditer(text):
        name = match.group(1)
        if name not in seen:
            seen.append(name)
    return seen


def render(text: str, inputs: Mapping[str, str]) -> str:
    """Fill a template from `inputs`, refusing a placeholder with no input; unused inputs are fine."""
    missing = [name for name in placeholders(text) if name not in inputs]
    if missing:
        raise TemplateError(f"the template needs inputs it was not given: {', '.join(missing)}")
    return PLACEHOLDER.sub(lambda match: inputs[match.group(1)], text)


def from_format_string(text: str) -> str:
    """Turn a Python format string (`{name}`, with `{{` for a brace) into a pack template (`{{name}}`, bare braces).

    The exporters of systems whose prompts are `str.format` templates call this, so the pack's template
    renders to exactly what production's `.format(...)` writes.
    """
    protected = text.replace("{{", FORMAT_OPEN).replace("}}", FORMAT_CLOSE)
    converted = re.sub(r"\{([a-z][a-z0-9_]*)\}", r"{{\1}}", protected)
    return converted.replace(FORMAT_OPEN, "{").replace(FORMAT_CLOSE, "}")
