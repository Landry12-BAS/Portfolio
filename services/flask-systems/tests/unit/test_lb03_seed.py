"""Tests for LB-03's seed documents: they are the files the golden set describes, intact, in range, and up to date."""

import hashlib
import io
from pathlib import Path

import pypdfium2 as pdfium
import pytest
from PIL import Image, ImageOps

from lb03.golden import SEED_DIRECTORY, GoldenSet, Manifest, read_golden_set, read_manifest
from lb03.limits import MAX_IMAGE_PIXELS, MAX_PAGES, MAX_UPLOAD_BYTES, PAGE_LONG_SIDE_PIXELS
from lb03.synthetic.build import check_pictures, check_seed

MAGIC = {
    "application/pdf": b"%PDF-",
    "image/png": b"\x89PNG\r\n\x1a\n",
    "image/jpeg": b"\xff\xd8\xff",
}
EXIF_ORIENTATION = 0x0112
EXIF_GPS = 0x8825


@pytest.fixture(scope="module")
def golden() -> GoldenSet:
    """Read the golden set once."""
    return read_golden_set()


@pytest.fixture(scope="module")
def manifest() -> Manifest:
    """Read the seed manifest once."""
    return read_manifest()


def test_every_file_is_the_one_the_manifest_hashes(golden: GoldenSet, manifest: Manifest) -> None:
    """The committed bytes are intact: same hash, same size, and the golden set's own file path."""
    assert [entry.id for entry in manifest.files] == [case.id for case in golden.cases]
    for case in golden.cases:
        entry = manifest.entry(case.id)
        content = (SEED_DIRECTORY / case.file).read_bytes()
        assert entry.file == case.file
        assert hashlib.sha256(content).hexdigest() == entry.sha256, case.id
        assert len(content) == entry.bytes


def test_every_file_is_what_its_magic_bytes_say(manifest: Manifest) -> None:
    """A PDF starts %PDF-, a PNG, JPEG or WebP carries its signature: what the intake check looks at."""
    for entry in manifest.files:
        content = (SEED_DIRECTORY / entry.file).read_bytes()
        if entry.mime == "image/webp":
            assert content[:4] == b"RIFF"
            assert content[8:12] == b"WEBP"
        else:
            assert content.startswith(MAGIC[entry.mime]), entry.id


def test_the_files_are_within_the_datasheets_limits(manifest: Manifest) -> None:
    """Under 10 MB, at most five pages (the one document over it excepted), and under the pixel cap."""
    for entry in manifest.files:
        assert entry.bytes < MAX_UPLOAD_BYTES
        if entry.mime == "application/pdf":
            assert entry.pages <= MAX_PAGES or entry.id == "six-pages-bohemia-2026-0888"
        else:
            assert entry.width * entry.height < MAX_IMAGE_PIXELS
    assert manifest.entry("six-pages-bohemia-2026-0888").pages == MAX_PAGES + 1
    assert sum(entry.bytes for entry in manifest.files) < 5_000_000


def test_pdfs_have_the_page_counts_the_manifest_says(manifest: Manifest) -> None:
    """The renderer counts the same pages as the generator wrote."""
    for entry in manifest.files:
        if entry.mime == "application/pdf":
            document = pdfium.PdfDocument(str(SEED_DIRECTORY / entry.file))
            try:
                assert len(document) == entry.pages, entry.id
            finally:
                document.close()


def test_every_printed_field_has_a_box_inside_its_page(golden: GoldenSet, manifest: Manifest) -> None:
    """Each printed field has a box, and every corner lies on the page (a photo's edge may be a hair out)."""
    for case in golden.cases:
        entry = manifest.entry(case.id)
        paths = {box.path for box in entry.fields}
        if case.printed is None:
            assert paths == set()
            continue
        expected = {"vendor", "invoice_number", "issue_date", "currency", "total"}
        for index in range(len(case.printed.line_items)):
            expected |= {f"line_items.{index}.{name}" for name in ("description", "quantity", "unit_price", "total")}
        for index in range(len(case.printed.vat)):
            expected |= {f"vat.{index}.rate", f"vat.{index}.amount"}
        if case.printed.due_date is not None:
            expected.add("due_date")
        if case.printed.subtotal is not None:
            expected.add("subtotal")
        assert expected <= paths, f"{case.id} lacks boxes for {sorted(expected - paths)}"
        for box in entry.fields:
            assert box.page <= entry.pages
            assert all(-0.02 <= value <= 1.02 for value in box.quad), (case.id, box.path)


