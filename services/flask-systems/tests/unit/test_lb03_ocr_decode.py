"""Decoding hostile files: what is refused before a decoder runs, what each decoder is held to, and what comes out.

These run the decoding code in this process, with no cage, because the point here is what the code decides
about a file, not what it could do if it failed. The cage has its own tests (test_lb03_ocr_sandbox.py), and
the two meet in the worker tests (test_lb03_ocr_worker.py).
"""

import io
import zlib
from pathlib import Path

import pytest
from PIL import Image
from reportlab.pdfgen.canvas import Canvas

from lb03.golden import SEED_DIRECTORY, read_manifest
from lb03.ocr.decode import (
    FORBIDDEN_NAMES,
    MAX_OBJECT_STREAM_BYTES,
    MAX_OBJECT_STREAMS,
    DecodeError,
    check_pdf_bytes,
    decode_document,
    pdf_names,
)
from lb03.ocr.pool import default_worker_limits
from lb03.ocr.protocol import WorkerLimits
from lb03.states import FailureCode

LIMITS = default_worker_limits()


def limited(**changes: int) -> WorkerLimits:
    """Return the production limits with some of them changed."""
    return LIMITS.model_copy(update=changes)


def refusal(data: bytes, limits: WorkerLimits = LIMITS) -> FailureCode:
    """Decode a file that must be refused, and return the code it is refused with."""
    with pytest.raises(DecodeError) as caught:
        decode_document(data, limits)
    return caught.value.code


def minimal_pdf(catalog: str = "", page: str = "", media_box: str = "[0 0 200 100]") -> bytes:
    """Write a one-page PDF by hand, with extra entries in its catalog and page, for pdfium to repair and read."""
    return (
        "%PDF-1.7\n"
        f"1 0 obj << /Type /Catalog /Pages 2 0 R {catalog} >> endobj\n"
        "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n"
        f"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox {media_box} {page} >> endobj\n"
        "trailer << /Root 1 0 R >>\n"
    ).encode("latin-1")


def object_stream_pdf(
    inside: bytes, dictionary: str = "/Type /ObjStm /Filter /FlateDecode", compress: bool = True
) -> bytes:
    """Write a PDF with one object stream holding `inside`, compressed (or not) as the dictionary says."""
    content = zlib.compress(inside) if compress else inside
    return (
        b"%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"
        b"2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n"
        + f"5 0 obj << {dictionary} /N 1 /First 4 /Length {len(content)} >>\nstream\n".encode("latin-1")
        + content
        + b"\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n"
    )


def drawn_pdf(pages: int, text: str = "Invoice") -> bytes:
    """Draw a PDF of `pages` pages with ReportLab, the way the seed documents are made."""
    buffer = io.BytesIO()
    canvas = Canvas(buffer, pagesize=(300, 200), invariant=True)
    for number in range(pages):
        canvas.drawString(20, 100, f"{text} {number + 1}")
        canvas.showPage()
    canvas.save()
    return buffer.getvalue()


def image_bytes(image: Image.Image, format_name: str, **options: object) -> bytes:
    """Encode a Pillow image in a format."""
    buffer = io.BytesIO()
    image.save(buffer, format_name, **options)
    return buffer.getvalue()


@pytest.mark.parametrize("name", sorted(FORBIDDEN_NAMES))
def test_a_pdf_that_names_something_active_or_external_is_refused(name: str) -> None:
    """Each forbidden name, written plainly in the file, makes the PDF unsafe."""
    assert refusal(minimal_pdf(catalog=f"/OpenAction << /S /{name} >>")) is FailureCode.UNSAFE_FILE


@pytest.mark.parametrize(
    "spelling",
    ["/J#61vaScript", "/Java#53cript", "/#4Aava#53cript", "/U#52I", "/Launc#68", "/Go#54oR", "/#46ilespec"],
)
def test_a_name_spelt_with_hex_escapes_is_the_same_name(spelling: str) -> None:
    """PDF lets any character of a name be written as `#` and two hex digits, so the scan unescapes first."""
    assert refusal(minimal_pdf(catalog=f"/OpenAction << /S {spelling} >>")) is FailureCode.UNSAFE_FILE


def test_the_names_of_a_chunk_are_unescaped() -> None:
    """`/J#61vaScript` is read as JavaScript, and ordinary names are left as they are."""
    assert pdf_names(b"<< /J#61vaScript /Type /Page >>") == {"JavaScript", "Type", "Page"}


def test_a_name_hidden_in_a_compressed_object_stream_is_found() -> None:
    """Objects packed into a Flate-compressed object stream are opened and read like the rest of the file."""
    packed = b"6 0 << /S /JavaScript /JS (app.alert(1)) >>"
    assert refusal(object_stream_pdf(packed)) is FailureCode.UNSAFE_FILE


