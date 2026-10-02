"""Decoding an untrusted file into pages: what is checked before a decoder runs, and the decoders themselves.

This runs only inside the caged OCR worker, and everything here assumes the file is hostile.

**A PDF** is first looked at as bytes, with no PDF library involved. It is refused if it names anything that
runs or reaches outside itself: JavaScript, a launch action, a link to a URI or another file, a submitted
form, a file specification or an embedded file, rich media, XFA. A PDF name may be spelt with hex escapes
(`/J#61vaScript` is `/JavaScript`), so names are unescaped before they are compared, and the objects a PDF may pack
into a compressed object stream are decompressed (to a hard cap) and read the same way; a PDF packed in a way that
can't be read this way is refused rather than trusted. This scan is a policy and a second wall, not the defence:
a file made by hand to confuse it can get past it, which is why the worker is caged, and pdfium, as pypdfium2
builds it, has no JavaScript engine and does not follow a link. Then the page count is taken, before a page is
drawn: more than five is refused. Pages are rendered by pdfium (pypdfium2, permissively licensed) at a size that
caps the pixels. The PDF's own text layer is never read: it can hold words a person looking at the page cannot
see, which is exactly where a hostile document would hide an instruction; the OCR reads what is drawn.

**An image** (PNG, JPEG or WebP) has its size read from its header before any pixel is decoded, and is refused
over the pixel cap. Pillow is told which format to expect, and its decompression-bomb guard is set to the same
cap. The EXIF orientation is applied, so the page stands upright, and the picture is converted to plain RGB
(a transparent one is put on white) and saved again as a JPEG, which leaves every other piece of metadata
behind: no GPS position, no camera, no embedded thumbnail ever reaches the store or the visitor.

Whatever goes wrong becomes a `DecodeError` with one of the fixed failure codes, never a message that quotes
the file.
"""

import io
import re
import warnings
import zlib
from collections.abc import Iterator
from dataclasses import dataclass

import pypdfium2 as pdfium
from PIL import Image, ImageOps

from lb03.ocr.protocol import WorkerLimits
from lb03.sniff import FileKind, sniff_kind
from lb03.states import FailureCode

# What a PDF may not name: anything that runs, or reaches outside the file. A script needs `/S /JavaScript`, so that one
# name covers it, and a bare `/JS` is not forbidden: three bytes of compressed picture data would match it by chance.
# `Encrypt` is not forbidden but unreadable.
FORBIDDEN_NAMES = frozenset(
    {
        "JavaScript",
        "Launch",
        "URI",
        "GoToR",
        "GoToE",
        "SubmitForm",
        "ImportData",
        "EmbeddedFile",
        "Filespec",
        "FFilter",
        "FDecodeParms",
        "RichMedia",
        "XFA",
    }
)
UNREADABLE_NAMES = frozenset({"Encrypt"})
# A PDF name: a slash and the characters a name is made of, which may include `#` and two hex digits.
NAME = re.compile(rb"/[A-Za-z0-9#_.+\-]{1,40}")
HEX_ESCAPE = re.compile(rb"#([0-9A-Fa-f]{2})")
# How many compressed object streams are opened, and how large one may grow.
MAX_OBJECT_STREAMS = 64
MAX_OBJECT_STREAM_BYTES = 16 * 1024 * 1024
# How far back from the word `stream` its dictionary is looked for.
DICTIONARY_REACH = 600
# The biggest page a PDF may declare, in points (the PDF format's own largest is 14,400).
MAX_PAGE_POINTS = 14_400


class DecodeError(Exception):
    """The file can't be read, and the fixed code says why; the message holds nothing from the file."""

    def __init__(self, code: FailureCode) -> None:
        """Refuse the file for `code`."""
        super().__init__(code.value)
        self.code = code


@dataclass(frozen=True)
class Document:
    """A decoded file: what it was, and its pages as plain RGB pictures no larger than the page limit."""

    kind: FileKind
    pages: list[Image.Image]


def pdf_names(chunk: bytes) -> set[str]:
    """List the names a stretch of PDF holds, with their hex escapes undone (`/J#53` is `JS`)."""
    names = set()
    for found in NAME.finditer(chunk):
        raw = HEX_ESCAPE.sub(lambda escape: bytes([int(escape.group(1), 16)]), found.group(0)[1:])
        names.add(raw.decode("latin-1"))
    return names


def streams_of(data: bytes) -> Iterator[tuple[bytes, bytes]]:
    """Yield each stream's dictionary text (the bytes just before it) and its raw content, in file order."""
    position = 0
    while True:
        start = data.find(b"stream", position)
        if start < 0:
            return
        body = start + len(b"stream")
        if data[body : body + 2] == b"\r\n":
            body += 2
        elif data[body : body + 1] == b"\n":
            body += 1
        else:
            position = body
            continue
        end = data.find(b"endstream", body)
        if end < 0:
            return
        yield data[max(0, start - DICTIONARY_REACH) : start], data[body:end]
        position = end + len(b"endstream")


