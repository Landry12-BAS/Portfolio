"""Duplicates: the same vendor and number, told from the same content, among a visitor's documents and the samples."""

from decimal import Decimal

import pytest

from lb03.checks import CheckId, Severity
from lb03.duplicates import (
    Identity,
    Known,
    content_hash,
    duplicate_result,
    find_duplicate,
    identity_of,
    key_of,
    sample_identities,
    vendor_key,
)
from lb03.golden import GoldenCase, printed_as_reply, read_golden_set
from lb03.invoice import ExtractedInvoice


def golden_invoice(case: GoldenCase) -> ExtractedInvoice:
    """Make the invoice a perfect model would read from a golden document."""
    assert case.printed is not None
    return ExtractedInvoice.from_reply(printed_as_reply(case.printed))


def original() -> ExtractedInvoice:
    """Return the clean sample's invoice."""
    return golden_invoice(read_golden_set().case("bohemia-packaging-2026-0412"))


def known(reference: str, invoice: ExtractedInvoice, source: str = "document") -> Known:
    """Make the record of a document an upload is compared with."""
    identity = identity_of(invoice)
    assert identity is not None
    return Known(source, reference, identity)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "spelling",
    [
        "Bohemia Packaging s.r.o.",
        "bohemia packaging",
        "BOHEMIA PACKAGING S.R.O",
        "Bohemia  Packaging, s.r.o.",
        "Bohémia Packaging",
    ],
)
def test_one_vendor_has_one_key_however_it_is_read(spelling: str) -> None:
    """Case, accents, punctuation and the legal form at the end do not make another vendor."""
    assert vendor_key(spelling) == vendor_key("Bohemia Packaging s.r.o.") == "bohemiapackaging"


def test_different_vendors_have_different_keys() -> None:
    """Two vendors that share a word, or a legal form, are two vendors."""
    assert vendor_key("Bohemia Packaging s.r.o.") != vendor_key("Bohemia Labels s.r.o.")
    assert vendor_key("s.r.o.") == "sro"


@pytest.mark.parametrize("number", ["INV-0230", "inv 0230", "INV0230", "Inv-0230."])
def test_one_number_has_one_key(number: str) -> None:
    """Separators and case do not make another number."""
    assert key_of(number) == "inv0230"


def test_the_content_hash_ignores_formatting_and_notices_a_changed_amount() -> None:
    """The same invoice read twice hashes alike; a changed total or line does not."""
    first = original()
    reread = ExtractedInvoice.model_validate({**first.model_dump(mode="json"), "vendor": "bohemia packaging S.R.O."})
    assert content_hash(first) == content_hash(reread)
    changed_total = first.model_copy(update={"total": Decimal("10407.00")})
    changed_line = first.model_copy(
        update={
            "line_items": [first.line_items[0].model_copy(update={"quantity": Decimal("9")}), *first.line_items[1:]]
        }
    )
    assert content_hash(changed_total) != content_hash(first)
    assert content_hash(changed_line) != content_hash(first)


def test_an_invoice_without_a_vendor_or_a_number_has_no_identity() -> None:
    """With nothing to tell it apart by, the duplicate check cannot run."""
    assert identity_of(ExtractedInvoice(invoice_number="1")) is None
    assert identity_of(ExtractedInvoice(vendor="Acme")) is None
    assert identity_of(ExtractedInvoice(vendor="---", invoice_number="...")) is None
    assert identity_of(original()) is not None


def test_the_same_vendor_and_number_is_a_duplicate_with_the_same_content() -> None:
    """A copy, a re-scan or a resend is named, and said to have the same content."""
    identity = identity_of(original())
    assert identity is not None
    match = find_duplicate(identity, [known("doc-1", original())])
    assert match is not None
    assert match.known.reference == "doc-1"
    assert match.same_content is True


