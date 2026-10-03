"""The providers a run may be pinned to, and the one rule that keeps visitor content off the ones that train on it.

The gateway hides providers behind virtual aliases with fallbacks, which is right for production and wrong
for an eval: a score belongs to one model. So routing.yaml carries pinned eval aliases, one per provider and
model class, with no fallback (`lb-eval-*`), and this module maps a provider and a pack's model class to the
alias to call.

Two kinds of run reach them. A visitor's run carries the visitor's edited prompt, which is visitor content,
so it may use only the providers that do not train on inputs: Groq and Workers AI (`trainsOnInputs` in
routing.yaml). The nightly runs and CI's gate run curated, fixed prompts on synthetic cases, and may also use
OpenRouter, whose free hosts may train. The gateway refuses visitor content on those aliases too
(`syntheticOnly`); this module refuses first, so a visitor is never even offered them, and a test proves
that no visitor path can name one.
"""

from dataclasses import dataclass
from typing import Literal

from lb10.packs import ModelClass

# Who a run's content belongs to: a visitor (their edited prompt), or nobody (a fixed prompt on synthetic cases).
type DataClass = Literal["visitor", "synthetic"]
# The aliases every visitor run must stay away from begin with this.
SYNTHETIC_ONLY_PREFIX = "lb-eval-or-"


@dataclass(frozen=True)
class Provider:
    """One provider a run may be pinned to, and what a visitor should know about it."""

    id: str
    name: str
    # What the provider does with inputs, in a sentence for the board.
    note: str
    trains_on_inputs: bool
    aliases: dict[ModelClass, str]

    @property
    def visitor_allowed(self) -> bool:
        """Tell whether a visitor's own prompt may be sent to this provider."""
        return not self.trains_on_inputs


PROVIDERS: tuple[Provider, ...] = (
    Provider(
        id="groq",
        name="Groq",
        note="Fast hosted inference; does not train on inputs (abuse logs are kept up to 30 days).",
        trains_on_inputs=False,
        aliases={"fast": "lb-eval-groq-20b", "tools": "lb-eval-groq-120b", "reason": "lb-eval-groq-120b"},
    ),
    Provider(
        id="workers-ai",
        name="Cloudflare Workers AI",
        note="Serverless inference at the edge; does not train on inputs.",
        trains_on_inputs=False,
        aliases={"fast": "lb-eval-cf-20b", "tools": "lb-eval-cf-120b", "reason": "lb-eval-cf-120b"},
    ),
    Provider(
        id="openrouter",
        name="OpenRouter (free hosts)",
        note="Free models behind a router whose hosts may train on inputs: curated nightly runs only.",
        trains_on_inputs=True,
        aliases={"fast": "lb-eval-or-qwen", "tools": "lb-eval-or-qwen", "reason": "lb-eval-or-nemotron"},
    ),
)
PROVIDERS_BY_ID = {provider.id: provider for provider in PROVIDERS}


class ProviderNotAllowedError(ValueError):
    """A run named a provider it may not use: unknown, or one that trains on inputs for a visitor's prompt."""


def providers_for(data_class: DataClass) -> list[Provider]:
    """List the providers a run of this data class may be pinned to."""
    if data_class == "visitor":
        return [provider for provider in PROVIDERS if provider.visitor_allowed]
    return list(PROVIDERS)


def alias_for(provider_id: str, model_class: ModelClass, data_class: DataClass) -> str:
    """Return the pinned alias for a provider and model class, refusing a provider the run may not use."""
    provider = PROVIDERS_BY_ID.get(provider_id)
    if provider is None or provider not in providers_for(data_class):
        raise ProviderNotAllowedError(f"{provider_id!r} is not a provider this run may use")
    alias = provider.aliases[model_class]
    if data_class == "visitor" and alias.startswith(SYNTHETIC_ONLY_PREFIX):
        raise ProviderNotAllowedError("a visitor's prompt never reaches a synthetic-only alias")
    return alias


def provider_of_alias(alias: str) -> Provider | None:
    """Return the provider a pinned alias belongs to, or None for an alias that is not one of the eval aliases."""
    for provider in PROVIDERS:
        if alias in provider.aliases.values():
            return provider
    return None