def test_the_exact_duplicate_is_a_byte_copy(manifest: Manifest) -> None:
    """The same file uploaded twice has the same hash, which is what the duplicate check looks for."""
    assert manifest.entry("dup-bohemia-0412-copy").sha256 == manifest.entry("bohemia-packaging-2026-0412").sha256
    assert manifest.entry("dup-bohemia-0412-reissue").sha256 != manifest.entry("bohemia-packaging-2026-0412").sha256


def test_the_sideways_photo_is_stored_sideways_with_a_gps_position(manifest: Manifest) -> None:
    """EXIF orientation 6 and a GPS block are in the file, so the reader has something to turn and to strip."""
    path = SEED_DIRECTORY / manifest.entry("photo-sideways-moravia-2026-0950").file
    with Image.open(path) as image:
        exif = image.getexif()
        assert exif.get(EXIF_ORIENTATION) == 6
        assert exif.get_ifd(EXIF_GPS).get(2) == (49.0, 11.0, 38.0)
        stored = image.size
        upright = ImageOps.exif_transpose(image)
    assert upright is not None
    assert upright.size == (stored[1], stored[0])
    assert (
        manifest.entry("photo-sideways-moravia-2026-0950").width,
        manifest.entry("photo-sideways-moravia-2026-0950").height,
    ) == upright.size


def test_the_other_photos_carry_no_exif(manifest: Manifest) -> None:
    """Only the sideways photo has EXIF: the rest are as the generator drew them."""
    for entry in manifest.files:
        if entry.mime == "application/pdf" or entry.id == "photo-sideways-moravia-2026-0950":
            continue
        with Image.open(SEED_DIRECTORY / entry.file) as image:
            assert len(image.getexif()) == 0, entry.id


def test_the_handwriting_font_is_checked_in_with_its_licence() -> None:
    """The font is under the SIL Open Font License, and its licence text sits beside it."""
    fonts = SEED_DIRECTORY / "fonts"
    assert (fonts / "ReenieBeanie.ttf").stat().st_size > 50_000
    licence = (fonts / "OFL.txt").read_text(encoding="utf-8")
    assert "SIL OPEN FONT LICENSE Version 1.1" in licence
    assert "Reenie Beanie" in licence or "James Grieshaber" in licence


def test_every_image_decodes_to_the_size_the_manifest_says(manifest: Manifest) -> None:
    """The generator's recorded size is the decoded, upright size of the picture."""
    for entry in manifest.files:
        if entry.mime == "application/pdf":
            continue
        with Image.open(io.BytesIO((SEED_DIRECTORY / entry.file).read_bytes())) as image:
            upright = ImageOps.exif_transpose(image)
            assert upright is not None
            assert upright.size == (entry.width, entry.height), entry.id


def test_each_sample_has_a_picture_of_each_of_its_pages_as_the_viewer_shows_them(
    golden: GoldenSet, manifest: Manifest
) -> None:
    """The samples' page pictures are JPEGs within the page limit, with no metadata, and no others are there."""
    folder = SEED_DIRECTORY / "pages"
    expected = {
        f"{case.sample}-{number}.jpg"
        for case in golden.samples()
        for number in range(1, manifest.entry(case.id).pages + 1)
    }
    found = {path.name for path in folder.glob("*")}
    assert found == expected
    for name in found:
        with Image.open(folder / name) as picture:
            assert picture.format == "JPEG"
            assert max(picture.size) <= PAGE_LONG_SIDE_PIXELS
            assert len(picture.getexif()) == 0


def test_a_picture_that_is_missing_or_belongs_to_no_sample_is_reported(tmp_path: Path) -> None:
    """The picture check names a missing file, a picture of nothing, and a picture that shows something else."""
    folder = tmp_path / "pages"
    folder.mkdir()
    original = (SEED_DIRECTORY / "pages" / "clean-pdf-1.jpg").read_bytes()
    other = (SEED_DIRECTORY / "pages" / "handwritten-receipt-1.jpg").read_bytes()
    (folder / "stale-1.jpg").write_bytes(original)
    (folder / "euro-vat-1.jpg").write_bytes(other)
    fresh = {
        "pages/clean-pdf-1.jpg": original,
        "pages/euro-vat-1.jpg": (SEED_DIRECTORY / "pages" / "euro-vat-1.jpg").read_bytes(),
    }

    problems = check_pictures(tmp_path, fresh)

    assert problems == [
        "pages/stale-1.jpg is a picture of no sample",
        "pages/clean-pdf-1.jpg is missing",
        "pages/euro-vat-1.jpg is not what the generator draws now",
    ]


def test_the_seed_is_up_to_date() -> None:
    """Drawing everything again gives what is committed: PDFs byte for byte, photographs by what they show.

    A failure here means content.py, a layout or an effect changed and `just seed-lb03` was not run.
    """
    assert check_seed() == []