def test_an_object_stream_whose_type_is_spelt_with_an_escape_is_still_opened() -> None:
    """Writing `/Type /Obj#53tm` does not hide an object stream from the scan."""
    packed = b"6 0 << /S /URI /URI (https://example.com) >>"
    data = object_stream_pdf(packed, dictionary="/Type /Obj#53tm /Filter /FlateDecode")
    assert refusal(data) is FailureCode.UNSAFE_FILE


def test_an_object_stream_that_cannot_be_opened_is_refused_not_trusted() -> None:
    """A stream that says it holds objects and is packed some other way is a file hiding something."""
    data = object_stream_pdf(b"6 0 << /S /URI >>", dictionary="/Type /ObjStm /Filter /ASCIIHexDecode", compress=False)
    assert refusal(data) is FailureCode.UNSAFE_FILE


def test_an_object_stream_that_grows_past_the_cap_is_refused() -> None:
    """A few kilobytes that inflate to more than the cap are a bomb, and the scan stops at the cap."""
    bomb = b"\x00" * (MAX_OBJECT_STREAM_BYTES + 1024)
    assert refusal(object_stream_pdf(bomb)) is FailureCode.UNSAFE_FILE


def test_too_many_object_streams_are_refused() -> None:
    """Opening is bounded: a file with more than the allowed number of object streams is refused."""
    content = zlib.compress(b"6 0 << /Type /Page >>")
    dictionary = f"/Type /ObjStm /Filter /FlateDecode /N 1 /First 4 /Length {len(content)}".encode()
    data = b"%PDF-1.7\n"
    for number in range(MAX_OBJECT_STREAMS + 1):
        data += f"{10 + number} 0 obj << ".encode() + dictionary + b" >>\nstream\n" + content + b"\nendstream\nendobj\n"
    assert refusal(data + b"trailer << /Root 1 0 R >>\n") is FailureCode.UNSAFE_FILE


def test_an_encrypted_pdf_is_unreadable() -> None:
    """The reader cannot open an encrypted PDF, and says so with its own code."""
    assert refusal(minimal_pdf(catalog="/Encrypt 9 0 R")) is FailureCode.UNREADABLE_FILE


def test_a_bare_js_in_binary_data_is_not_a_reason_to_refuse() -> None:
    """`/JS` alone is not forbidden: three bytes of compressed picture data would match it by chance."""
    pdf = drawn_pdf(1)
    check_pdf_bytes(pdf + b"\nstream\n" + b"\x00\x01/JS (x)\x02\nendstream\n")


def test_the_word_javascript_in_the_text_of_a_page_is_not_a_name() -> None:
    """A page that talks about JavaScript, with no name in the file, is an ordinary document."""
    document = decode_document(drawn_pdf(1, text="JavaScript tutorial"), LIMITS)
    assert document.kind.name == "pdf"
    assert len(document.pages) == 1


def test_five_pages_are_read_and_six_are_refused_before_any_is_drawn() -> None:
    """The page limit is five: it is counted from the file, and the sixth page is never rendered."""
    assert len(decode_document(drawn_pdf(5), LIMITS).pages) == 5
    assert refusal(drawn_pdf(6)) is FailureCode.TOO_MANY_PAGES


def test_a_page_is_drawn_no_larger_than_the_page_limit() -> None:
    """A big page is scaled so its long side is the page limit, and the pixels stay under the cap."""
    document = decode_document(minimal_pdf(media_box="[0 0 5000 3000]"), LIMITS)
    width, height = document.pages[0].size
    assert max(width, height) == LIMITS.page_long_side
    assert width * height <= LIMITS.max_pixels


def test_a_page_that_would_pass_the_pixel_cap_is_refused() -> None:
    """With a pixel cap below what the page limit allows, the page is refused instead of drawn."""
    assert refusal(drawn_pdf(1), limited(max_pixels=50_000)) is FailureCode.IMAGE_TOO_BIG


def test_an_absurd_page_size_is_unreadable() -> None:
    """A page that says it is a hundred thousand points wide is not a document."""
    assert refusal(minimal_pdf(media_box="[0 0 100000 100000]")) is FailureCode.UNREADABLE_FILE


def test_damaged_pdfs_are_unreadable() -> None:
    """Bytes that begin like a PDF and are not one give the unreadable code, not a crash."""
    assert refusal(b"%PDF-1.7\nthis is not a pdf at all") is FailureCode.UNREADABLE_FILE
    assert refusal(b"%PDF-1.7\n" + bytes(range(256)) * 20) is FailureCode.UNREADABLE_FILE


def test_every_seed_pdf_is_read_as_the_manifest_says() -> None:
    """The committed documents decode to the page counts the manifest records, which is also the false-refusal test."""
    manifest = read_manifest(SEED_DIRECTORY)
    for entry in manifest.files:
        if entry.mime != "application/pdf":
            continue
        data = (SEED_DIRECTORY / entry.file).read_bytes()
        if entry.pages > LIMITS.max_pages:
            assert refusal(data) is FailureCode.TOO_MANY_PAGES, entry.id
        else:
            assert len(decode_document(data, LIMITS).pages) == entry.pages, entry.id


