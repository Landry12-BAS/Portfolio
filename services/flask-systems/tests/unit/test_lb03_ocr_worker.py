"""The real OCR worker on the synthetic documents: the cage up, the models loaded, a few seconds a document.

These start `python -m lb03.ocr.worker` for real, so they prove the parts the other tests only imitate: that
RapidOCR and pdfium run inside the cage (seccomp and Landlock together), that what comes back is what the
documents print, that refusals reach the service with their codes, and that no metadata of a photograph
survives into the stored picture. The accuracy of the reading is measured separately (`just ocr-lb03`).
"""

import asyncio
import io
import platform
from dataclasses import dataclass

import pytest
from PIL import Image

from lb03.golden import SEED_DIRECTORY, read_golden_set
from lb03.ocr import sandbox
from lb03.ocr.pool import OcrError, OcrPool, PoolSettings, Reading
from lb03.states import FailureCode

pytestmark = pytest.mark.ocr

NEEDS_A_CAGE = platform.system() == "Linux" and platform.machine() in sandbox.AUDIT_ARCH
DOCUMENTS = [
    "bohemia-packaging-2026-0412",
    "hanse-green-2026-4417",
    "photo-crumpled-bohemia-2026-0620",
    "photo-sideways-moravia-2026-0950",
    "photo-png-highland-2026-0230",
    "photo-webp-hanse-2026-4620",
    "hand-cafe-luna-0187",
    "hostile-total-zero",
    "blank-page",
    "six-pages-bohemia-2026-0888",
]


@dataclass(frozen=True)
class Outcome:
    """What the pool made of one document: a reading, or the failure."""

    reading: Reading | None
    failure: OcrError | None


async def read_documents() -> dict[str, Outcome]:
    """Read every document in the list, two at a time, the way a busy service would."""
    pool = OcrPool(PoolSettings(workers=2))
    golden = read_golden_set()
    files = {case.id: case.file for case in golden.cases}

    async def one(identifier: str) -> tuple[str, Outcome]:
        """Read one document and keep what happened to it."""
        data = (SEED_DIRECTORY / files[identifier]).read_bytes()
        try:
            return identifier, Outcome(await pool.read(data), None)
        except OcrError as error:
            return identifier, Outcome(None, error)

    return dict(await asyncio.gather(*(one(identifier) for identifier in DOCUMENTS)))


@pytest.fixture(scope="module")
def outcomes() -> dict[str, Outcome]:
    """Read the documents once for the whole module."""
    return asyncio.run(read_documents())


def reading_of(outcomes: dict[str, Outcome], identifier: str) -> Reading:
    """Return a document's reading, failing the test if it was refused."""
    outcome = outcomes[identifier]
    assert outcome.reading is not None, outcome.failure
    return outcome.reading


def words_of(reading: Reading) -> list[str]:
    """List the words of a reading, lower-cased, page after page."""
    return [word.text.lower() for page in reading.pages for word in page.words]


@pytest.mark.skipif(not NEEDS_A_CAGE, reason="the cage is built for Linux on x86-64 or aarch64")
def test_the_worker_reads_inside_the_cage(outcomes: dict[str, Outcome]) -> None:
    """The report that comes back shows the filter and the limits in force, and Landlock where the kernel has it."""
    report = reading_of(outcomes, "bohemia-packaging-2026-0412").sandbox
    assert report.rlimits
    assert report.no_new_privileges
    assert report.seccomp
    assert report.landlock_abi == sandbox.landlock_abi()