def this_object(window: bytes) -> bytes:
    """Return the part of the bytes before a stream that belongs to the stream's own object: after the last `endobj`."""
    cut = window.rfind(b"endobj")
    return window if cut < 0 else window[cut + len(b"endobj") :]


def packed_names(data: bytes) -> set[str]:
    """Open the compressed object streams a PDF packs its objects into, and list the names inside them.

    Anything that says it is an object stream and can't be opened (another filter, damage, a size over the
    cap) raises `unsafe_file`: a file that hides its objects from the check is not trusted.
    """
    names: set[str] = set()
    opened = 0
    for dictionary, content in streams_of(data):
        if "ObjStm" not in pdf_names(this_object(dictionary)):
            continue
        opened += 1
        if opened > MAX_OBJECT_STREAMS:
            raise DecodeError(FailureCode.UNSAFE_FILE)
        inflater = zlib.decompressobj()
        try:
            unpacked = inflater.decompress(content, MAX_OBJECT_STREAM_BYTES)
        except zlib.error:
            raise DecodeError(FailureCode.UNSAFE_FILE) from None
        if inflater.unconsumed_tail:
            raise DecodeError(FailureCode.UNSAFE_FILE)
        names |= pdf_names(unpacked)
    return names


def check_pdf_bytes(data: bytes) -> None:
    """Refuse a PDF that names anything that runs or reaches outside it, before any PDF library opens it."""
    names = pdf_names(data) | packed_names(data)
    if names & FORBIDDEN_NAMES:
        raise DecodeError(FailureCode.UNSAFE_FILE)
    if names & UNREADABLE_NAMES:
        raise DecodeError(FailureCode.UNREADABLE_FILE)


def render_pdf(data: bytes, limits: WorkerLimits) -> list[Image.Image]:
    """Count a PDF's pages, refuse one over the limit, and draw each page no larger than the page limit."""
    check_pdf_bytes(data)
    try:
        document = pdfium.PdfDocument(data)
    except pdfium.PdfiumError:
        raise DecodeError(FailureCode.UNREADABLE_FILE) from None
    try:
        count = len(document)
        if count == 0:
            raise DecodeError(FailureCode.UNREADABLE_FILE)
        if count > limits.max_pages:
            raise DecodeError(FailureCode.TOO_MANY_PAGES)
        return [render_page(document, index, limits) for index in range(count)]
    except pdfium.PdfiumError:
        raise DecodeError(FailureCode.UNREADABLE_FILE) from None
    finally:
        document.close()


def render_page(document: pdfium.PdfDocument, index: int, limits: WorkerLimits) -> Image.Image:
    """Draw one page as RGB, scaled so its long side is the page limit, after checking its size is sane."""
    page = document[index]
    width, height = page.get_size()
    if not (0 < width <= MAX_PAGE_POINTS and 0 < height <= MAX_PAGE_POINTS):
        raise DecodeError(FailureCode.UNREADABLE_FILE)
    scale = limits.page_long_side / max(width, height)
    if round(width * scale) * round(height * scale) > limits.max_pixels:
        raise DecodeError(FailureCode.IMAGE_TOO_BIG)
    bitmap = page.render(scale=scale)
    picture: Image.Image = bitmap.to_pil().convert("RGB")
    return picture


def open_image(data: bytes, kind: FileKind, limits: WorkerLimits) -> Image.Image:
    """Open an image as the format its first bytes named, and refuse it over the pixel cap before decoding it."""
    Image.MAX_IMAGE_PIXELS = limits.max_pixels
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            image = Image.open(io.BytesIO(data), formats=[kind.name.upper()])
            width, height = image.size
            if width * height > limits.max_pixels:
                raise DecodeError(FailureCode.IMAGE_TOO_BIG)
            image.load()
    except DecodeError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise DecodeError(FailureCode.IMAGE_TOO_BIG) from None
    except Exception:  # noqa: BLE001 - a decoder may raise anything on a hostile file, and all of it means unreadable
        raise DecodeError(FailureCode.UNREADABLE_FILE) from None
    return image


def upright_rgb(image: Image.Image, limits: WorkerLimits) -> Image.Image:
    """Turn a picture upright, put it on white if it is transparent, and shrink it to the page limit."""
    turned = ImageOps.exif_transpose(image) or image
    rgba = turned.convert("RGBA")
    flat = Image.new("RGB", rgba.size, (255, 255, 255))
    flat.paste(rgba, mask=rgba.getchannel("A"))
    flat.thumbnail((limits.page_long_side, limits.page_long_side), Image.Resampling.LANCZOS)
    return flat


def decode_document(data: bytes, limits: WorkerLimits) -> Document:
    """Decode a file into its pages, or raise a DecodeError with the code that says why it can't be read."""
    if len(data) > limits.max_bytes:
        raise DecodeError(FailureCode.TOO_LARGE)
    kind = sniff_kind(data[:16])
    if kind is None:
        raise DecodeError(FailureCode.UNSUPPORTED_FILE)
    if kind.name == "pdf":
        return Document(kind, render_pdf(data, limits))
    return Document(kind, [upright_rgb(open_image(data, kind, limits), limits)])
