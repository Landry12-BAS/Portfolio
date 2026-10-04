"""LB-03 end to end with the real OCR: a file goes in by the HTTP API, a caged worker reads it, a fake model replies.

Everything the other API tests fake about reading is real here: the upload limits, the quota, the file store, the
runner, the caged OCR worker (rlimits, seccomp, Landlock), the page pictures, the words and their boxes, the box rule,
the checks, the exports. Only the models and the injection check are fakes, because a test must never spend quota: the
model answers from the golden set's printed truth, and the check reads what the OCR found, as the gateway's does.

Each document takes a few seconds in the real worker, so these are marked `ocr`.
"""

import io
import json
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from PIL import Image
from sqlalchemy import Engine

from core.structured import ChatMessage
from lb03 import limits
from lb03.golden import SEED_DIRECTORY, GoldenCase, printed_as_reply, read_golden_set
from lb03.golden_eval import compare_fields
from lb03.invoice import ExtractedInvoice
from lb_common.gateway import GuardVerdict
from tests.lb03_serving import Served, build_served
from tests.lb03_support import FakeGuard, verdict

pytestmark = [pytest.mark.integration, pytest.mark.ocr]

GOLDEN = read_golden_set()


class ReadingGuard:
    """A fake injection check that reads the text it is given and flags the phrase the hostile documents print."""

    def __init__(self) -> None:
        """Start with nothing seen."""
        self.texts: list[str] = []

    def check(self, text: str) -> GuardVerdict:
        """Flag a text that tells the reader to ignore its instructions, as the classifier would."""
        self.texts.append(text)
        flagged = "ignore the above" in text.lower() or "administrator mode" in text.lower()
        return verdict(flagged=flagged, score=0.99 if flagged else 0.01)


def file_of(case: GoldenCase) -> bytes:
    """Read a golden document's file as the seed directory holds it."""
    return (SEED_DIRECTORY / case.file).read_bytes()


def reply_of(case: GoldenCase) -> str:
    """Write the JSON a perfect model answers with for a golden document."""
    assert case.printed is not None
    return json.dumps(printed_as_reply(case.printed))


def plain_pdf_case() -> GoldenCase:
    """Return a clean PDF of the golden set that is neither a sample nor a copy."""
    return next(
        case
        for case in GOLDEN.cases
        if case.expect.outcome == "valid"
        and case.sample is None
        and case.render.medium == "pdf"
        and case.render.pages == 1
        and case.expect.duplicate_of is None
    )


@pytest.fixture
def real_serve(lb03_engine: Engine, tmp_path: Path) -> Iterator[Callable[..., Served]]:
    """Return a function that serves LB-03 with the real OCR worker and scripted models; all are closed afterwards."""
    made: list[Served] = []

    def build(replies: list[str | Exception], guard: FakeGuard | ReadingGuard | None = None) -> Served:
        """Serve LB-03 with the service's own OCR pool, the given model script and injection check."""
        served = build_served(lb03_engine, tmp_path, None, replies, True, guard)  # type: ignore[arg-type]
        made.append(served)
        return served

    yield build
    for served in made:
        served.service.close()


def export_invoice(served: Served, document_id: str) -> ExtractedInvoice:
    """Read a document's reading back through the JSON export."""
    response = served.request("GET", f"/api/lb03/documents/{document_id}/export?format=json")
    assert response.status_code == 200, response.get_data(as_text=True)
    return ExtractedInvoice.model_validate(json.loads(response.data)["invoice"])


def test_a_real_pdf_is_read_in_the_cage_with_its_words_boxes_and_page_picture(
    real_serve: Callable[..., Served],
) -> None:
    """The whole chain on a real invoice: caged OCR, the boxes, the page picture, the checks and the journal entry."""
    case = plain_pdf_case()
    served = real_serve([reply_of(case)])

    document = served.read(data=file_of(case), filename="invoice.pdf")

    assert document["state"] == "ready", document["failure"]
    assert case.printed is not None
    assert compare_fields(case.printed, export_invoice(served, document["id"])).wrong == []
    # A PDF is read as text: no picture goes to the model, so the text alias answers and the vision alias is kept for
    # photographs. (The real worker once drew a picture for every file, so every PDF went to the vision model.)
    alias, messages = served.chat.requests[0]
    assert alias == "lb-fast"
    assert isinstance(messages[1], ChatMessage)
    assert messages[1].images == ()
    extract = next(step for step in document["steps"] if step["name"] == "extract")
    assert extract["detail"]["picture"] is False
    ocr = next(step for step in document["steps"] if step["name"] == "ocr")
    assert ocr["detail"]["seccomp"] is True
    assert ocr["detail"]["landlock_abi"] >= 1
    assert ocr["detail"]["words"] > 20
    boxes = [field for field in document["fields"] if field["value"] and field["box"] is not None]
    values = [field for field in document["fields"] if field["value"] and field["path"] != "document_type"]
    assert len(boxes) >= 0.8 * len(values), f"{len(boxes)} of {len(values)} fields were found on the page"
    for field in boxes:
        quad = field["box"]["quad"]
        assert len(quad) == 8
        assert all(-0.1 <= coordinate <= 1.1 for coordinate in quad)
        assert 0.0 < field["box"]["confidence"] <= 1.0
    picture = served.request("GET", f"/api/lb03/documents/{document['id']}/pages/1")
    assert picture.status_code == 200
    with Image.open(io.BytesIO(picture.data)) as image:
        assert image.format == "JPEG"
        assert max(image.size) <= limits.PAGE_LONG_SIDE_PIXELS
    assert document["can_export"] is True
    assert served.request("GET", f"/api/lb03/documents/{document['id']}/export?format=journal").status_code == 200


