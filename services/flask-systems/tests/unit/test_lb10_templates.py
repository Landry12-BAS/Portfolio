"""Tests for the pack templates: placeholders, rendering, and the translation from Python format strings."""

import pytest
from lb10.templates import TemplateError, from_format_string, placeholders, render


def test_placeholders_are_listed_once_in_order_of_first_use() -> None:
    """A template that names a variable twice lists it once."""
    assert placeholders("Today {{today}}; customer {{name}}; again {{today}}") == ["today", "name"]


def test_a_lone_brace_and_json_examples_are_not_placeholders() -> None:
    """Prompts carry JSON examples with braces, which the template syntax leaves alone."""
    assert placeholders('Reply {"answerable": true, "sql": "..."} and {not_a_var') == []


def test_render_fills_every_placeholder_and_leaves_braces() -> None:
    """Rendering substitutes the inputs and keeps every other character."""
    text = render('<ticket>\n{{ticket}}\n</ticket> {"k": 1}', {"ticket": "Hi {there}", "unused": "x"})
    assert text == '<ticket>\nHi {there}\n</ticket> {"k": 1}'


def test_render_refuses_a_missing_input() -> None:
    """A placeholder with no input is an error, never an empty string in a prompt."""
    with pytest.raises(TemplateError, match="ticket"):
        render("{{ticket}} {{name}}", {"name": "Sam"})


def test_from_format_string_translates_python_templates_exactly() -> None:
    """`{language}` becomes a placeholder and `{{` becomes one brace, as `.format` would write it."""
    source = 'Write in {language}. Reply {{"text": "..."}}.'
    template = from_format_string(source)
    assert template == 'Write in {{language}}. Reply {"text": "..."}.'
    assert render(template, {"language": "Czech"}) == source.format(language="Czech")