def test_the_same_number_with_other_amounts_is_a_duplicate_with_different_content() -> None:
    """A corrected reissue under the old number is still named, and said to differ."""
    changed = original().model_copy(update={"total": Decimal("99.00")})
    identity = identity_of(changed)
    assert identity is not None
    match = find_duplicate(identity, [known("doc-1", original())])
    assert match is not None
    assert match.same_content is False


def test_an_identical_document_is_preferred_over_an_earlier_one_with_the_same_number() -> None:
    """With two candidates, the one with the same content is the one named."""
    changed = original().model_copy(update={"total": Decimal("99.00")})
    identity = identity_of(original())
    assert identity is not None
    match = find_duplicate(identity, [known("old", changed), known("same", original())])
    assert match is not None
    assert match.known.reference == "same"
    assert match.same_content is True


def test_another_vendor_or_another_number_is_not_a_duplicate() -> None:
    """Either part of the key differing makes a different invoice."""
    base = original()
    identity = identity_of(base)
    assert identity is not None
    other_number = base.model_copy(update={"invoice_number": "2026-0413"})
    other_vendor = base.model_copy(update={"vendor": "Another Supplier s.r.o."})
    assert find_duplicate(identity, [known("a", other_number), known("b", other_vendor)]) is None
    assert find_duplicate(identity, []) is None


def test_the_samples_are_known_and_an_upload_of_a_sample_is_its_duplicate() -> None:
    """The five curated samples are identities too, so uploading a sample's invoice names that sample."""
    samples = sample_identities(read_golden_set())
    assert {item.reference for item in samples} >= {"clean-pdf", "crumpled-photo", "handwritten-receipt", "euro-vat"}
    assert all(item.source == "sample" for item in samples)
    identity = identity_of(original())
    assert identity is not None
    match = find_duplicate(identity, samples)
    assert match is not None
    assert (match.known.source, match.known.reference, match.same_content) == ("sample", "clean-pdf", True)


def test_the_golden_duplicates_are_the_sample_by_identity() -> None:
    """The two duplicate cases (a copy and a reissue) have the original's vendor, number and content."""
    golden = read_golden_set()
    base = identity_of(golden_invoice(golden.case("bohemia-packaging-2026-0412")))
    for identifier in ("dup-bohemia-0412-copy", "dup-bohemia-0412-reissue"):
        assert identity_of(golden_invoice(golden.case(identifier))) == base


def test_no_two_distinct_golden_documents_are_duplicates_of_each_other_by_accident() -> None:
    """Apart from the planted duplicates, every document of the golden set has its own vendor and number."""
    golden = read_golden_set()
    seen: dict[tuple[str, str], str] = {}
    for case in golden.cases:
        if case.printed is None:
            continue
        identity = identity_of(golden_invoice(case))
        assert identity is not None
        key = (identity.vendor, identity.number)
        if key in seen:
            assert case.expect.duplicate_of == seen[key] or seen[key] == case.expect.duplicate_of, (case.id, seen[key])
        seen.setdefault(key, case.id)


def test_the_check_result_is_an_error_naming_what_the_document_duplicates() -> None:
    """A match fails the check with error severity, naming the document, and says whether the content is the same."""
    identity = identity_of(original())
    assert identity is not None
    result = duplicate_result(identity, find_duplicate(identity, [known("doc-9", original())]))
    assert result.id is CheckId.NOT_DUPLICATE
    assert result.failed
    assert result.severity is Severity.ERROR
    assert "document doc-9" in result.message
    assert "the same content" in result.message
    assert result.fields == ("vendor", "invoice_number")


def test_the_check_passes_without_a_match_and_is_skipped_without_an_identity() -> None:
    """A new document passes; one with no vendor or number cannot be checked and says so."""
    identity = identity_of(original())
    assert identity is not None
    assert duplicate_result(identity, None).status == "passed"
    assert duplicate_result(None, None).status == "skipped"


def test_identity_is_hashable_and_comparable() -> None:
    """Identities are plain values: equal when their three parts are."""
    assert Identity("a", "1", "h") == Identity("a", "1", "h")
    assert Identity("a", "1", "h") != Identity("a", "1", "g")
