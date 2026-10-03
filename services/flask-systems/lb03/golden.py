"""LB-03's golden set: documents with their printed truth, and what the pipeline must make of each.

evals/lb03/golden.yaml is written before any prompt (docs/PLAYBOOK.md, step 3), graded by rules and
never by a model, and it is data: the fields each document prints, which checks a planted error must
trip, which documents are hostile, and how each file was drawn. `just seed-lb03` draws the files in
data/seed/lb03 from it, and writes data/seed/lb03/manifest.json: each file's hash and, for every field,
where on the page it is printed (the boxes the field-box measurement is judged against).

Amounts are written as quoted strings in the YAML, because YAML would read `7400.00` as a float, and a
float is exactly what money must never be: the reader refuses an unquoted decimal.

The reader is strict: an unknown field is an error, and so is a golden set that contradicts itself (a
planted error that names no check, a sample that is not a case, a duplicate of nothing).
"""

from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Annotated, Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError, field_validator, model_validator

from core.data_files import DataFileError, Key, StrictEntry, read_data_file
from lb03.checks import CheckId
from lb03.invoice import CURRENCIES, DocumentType
from lb03.money import amount_text
from lb03.states import FailureCode

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
# Where the golden set and the seed documents live, in the repository.
EVALS_DIRECTORY = REPOSITORY_ROOT / "evals" / "lb03"
SEED_DIRECTORY = REPOSITORY_ROOT / "data" / "seed" / "lb03"
MANIFEST_FILE = "manifest.json"

Kind = Literal[
    "clean_pdf",
    "multi_page_pdf",
    "photo",
    "handwritten",
    "euro_vat",
    "credit_note",
    "duplicate",
    "hostile",
    "planted_error",
    "over_limit",
    "unreadable",
]
Medium = Literal["pdf", "photo", "handwritten", "blank"]
Style = Literal["classic", "modern", "compact", "receipt", "handwritten", "blank"]
NumberStyle = Literal["en", "de", "cs"]
DateStyle = Literal["iso", "dmy_dots", "dmy_slashes", "text", "cs"]
ImageFormat = Literal["jpeg", "png", "webp"]
Outcome = Literal["valid", "needs_review", "held", "failed"]
Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=4, max_length=120)]
Line = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]
FilePath = Annotated[str, StringConstraints(pattern=r"^documents/[a-z0-9-]{3,70}\.(?:pdf|png|jpg|webp)$")]


Amount = Annotated[Decimal, Field(ge=Decimal(-(10**9)), le=Decimal(10**9))]


class StrictAmounts(StrictEntry):
    """A schema whose amounts are read as Decimals from strings, and refuse floats."""

    @field_validator("*", mode="before")
    @classmethod
    def _no_floats(cls, value: object) -> object:
        """Refuse an unquoted decimal anywhere in the entry, since YAML would have made it a float."""
        if isinstance(value, float):
            raise ValueError("write amounts as quoted strings, such as '7400.00'")
        return value


class PrintedLine(StrictAmounts):
    """One row of the printed table."""

    description: Line
    quantity: Amount
    unit_price: Amount
    total: Amount


class PrintedVat(StrictAmounts):
    """One printed VAT rate: the rate in percent, what it applies to, and the VAT."""

    rate: Amount
    base: Amount | None = None
    amount: Amount


class Printed(StrictAmounts):
    """What a document prints, as the extraction must read it: planted errors included."""

    document_type: DocumentType
    vendor: Line
    invoice_number: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]
    issue_date: date
    due_date: date | None = None
    currency: str
    prices_include_vat: bool = False
    line_items: list[PrintedLine] = Field(min_length=1, max_length=40)
    subtotal: Amount | None = None
    vat: list[PrintedVat] = Field(default_factory=list, max_length=8)
    total: Amount

    @field_validator("currency")
    @classmethod
    def _known_currency(cls, currency: str) -> str:
        """Require a currency from the short list."""
        if currency not in CURRENCIES:
            raise ValueError(f"the currency must be one of {', '.join(CURRENCIES)}")
        return currency


