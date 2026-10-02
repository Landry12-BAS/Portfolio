"""Telling a document from one the visitor, or the samples, already hold: by vendor, number and content.

Two documents are the same invoice when they come from the same vendor under the same number, and the check says
so whether or not the rest matches, because a corrected reissue under the old number is exactly what should not
be booked twice without a look. What it says differs: `same_content` is true when the amounts and lines are
identical too (a copy, a re-scan, a resend), and false when they are not (a changed invoice with the old number).

Vendor and number are compared by their *keys*, which ignore case, accents, punctuation and a trailing legal form
(`Bohemia Packaging s.r.o.` and `bohemia packaging` are one vendor), because two scans of one invoice are read
a little differently each time. The content is compared by a hash of the amounts, the dates and the lines, in a
fixed order, so the same invoice read twice hashes alike however it was photographed.

The documents compared are the visitor's own unexpired ones, and the curated samples (`sample_identities`), so
an upload of a sample's invoice is named as that sample's duplicate.
"""

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass
from typing import Literal

from lb03.checks import CheckId, CheckResult, failed, passed, skipped
from lb03.golden import GoldenSet, printed_as_reply
from lb03.invoice import ExtractedInvoice
from lb03.money import amount_text, quantity_text

# Words that end a company's name and say what kind of company it is; they differ between two scans of one invoice.
LEGAL_FORMS = frozenset(
    {
        "sro",
        "as",
        "spol",
        "gmbh",
        "ltd",
        "limited",
        "inc",
        "llc",
        "srl",
        "sl",
        "bv",
        "nv",
        "co",
        "corp",
        "company",
        "ag",
    }
)
type Source = Literal["document", "sample"]


@dataclass(frozen=True)
class Identity:
    """What identifies an invoice: its vendor's key, its number's key, and a hash of its content."""

    vendor: str
    number: str
    content: str


@dataclass(frozen=True)
class Known:
    """A document an upload is compared with: its identity, whether it is a document or a sample, and its ID."""

    source: Source
    reference: str
    identity: Identity


@dataclass(frozen=True)
class Match:
    """A document an upload duplicates, and whether its content is the same as well as its vendor and number."""

    known: Known
    same_content: bool


def key_of(text: str) -> str:
    """Reduce a name or a number to letters and digits in lower case, without accents, for comparing."""
    decomposed = unicodedata.normalize("NFKD", text.casefold())
    return re.sub(r"[^a-z0-9]+", "", "".join(c for c in decomposed if not unicodedata.combining(c)))


def vendor_key(vendor: str) -> str:
    """Return a vendor's key: its words without the legal forms that end a company's name (`s.r.o.` is `sro`)."""
    decomposed = unicodedata.normalize("NFKD", vendor.casefold().replace(".", ""))
    words = re.findall(r"[a-z0-9]+", "".join(c for c in decomposed if not unicodedata.combining(c)))
    kept = [word for word in words if word not in LEGAL_FORMS]
    return "".join(kept or words)


def content_hash(invoice: ExtractedInvoice) -> str:
    """Hash an invoice's amounts, dates and lines, in a fixed order, as text that cannot differ by formatting."""
    content = {
        "type": invoice.document_type,
        "issued": invoice.issue_date.isoformat() if invoice.issue_date else None,
        "currency": invoice.currency,
        "subtotal": amount_text(invoice.subtotal) if invoice.subtotal is not None else None,
        "total": amount_text(invoice.total) if invoice.total is not None else None,
        "lines": [
            [
                key_of(item.description),
                quantity_text(item.quantity) if item.quantity is not None else None,
                amount_text(item.unit_price) if item.unit_price is not None else None,
                amount_text(item.total) if item.total is not None else None,
            ]
            for item in invoice.line_items
        ],
        "vat": [
            [
                quantity_text(line.rate) if line.rate is not None else None,
                amount_text(line.base) if line.base is not None else None,
                amount_text(line.amount) if line.amount is not None else None,
            ]
            for line in invoice.vat
        ],
    }
    return hashlib.sha256(json.dumps(content, sort_keys=True).encode("utf-8")).hexdigest()


def identity_of(invoice: ExtractedInvoice) -> Identity | None:
    """Return an invoice's identity, or None when it has no vendor or number to be told apart by."""
    if not invoice.vendor or not invoice.invoice_number:
        return None
    vendor, number = vendor_key(invoice.vendor), key_of(invoice.invoice_number)
    if not vendor or not number:
        return None
    return Identity(vendor, number, content_hash(invoice))


def find_duplicate(identity: Identity, known: list[Known]) -> Match | None:
    """Find the document an invoice duplicates: the same vendor and number, an identical one in preference."""
    candidates = [
        item for item in known if (item.identity.vendor, item.identity.number) == (identity.vendor, identity.number)
    ]
    if not candidates:
        return None
    for item in candidates:
        if item.identity.content == identity.content:
            return Match(item, same_content=True)
    return Match(candidates[0], same_content=False)


def sample_identities(golden: GoldenSet) -> list[Known]:
    """Return the identities of the curated samples' invoices, which an upload may duplicate."""
    found = []
    for case in golden.samples():
        if case.printed is None:
            continue
        identity = identity_of(ExtractedInvoice.from_reply(printed_as_reply(case.printed)))
        if identity is not None:
            found.append(Known("sample", case.sample or case.id, identity))
    return found


def duplicate_result(identity: Identity | None, match: Match | None) -> CheckResult:
    """Make the `not_duplicate` check's result: skipped without an identity, failed on a match, passed otherwise."""
    if identity is None:
        return skipped(CheckId.NOT_DUPLICATE, "The document has no vendor or number to be told apart by.")
    if match is None:
        return passed(CheckId.NOT_DUPLICATE, ("vendor", "invoice_number"))
    sameness = "and the same content" if match.same_content else "but different content"
    return failed(
        CheckId.NOT_DUPLICATE,
        f"The same vendor and invoice number as {match.known.source} {match.known.reference}, {sameness}.",
        ("vendor", "invoice_number"),
        expected="a document not seen before",
        actual=f"{match.known.source} {match.known.reference}",
    )
