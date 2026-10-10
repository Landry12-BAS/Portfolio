"""LB-03's file sniffing: the four kinds it reads, found by their first bytes and nothing else."""

import pytest

from lb03.sniff import JPEG, PDF, PNG, WEBP, sniff_kind

PNG_HEAD = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8
JPEG_HEAD = b"\xff\xd8\xff\xe0" + b"\x00" * 12
WEBP_HEAD = b"RIFF\x24\x00\x00\x00WEBPVP8 "
PDF_HEAD = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"


@pytest.mark.parametrize(
    ("head", "kind"),
    [(PDF_HEAD, PDF), (PNG_HEAD, PNG), (JPEG_HEAD, JPEG), (WEBP_HEAD, WEBP)],
)
def test_the_four_kinds_are_named_by_their_signature(head: bytes, kind: object) -> None:
    """A PDF, a PNG, a JPEG and a WebP are each recognised from the first bytes."""
    assert sniff_kind(head) is kind


@pytest.mark.parametrize(
    "head",
    [
        b"",
        b"%PD",
        b"GIF89a" + b"\x00" * 10,
        b"PK\x03\x04" + b"\x00" * 12,
        b"<svg xmlns='http://www.w3.org/2000/svg'></svg>",
        b"<!doctype html><html></html>",
        b"RIFF\x24\x00\x00\x00WAVEfmt ",
        b"MZ\x90\x00" + b"\x00" * 12,
        b"\x00\x00\x00\x18ftypmp42",
    ],
)
def test_everything_else_is_refused(head: bytes) -> None:
    """Anything that is not one of the four, including SVG and HTML, which can carry script, is None."""
    assert sniff_kind(head) is None


def test_a_signature_in_the_middle_of_a_file_does_not_count() -> None:
    """The check is the first bytes, so a PDF header hidden after other bytes is not a PDF."""
    assert sniff_kind(b"junk" + PDF_HEAD) is None


def test_the_kinds_have_the_media_types_and_extensions_the_files_are_stored_with() -> None:
    """The name, media type and extension of each kind agree with each other."""
    assert [(kind.name, kind.mime, kind.extension) for kind in (PDF, PNG, JPEG, WEBP)] == [
        ("pdf", "application/pdf", "pdf"),
        ("png", "image/png", "png"),
        ("jpeg", "image/jpeg", "jpg"),
        ("webp", "image/webp", "webp"),
    ]