def test_the_text_the_guard_sees_is_what_the_reader_found_on_a_hostile_pdf(real_serve: Callable[..., Served]) -> None:
    """The notice printed at the foot of the page is read by OCR, reaches the check, and stops the document."""
    case = GOLDEN.case("hostile-total-zero")
    guard = ReadingGuard()
    served = real_serve([reply_of(case)], guard)

    document = served.read(data=file_of(case), filename="invoice.pdf")

    assert (document["state"], document["failure"]["code"]) == ("failed", "injection_suspected")
    assert any("ignore the above" in text.lower() for text in guard.texts)
    assert served.chat.calls() == 0
    # The page was read and drawn before the check, so the visitor can still see the page the text was on.
    assert document["pages"] == 1
    assert served.request("GET", f"/api/lb03/documents/{document['id']}/pages/1").status_code == 200


def test_a_blind_check_and_a_gullible_model_still_cannot_get_a_zero_total_through(
    real_serve: Callable[..., Served],
) -> None:
    """With the injection check missing the attack and the model obeying it, the arithmetic holds the document.

    The page check can't help here, and the test says so: the hostile notice itself prints `0.00`, so the zero is
    found on the page (inside the notice). The arithmetic is the defence that does not depend on what the page says.
    """
    case = GOLDEN.case("hostile-total-zero")
    assert case.printed is not None
    obeyed = {**printed_as_reply(case.printed), "total": "0.00"}
    served = real_serve([json.dumps(obeyed)] * 2, FakeGuard())

    document = served.read(data=file_of(case), filename="invoice.pdf")

    assert document["state"] == "ready"
    checks = {check["id"]: check for check in document["checks"]}
    assert checks["total_reconciles"]["status"] == "failed"
    assert checks["total_reconciles"]["severity"] == "error"
    assert "total" in checks["total_reconciles"]["fields"]
    assert document["can_export"] is False
    assert document["journal"] is None
    assert document["journal_status"] == "blocked_by_checks"


def test_a_pdf_that_runs_a_script_is_refused_by_the_cage_and_no_model_is_asked(
    real_serve: Callable[..., Served],
) -> None:
    """A PDF with an open action that runs JavaScript never gets as far as a decoder."""
    hostile = (
        b"%PDF-1.7\n"
        b"1 0 obj << /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj\n"
        b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n"
        b"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >> endobj\n"
        b"trailer << /Root 1 0 R >>\n"
    )
    served = real_serve(["{}"])

    document = served.read(data=hostile, filename="invoice.pdf")

    assert (document["state"], document["failure"]["code"]) == ("failed", "unsafe_file")
    assert served.chat.calls() == 0
    # A file the cage refused was never drawn, so there is no page to show.
    assert document["pages"] is None
    assert served.request("GET", f"/api/lb03/documents/{document['id']}/pages/1").status_code == 404


def test_a_pdf_of_six_pages_is_refused_before_any_page_is_read(real_serve: Callable[..., Served]) -> None:
    """The page limit is the worker's to enforce, because counting pages means parsing the file."""
    case = GOLDEN.case("six-pages-bohemia-2026-0888")
    served = real_serve(["{}"])

    document = served.read(data=file_of(case), filename="invoice.pdf")

    assert (document["state"], document["failure"]["code"]) == ("failed", "too_many_pages")
    assert served.chat.calls() == 0


def test_a_photo_goes_to_the_vision_model_with_its_picture_and_its_fields_get_boxes(
    real_serve: Callable[..., Served],
) -> None:
    """A phone photo: OCR text and the downscaled picture go to lb-vision, and the words still give boxes."""
    case = next(item for item in GOLDEN.cases if item.sample == "crumpled-photo")
    served = real_serve([reply_of(case)])

    document = served.read(data=file_of(case), filename="photo.jpg")

    assert document["state"] == "ready", document["failure"]
    alias, messages = served.chat.requests[0]
    assert alias == "lb-vision"
    assert isinstance(messages[1], ChatMessage)
    assert len(messages[1].images) == 1
    assert messages[1].images[0].startswith("data:image/jpeg;base64,")
    assert any(field["box"] is not None for field in document["fields"])
    extract = next(step for step in document["steps"] if step["name"] == "extract")
    assert extract["detail"]["picture"] is True