@pytest.mark.parametrize(
    ("format_name", "kind"),
    [("PNG", "png"), ("JPEG", "jpeg"), ("WEBP", "webp")],
)
def test_png_jpeg_and_webp_are_decoded_to_one_rgb_page(format_name: str, kind: str) -> None:
    """Each image format gives one page of plain RGB pixels."""
    picture = Image.new("RGB", (320, 200), (200, 30, 30))
    document = decode_document(image_bytes(picture, format_name), LIMITS)
    assert document.kind.name == kind
    assert [page.mode for page in document.pages] == ["RGB"]
    assert document.pages[0].size == (320, 200)


def test_a_large_photograph_is_shrunk_to_the_page_limit() -> None:
    """An image bigger than the page limit is scaled down, keeping its shape."""
    document = decode_document(image_bytes(Image.new("RGB", (4000, 3000), "white"), "JPEG"), LIMITS)
    assert document.pages[0].size == (LIMITS.page_long_side, LIMITS.page_long_side * 3 // 4)


def test_the_exif_orientation_is_applied_and_the_metadata_is_gone() -> None:
    """A phone photo stored sideways stands upright, and no EXIF, GPS or other metadata survives into the page."""
    exif = Image.Exif()
    exif[0x0112] = 6
    exif[0x010F] = "Acme Phone"
    exif.get_ifd(0x8825)[1] = "N"
    picture = Image.new("RGB", (400, 200), "white")
    data = image_bytes(picture, "JPEG", exif=exif)
    assert Image.open(io.BytesIO(data)).getexif().get(0x0112) == 6
    page = decode_document(data, LIMITS).pages[0]
    assert page.size == (200, 400)
    assert len(page.getexif()) == 0
    assert page.info == {}


def test_a_transparent_png_is_put_on_white() -> None:
    """Transparent pixels become white, so an invoice with a see-through background is readable."""
    transparent = Image.new("RGBA", (50, 50), (0, 0, 0, 0))
    page = decode_document(image_bytes(transparent, "PNG"), LIMITS).pages[0]
    assert page.getpixel((10, 10)) == (255, 255, 255)


def test_an_image_over_the_pixel_cap_is_refused_from_its_header() -> None:
    """A small file that claims a huge picture is refused without decoding a pixel of it."""
    bomb = image_bytes(Image.new("1", (20_000, 20_000), 1), "PNG")
    assert len(bomb) < 1_000_000
    assert refusal(bomb) is FailureCode.IMAGE_TOO_BIG


def test_a_smaller_pixel_cap_refuses_a_smaller_picture() -> None:
    """The cap is a limit the service sets, so a stricter cap refuses what a looser one reads."""
    data = image_bytes(Image.new("RGB", (200, 100), "white"), "PNG")
    assert refusal(data, limited(max_pixels=10_000)) is FailureCode.IMAGE_TOO_BIG
    assert len(decode_document(data, LIMITS).pages) == 1


def test_truncated_and_garbage_images_are_unreadable() -> None:
    """A cut-off JPEG, and bytes that only start like a PNG, give the unreadable code."""
    whole = image_bytes(Image.new("RGB", (300, 300), (10, 120, 240)), "JPEG")
    assert refusal(whole[: len(whole) // 2]) is FailureCode.UNREADABLE_FILE
    assert refusal(b"\x89PNG\r\n\x1a\n" + b"not really a png" * 50) is FailureCode.UNREADABLE_FILE
    assert refusal(b"RIFF\x24\x00\x00\x00WEBPVP8 junkjunkjunk") is FailureCode.UNREADABLE_FILE


@pytest.mark.parametrize(
    "data",
    [
        b"",
        b"GIF89a" + b"\x00" * 40,
        b"<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'></svg>",
        b"<!doctype html><script>alert(1)</script>",
        b"PK\x03\x04" + b"\x00" * 40,
    ],
)
def test_other_kinds_of_file_are_unsupported(data: bytes) -> None:
    """The reader reads four kinds, and nothing else gets as far as a decoder."""
    assert refusal(data) is FailureCode.UNSUPPORTED_FILE


def test_a_file_over_the_size_limit_is_refused() -> None:
    """The worker checks the size again itself, so a service that sent too much still gets a refusal."""
    data = drawn_pdf(1)
    assert refusal(data, limited(max_bytes=len(data) - 1)) is FailureCode.TOO_LARGE


def test_a_refusal_never_quotes_the_file() -> None:
    """The error carries a fixed code and a message made of nothing but that code."""
    secret = b"INVOICE-SECRET-12345"
    with pytest.raises(DecodeError) as caught:
        decode_document(b"%PDF-1.7\n" + secret + b" /URI ", LIMITS)
    assert secret.decode() not in str(caught.value)
    assert str(caught.value) == caught.value.code.value


def test_the_seed_folder_is_where_the_documents_are() -> None:
    """A guard for the tests above: the committed documents exist, so the loop over them tests something."""
    assert len(list(Path(SEED_DIRECTORY, "documents").glob("*.pdf"))) >= 20
