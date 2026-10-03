"""Tests for LB-01's eval packs: they hold the production prompts, materialised, and the committed files are current."""

from django.conf import settings

from core.packs import packs_directory, render, render_pack
from lb01.golden import read_golden_set
from lb01.pack import CLASSIFIER_PACK, DRAFTER_PACK, MADE_BY, SOURCE, SeedFacts, export_packs
from lb01.prompts import CLASSIFY_SYSTEM, DRAFT_SYSTEM, LANGUAGE_NAMES, classify_messages
from lb01.redaction import redact

SEED = settings.SEED_DIR / "lb01"


def test_the_classifier_pack_renders_production_messages_for_every_ticket_but_the_injections() -> None:
    """Every ticket the screen lets through is in the pack, redacted, and renders to `classify_messages`."""
    pack = export_packs(SEED)[CLASSIFIER_PACK]
    golden = read_golden_set()
    assert pack["prompt"]["system"] == CLASSIFY_SYSTEM
    ids = {case["id"] for case in pack["cases"]}
    assert ids == {case.id for case in golden.cases if case.expect.reason != "injection"}
    for case in golden.cases:
        if case.id not in ids:
            continue
        packed = next(entry for entry in pack["cases"] if entry["id"] == case.id)
        expected = [message.content for message in classify_messages(redact(case.ticket).text)]
        assert [
            render(pack["prompt"]["system"], packed["inputs"]),
            render(pack["prompt"]["user"], packed["inputs"]),
        ] == expected
        assert "@" not in packed["inputs"]["ticket"]


def test_the_drafter_pack_materialises_sources_in_the_tickets_language() -> None:
    """A Czech ticket gets its passages in Czech and the Czech language name; an order found gets its facts."""
    pack = export_packs(SEED)[DRAFTER_PACK]
    assert "{{language}}" in pack["prompt"]["system"]
    assert render(pack["prompt"]["system"], {"language": "Czech"}) == DRAFT_SYSTEM.format(language="Czech")
    assert pack["variables"] == ["language"]
    golden = read_golden_set()
    facts = SeedFacts(SEED)
    by_id = {case["id"]: case for case in pack["cases"]}
    czech = next(case for case in golden.cases if case.language == "cs" and case.id in by_id and case.expect.cites)
    inputs = by_id[czech.id]["inputs"]
    assert inputs["language"] == LANGUAGE_NAMES["cs"]
    assert f"[passage:{czech.expect.cites[0]}]" in inputs["sources"]
    assert facts.passages[czech.expect.cites[0]].text_cs in inputs["sources"]
    with_order = next(case for case in golden.cases if case.id in by_id and case.expect.order_found)
    assert (
        f"[order:{with_order.expect.order}] Order {with_order.expect.order}:"
        in by_id[with_order.id]["inputs"]["sources"]
    )


def test_the_committed_lb01_packs_are_what_the_exporter_writes_today() -> None:
    """The drift check: both files in evals/packs are the production prompts and golden set, materialised now."""
    for name, content in export_packs(SEED).items():
        path = packs_directory() / f"{name}.yaml"
        assert path.read_text(encoding="utf-8") == render_pack(content, MADE_BY, SOURCE), name
