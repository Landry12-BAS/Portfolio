"""Tests that LB-09's limits in the code and its quotas in the gateway's routing.yaml agree with each other.

The gateway refuses what routing.yaml doesn't allow, and the service refuses what limits.py doesn't allow. If they
drift apart, a meeting is refused halfway through instead of finishing, or the datasheet's numbers stop being what
the system enforces.
"""

from typing import Any

import pytest
import yaml
from django.conf import settings
from lb09.golden import read_golden_set
from lb09.limits import (
    CHAT_CALLS_AT_MOST,
    EXTRACT_MAX_TOKENS,
    LABEL_MAX_TOKENS,
    MAX_RECORDING_SECONDS,
    MAX_TRANSCRIPT_CHARS,
    MODEL_CALLS_AT_MOST,
    RECORDINGS_PER_VISITOR_PER_DAY,
)

# Visitor meetings a day the daily quota is sized for.
MEETINGS_PER_DAY = 40


@pytest.fixture(scope="module")
def routing() -> dict[str, Any]:
    """Read the gateway's routing table the way its own checker does: as plain YAML."""
    path = settings.EVALS_DIR.parent / "services" / "gateway" / "routing.yaml"
    document: dict[str, Any] = yaml.safe_load(path.read_text(encoding="utf-8"))
    return document


@pytest.fixture(scope="module")
def system(routing: dict[str, Any]) -> dict[str, Any]:
    """Return LB-09's entry under `systems:`."""
    entry: dict[str, Any] = routing["systems"]["lb-09"]
    return entry


def test_lb_09_is_a_system_of_the_django_service_with_the_aliases_it_calls(
    routing: dict[str, Any], system: dict[str, Any]
) -> None:
    """The service may ask for speech to text, the fast model and the tools model, and nothing else."""
    assert system["service"] == "django-systems"
    assert set(system["aliases"]) == {"lb-stt", "lb-fast", "lb-tools"}
    assert set(system["aliases"]) <= set(routing["aliases"])


def test_the_gateway_never_refuses_before_the_service_stops_itself(system: dict[str, Any]) -> None:
    """The cap in routing.yaml is above the meeting's own budget of chat calls and the transcription."""
    assert system["maxCallsPerRun"] > MODEL_CALLS_AT_MOST
    assert MODEL_CALLS_AT_MOST == CHAT_CALLS_AT_MOST + 1


def test_a_visitor_can_run_their_five_meetings_a_day(system: dict[str, Any]) -> None:
    """The per-visitor quota covers the datasheet's five recordings at the meeting's full budget."""
    assert system["sessionDailyCalls"] >= RECORDINGS_PER_VISITOR_PER_DAY * MODEL_CALLS_AT_MOST


def test_the_daily_quota_covers_the_meetings_it_is_sized_for_and_a_golden_run(system: dict[str, Any]) -> None:
    """Forty visitor meetings a day, and the owner's golden-set run (two chat calls a case, with repairs) on top."""
    golden_run = len(read_golden_set().cases) * CHAT_CALLS_AT_MOST
    assert system["dailyCalls"] >= MEETINGS_PER_DAY * MODEL_CALLS_AT_MOST + golden_run


def test_the_speech_route_takes_the_datasheets_minute(routing: dict[str, Any]) -> None:
    """lb-stt's own cap is the recording length the service enforces, so the gateway is only the second line."""
    assert routing["aliases"]["lb-stt"]["maxAudioSeconds"] == MAX_RECORDING_SECONDS


def test_every_prompt_the_service_sends_fits_its_aliass_limits(routing: dict[str, Any]) -> None:
    """A full transcript plus the instructions sits inside what lb-fast and lb-tools accept, as do the output caps."""
    fast, tools = routing["aliases"]["lb-fast"], routing["aliases"]["lb-tools"]
    # About 3.5 characters a token for the words, a few tokens a line for the numbering (and, for the
    # extractor, the label), and the system prompt.
    words = MAX_TRANSCRIPT_CHARS / 3.5
    assert fast["maxInputTokens"] > words + 120 * 4 + 500
    assert tools["maxInputTokens"] > words + 120 * 7 + 650
    assert fast["maxOutputTokens"] >= LABEL_MAX_TOKENS
    assert tools["maxOutputTokens"] >= EXTRACT_MAX_TOKENS
