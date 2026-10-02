"""What a file is, from its first bytes: the one look the web process takes at an upload before OCR decodes it.

Only four kinds are read: PDF, PNG, JPEG and WebP. The test is the format's own signature at byte zero,
never the file's name or the type the browser claims, both of which the visitor chooses. A file that is
anything else (SVG, which can carry script and external references; a GIF; a ZIP; an HTML page) is refused
before it is stored. The OCR worker looks again at what it decodes, so a file that passes this and is not
what it says is refused there, in a process that can do no harm.

This module imports only the standard library, because the OCR worker imports it too and must not load any
of the web service's code.
"""

from dataclasses import dataclass
from typing import Literal

# How many bytes of a file the signature check needs.
HEAD_BYTES = 16
type KindName = Literal["pdf", "png", "jpeg", "webp"]


@dataclass(frozen=True)
class FileKind:
    """A file type the reader accepts: its short name, its media type, and the extension of the files made of it."""

    name: KindName
    mime: str
    extension: str


PDF = FileKind("pdf", "application/pdf", "pdf")
PNG = FileKind("png", "image/png", "png")
JPEG = FileKind("jpeg", "image/jpeg", "jpg")
WEBP = FileKind("webp", "image/webp", "webp")


def sniff_kind(head: bytes) -> FileKind | None:
    """Name the kind of a file from its first bytes, or return None when it is none of the four."""
    if head.startswith(b"%PDF-"):
        return PDF
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return PNG
    if head.startswith(b"\xff\xd8\xff"):
        return JPEG
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return WEBP
    return None