class Expect(StrictEntry):
    """What the pipeline must make of a document.

    `valid`: the fields equal the printed ones and every check passes. `needs_review`: the fields equal the
    printed ones and exactly `failing_checks` fail (a planted error, which the pipeline must report and
    never silently fix). `held`: a hostile document, which counts as held when it is blocked by the injection
    check, or read faithfully, or reported with failing checks, and never when it is passed as valid with
    a field that differs from the printed truth. `failed`: the pipeline gives up with `failure`.
    """

    outcome: Outcome
    failing_checks: list[CheckId] = Field(default_factory=list)
    failure: FailureCode | None = None
    # The case whose document this one repeats, which the duplicate check must name.
    duplicate_of: Key | None = None
    # Whether the prompt-injection check must flag the document's text.
    guard_flags: bool = False
    # What the printed truth must not become when the document is hostile, such as {'total': '0.00'}.
    must_not_become: dict[str, str] = Field(default_factory=dict)


class PhotoEffects(StrictEntry):
    """How a page is made to look photographed: the same effects that make a phone photo hard to read."""

    rotation_degrees: Annotated[float, Field(ge=-30, le=30)] = 0.0
    # How far the page's corners are pulled out of square, as a share of the page's size.
    perspective: Annotated[float, Field(ge=0, le=0.2)] = 0.0
    # How much the paper is crumpled: a smooth wave in the page that bends the text and the light.
    crumple: Annotated[float, Field(ge=0, le=1)] = 0.0
    blur_pixels: Annotated[float, Field(ge=0, le=6)] = 0.0
    noise: Annotated[float, Field(ge=0, le=40)] = 0.0
    shadow: Annotated[float, Field(ge=0, le=0.8)] = 0.0
    brightness: Annotated[float, Field(ge=0.4, le=1.3)] = 1.0
    jpeg_quality: Annotated[int, Field(ge=30, le=95)] = 80
    long_side_pixels: Annotated[int, Field(ge=600, le=3000)] = 1300
    # The EXIF orientation the file is stored with: the pixels are stored turned the other way, as a phone does.
    exif_orientation: Literal[1, 3, 6, 8] = 1
    # Whether the file carries a GPS position in its EXIF, to prove it is stripped.
    gps: bool = False
    format: ImageFormat = "jpeg"


class Render(StrictEntry):
    """How a document is drawn: the medium, the layout, the number and date styles, and any effects."""

    medium: Medium
    style: Style
    pages: Annotated[int, Field(ge=1, le=6)] = 1
    number_style: NumberStyle = "en"
    date_style: DateStyle = "iso"
    seed: Annotated[int, Field(ge=0, le=1_000_000)]
    photo: PhotoEffects | None = None
    # A word stamped across the page, such as DUPLICATE.
    stamp: str | None = None
    # Extra lines printed at the foot of the page: the hostile text.
    notice: list[Line] = Field(default_factory=list, max_length=6)
    # A byte-for-byte copy of another case's file, for the exact duplicate.
    copy_of: Key | None = None

    @model_validator(mode="after")
    def _check_medium(self) -> Self:
        """Require photo effects for a photo, and none for a PDF."""
        if (self.medium in {"photo", "handwritten", "blank"}) != (self.photo is not None):
            raise ValueError("a photographed page has photo effects, and a PDF has none")
        return self


class GoldenCase(StrictEntry):
    """One document of the golden set."""

    id: Key
    title: Title
    kind: Kind
    # The curated sample this document is, when it opens the board. Its recorded run is replayed.
    sample: Key | None = None
    file: FilePath
    printed: Printed | None = None
    expect: Expect
    render: Render

    @model_validator(mode="after")
    def _check_expectation(self) -> Self:
        """Require the expectation to fit the case: a printed truth to read, failing checks to name, a failure code."""
        expect = self.expect
        if expect.outcome in {"valid", "needs_review", "held"} and self.printed is None:
            raise ValueError("a document that is read has a printed truth")
        if (expect.outcome == "needs_review") != bool(expect.failing_checks):
            raise ValueError("needs_review names the failing checks, and nothing else does")
        if (expect.outcome == "failed") != (expect.failure is not None):
            raise ValueError("failed names its failure code, and nothing else does")
        if expect.outcome == "held" and not expect.must_not_become:
            raise ValueError("a hostile document says what the printed truth must not become")
        return self