def test_a_clean_pdf_is_read_word_for_word(outcomes: dict[str, Outcome]) -> None:
    """The invoice number and the amounts the PDF prints are among the words, each with a confidence."""
    reading = reading_of(outcomes, "bohemia-packaging-2026-0412")
    printed = next(case.printed for case in read_golden_set().cases if case.id == "bohemia-packaging-2026-0412")
    assert printed is not None
    words = words_of(reading)
    assert printed.invoice_number.lower() in words
    assert "invoice" in words
    assert reading.kind == "pdf"
    assert len(reading.pages) == 1
    page = reading.pages[0]
    assert (page.width, page.height) == (1272, 1800)
    assert all(0.0 <= word.confidence <= 1.0 for word in page.words)
    assert all(0.0 <= value <= 1.0 for word in page.words for value in word.quad)
    # A PDF is read as text, so no picture is drawn for the vision model: only a photograph is sent to it.
    assert reading.model_picture is None


def test_a_photograph_is_read_and_its_pictures_are_jpegs(outcomes: dict[str, Outcome]) -> None:
    """A crumpled photograph gives words, a page picture and a smaller picture for the vision model."""
    reading = reading_of(outcomes, "photo-crumpled-bohemia-2026-0620")
    assert reading.kind == "jpeg"
    assert "bohemia" in words_of(reading)
    page_picture = Image.open(io.BytesIO(reading.pages[0].picture))
    assert page_picture.format == "JPEG"
    assert max(page_picture.size) <= 1800
    assert reading.model_picture is not None
    assert max(Image.open(io.BytesIO(reading.model_picture)).size) <= 1568


def test_the_metadata_of_a_photograph_never_reaches_the_stored_picture(outcomes: dict[str, Outcome]) -> None:
    """A sideways phone photo comes back upright, and what it came back as holds no EXIF and no GPS position."""
    seed = SEED_DIRECTORY / "documents" / "photo-sideways-moravia-2026-0950.jpg"
    with Image.open(seed) as original:
        exif = original.getexif()
    assert exif.get(0x0112, 1) != 1, "the seed photograph should be stored sideways"
    assert 0x8825 in exif, "the seed photograph should carry a GPS position"
    reading = reading_of(outcomes, "photo-sideways-moravia-2026-0950")
    for picture in (reading.pages[0].picture, reading.model_picture):
        assert picture is not None
        stored = Image.open(io.BytesIO(picture))
        assert len(stored.getexif()) == 0
        assert b"GPS" not in picture
        assert b"Exif" not in picture


@pytest.mark.parametrize("identifier", ["photo-png-highland-2026-0230", "photo-webp-hanse-2026-4620"])
def test_png_and_webp_photographs_are_read(outcomes: dict[str, Outcome], identifier: str) -> None:
    """The two other image formats go through the same worker."""
    reading = reading_of(outcomes, identifier)
    assert reading.kind in {"png", "webp"}
    assert len(reading.pages[0].words) > 20


def test_a_handwritten_receipt_still_gives_words_with_lower_confidence(outcomes: dict[str, Outcome]) -> None:
    """Handwriting is what this OCR is worst at: words come back, and their confidence says so."""
    reading = reading_of(outcomes, "hand-cafe-luna-0187")
    confidences = [word.confidence for word in reading.pages[0].words]
    assert len(confidences) >= 10
    assert sum(confidences) / len(confidences) < 0.99


def test_a_hostile_invoice_is_just_words_to_the_reader(outcomes: dict[str, Outcome]) -> None:
    """OCR does not interpret what it reads: an instruction in the document comes back as ordinary words."""
    reading = reading_of(outcomes, "hostile-total-zero")
    assert any(word in words_of(reading) for word in ("ignore", "instructions", "total"))


def test_a_blank_page_has_no_text(outcomes: dict[str, Outcome]) -> None:
    """A sheet with nothing on it is refused with the code that says so."""
    failure = outcomes["blank-page"].failure
    assert failure is not None
    assert failure.code is FailureCode.NO_TEXT


def test_six_pages_are_refused_before_any_is_read(outcomes: dict[str, Outcome]) -> None:
    """The page limit is enforced inside the worker, from the file, and reaches the service as its code."""
    failure = outcomes["six-pages-bohemia-2026-0888"].failure
    assert failure is not None
    assert failure.code is FailureCode.TOO_MANY_PAGES
