"""Tests for the prompt check and the provider rule: what a visitor may write, and where it may go."""

import pytest

from lb10.limits import MAX_PROMPT_CHARS
from lb10.prompt_check import check_prompt, is_production_prompt, production_prompt_hash, prompt_hash
from lb10.providers import (
    PROVIDERS,
    SYNTHETIC_ONLY_PREFIX,
    ProviderNotAllowedError,
    alias_for,
    provider_of_alias,
    providers_for,
)
from tests.lb10_support import committed_pack

DRAFTER = committed_pack("lb01-drafter")
CLASSIFIER = committed_pack("lb01-classifier")


def test_the_production_prompt_passes_and_is_known_as_production() -> None:
    """The pack's own prompt always passes its own check, and is recognised so no edited variant runs."""
    assert check_prompt(DRAFTER.prompt.system, DRAFTER) == []
    assert is_production_prompt(DRAFTER.prompt.system, DRAFTER)
    assert prompt_hash(DRAFTER.prompt.system) == production_prompt_hash(DRAFTER)
    assert not is_production_prompt(DRAFTER.prompt.system + " ", DRAFTER)


def test_a_dropped_or_added_variable_is_refused_with_its_name() -> None:
    """The message names the variable, so a visitor can put it back or take it out."""
    without = DRAFTER.prompt.system.replace("{{language}}", "English")
    problems = check_prompt(without, DRAFTER)
    assert [problem.code for problem in problems] == ["missing_variables"]
    assert "{{language}}" in problems[0].message
    with_extra = DRAFTER.prompt.system + "\nToday is {{today}}."
    problems = check_prompt(with_extra, DRAFTER)
    assert [problem.code for problem in problems] == ["unknown_variables"]
    assert "{{today}}" in problems[0].message


def test_length_text_and_emptiness_are_checked() -> None:
    """Too long, control characters, or nothing at all: each is named."""
    assert [p.code for p in check_prompt("x" * (MAX_PROMPT_CHARS + 1), CLASSIFIER)] == ["too_long"]
    assert [p.code for p in check_prompt("Classify\x00 this", CLASSIFIER)] == ["not_text"]
    assert [p.code for p in check_prompt("   ", CLASSIFIER)] == ["empty"]
    assert check_prompt("Classify the ticket.\n\tReply with JSON.", CLASSIFIER) == []


def test_a_visitor_is_offered_only_providers_that_do_not_train_on_inputs() -> None:
    """Groq and Workers AI for visitors; OpenRouter only for synthetic runs."""
    assert [provider.id for provider in providers_for("visitor")] == ["groq", "workers-ai"]
    assert [provider.id for provider in providers_for("synthetic")] == ["groq", "workers-ai", "openrouter"]
    assert all(not provider.trains_on_inputs for provider in providers_for("visitor"))


@pytest.mark.parametrize("model_class", ["fast", "tools", "reason"])
def test_no_visitor_path_reaches_a_synthetic_only_alias(model_class: str) -> None:
    """Whatever the pack's model class, a visitor's alias is never an OpenRouter one, and asking for one is refused."""
    for provider in providers_for("visitor"):
        alias = alias_for(provider.id, model_class, "visitor")  # type: ignore[arg-type]
        assert not alias.startswith(SYNTHETIC_ONLY_PREFIX)
        assert provider_of_alias(alias) is provider
    with pytest.raises(ProviderNotAllowedError):
        alias_for("openrouter", model_class, "visitor")  # type: ignore[arg-type]
    with pytest.raises(ProviderNotAllowedError):
        alias_for("nvidia", model_class, "synthetic")  # type: ignore[arg-type]
    assert alias_for("openrouter", model_class, "synthetic").startswith(SYNTHETIC_ONLY_PREFIX)  # type: ignore[arg-type]


def test_every_pinned_alias_belongs_to_one_provider_and_is_in_routing() -> None:
    """The aliases this module names are the gateway's `lb-eval-*` aliases, each on one provider."""
    from pathlib import Path

    import yaml

    routing = yaml.safe_load((Path(__file__).resolve().parents[4] / "services/gateway/routing.yaml").read_text())
    lab = routing["systems"]["lb-10"]["aliases"]
    for provider in PROVIDERS:
        for alias in provider.aliases.values():
            assert alias in lab
            assert routing["aliases"][alias]["chain"][0].startswith(f"{provider.id}/")
            assert bool(routing["aliases"][alias].get("syntheticOnly")) == provider.trains_on_inputs
    assert provider_of_alias("lb-judge") is None