class GoldenSet(StrictEntry):
    """The whole of golden.yaml: the day the checks are judged on, and the documents."""

    today: date
    cases: list[GoldenCase] = Field(min_length=30)

    @model_validator(mode="after")
    def _check_cases(self) -> Self:
        """Refuse repeated IDs, files or samples, and references to cases that don't exist."""
        ids = [case.id for case in self.cases]
        if len(set(ids)) != len(ids):
            raise ValueError("a case ID appears more than once")
        files = [case.file for case in self.cases]
        if len(set(files)) != len(files):
            raise ValueError("a file appears more than once")
        samples = [case.sample for case in self.cases if case.sample is not None]
        if len(set(samples)) != len(samples):
            raise ValueError("a sample appears more than once")
        known = set(ids)
        for case in self.cases:
            for reference in (case.expect.duplicate_of, case.render.copy_of):
                if reference is not None and (reference not in known or reference == case.id):
                    raise ValueError(f"case {case.id!r} refers to {reference!r}, which is not another case")
        return self

    def case(self, case_id: str) -> GoldenCase:
        """Return one case by its ID."""
        return next(case for case in self.cases if case.id == case_id)

    def samples(self) -> list[GoldenCase]:
        """Return the curated samples the board opens on, in the order they are written."""
        return [case for case in self.cases if case.sample is not None]


class FieldBox(BaseModel):
    """Where one field is printed: the page (from 1) and the box's four corners, as x, y from 0 to 1."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    path: str
    page: int = Field(ge=1, le=6)
    quad: tuple[float, float, float, float, float, float, float, float]


class FileEntry(BaseModel):
    """One seed file as the generator made it: its hash, its shape and the boxes of its printed fields."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    file: str
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    bytes: int = Field(ge=1)
    mime: Literal["application/pdf", "image/png", "image/jpeg", "image/webp"]
    pages: int = Field(ge=1, le=6)
    # The size of the first page: in PDF points for a PDF, in pixels for an image.
    width: int = Field(ge=1)
    height: int = Field(ge=1)
    fields: list[FieldBox] = Field(default_factory=list)


class Manifest(BaseModel):
    """data/seed/lb03/manifest.json: the files, in the order of the golden set."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    version: Literal[1] = 1
    files: list[FileEntry]

    def entry(self, case_id: str) -> FileEntry:
        """Return one file's entry by its case ID."""
        return next(entry for entry in self.files if entry.id == case_id)


def read_golden_set(directory: Path = EVALS_DIRECTORY) -> GoldenSet:
    """Read and check evals/lb03/golden.yaml."""
    return read_data_file(directory / "golden.yaml", GoldenSet)


def read_manifest(directory: Path = SEED_DIRECTORY) -> Manifest:
    """Read and check data/seed/lb03/manifest.json."""
    path = directory / MANIFEST_FILE
    try:
        return Manifest.model_validate_json(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise DataFileError(f"{path} can't be read: {error.strerror}") from None
    except ValidationError as error:
        problems = [f"{'.'.join(str(part) for part in issue['loc'])}: {issue['msg']}" for issue in error.errors()[:8]]
        raise DataFileError(f"{path} doesn't follow its schema:\n- " + "\n- ".join(problems)) from None


def printed_as_reply(printed: Printed) -> dict[str, Any]:
    """Write a printed truth as the JSON a perfect model would answer with: what the fake model of the tests says."""
    return {
        "document_type": printed.document_type,
        "vendor": printed.vendor,
        "invoice_number": printed.invoice_number,
        "issue_date": printed.issue_date.isoformat(),
        "due_date": printed.due_date.isoformat() if printed.due_date else None,
        "currency": printed.currency,
        "prices_include_vat": printed.prices_include_vat,
        "line_items": [
            {
                "description": line.description,
                "quantity": str(line.quantity),
                "unit_price": amount_text(line.unit_price),
                "total": amount_text(line.total),
            }
            for line in printed.line_items
        ],
        "subtotal": amount_text(printed.subtotal) if printed.subtotal is not None else None,
        "vat": [
            {
                "rate": str(line.rate),
                "base": amount_text(line.base) if line.base is not None else None,
                "amount": amount_text(line.amount),
            }
            for line in printed.vat
        ],
        "total": amount_text(printed.total),
    }
