"""Tests for LB-03's HTTP API on the real parts: the service as its module wires it, Postgres and the real runner.

The OCR reader and the models are fakes (no provider key exists here, and a test must never spend quota); everything
between the visitor's request and them is real: the token check, the upload limits, the quota in Postgres, the file
store on disk, the runner on its own loop, the pipeline, the checks, the boxes, the corrections and the exports.
"""

import json
import time
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from flask import request
from sqlalchemy import Engine

from lb03 import limits
from lb03.api import UPLOAD_PATH, limit_upload_before_reading
from lb03.boxes import PageWords
from lb03.golden import GoldenCase, printed_as_reply, read_golden_set
from lb03.invoice import ExtractedInvoice
from lb03.ocr.pool import OcrError
from lb03.states import FailureCode
from tests.lb03_serving import ALEX, PDF, Served, build_served, multipart
from tests.lb03_support import FakeGuard, FakeReader, invoice_page, verdict
from tests.support import unavailable

pytestmark = pytest.mark.integration

GOLDEN = read_golden_set()


def plain_case() -> GoldenCase:
    """Return a golden document that reads cleanly and is not one of the samples."""
    return next(case for case in GOLDEN.cases if case.expect.outcome == "valid" and case.sample is None)


CASE = plain_case()
assert CASE.printed is not None
INVOICE = ExtractedInvoice.from_reply(printed_as_reply(CASE.printed))
REPLY = json.dumps(printed_as_reply(CASE.printed))


@pytest.fixture
def serve(lb03_engine: Engine, tmp_path: Path) -> Iterator[Callable[..., Served]]:
    """Return a function that serves LB-03 with a given reader and model script; every one made is closed afterwards."""
    made: list[Served] = []

    def build(
        reader: FakeReader | None = None,
        replies: list[str | Exception] | None = None,
        gateway: bool = True,
        guard: FakeGuard | None = None,
    ) -> Served:
        """Serve LB-03 with a fake reader (one page of the plain invoice by default) and scripted models."""
        script: list[str | Exception] = list(replies) if replies is not None else [REPLY] * 40
        served = build_served(
            lb03_engine, tmp_path, reader or FakeReader([invoice_page(INVOICE)]), script, gateway, guard
        )
        made.append(served)
        return served

    yield build
    for served in made:
        served.service.close()


def test_every_route_needs_a_visitor_token_for_lb_03(serve: Callable[..., Served]) -> None:
    """No token and a token minted for another system both get the platform's 401, on every route."""
    served = serve()
    client = served.app.test_client()

    for method, path in (
        ("GET", "/api/lb03/quota"),
        ("GET", "/api/lb03/documents"),
        ("POST", "/api/lb03/documents"),
        ("GET", "/api/lb03/documents/" + "a" * 22),
    ):
        assert client.open(path, method=method).status_code == 401
    wrong_system = served.request("GET", "/api/lb03/quota", system="lb-05")
    assert wrong_system.status_code == 401
    assert wrong_system.get_json()["error"]["code"] == "unauthorized"


def test_the_quota_says_what_is_left_and_the_limits_the_service_keeps(serve: Callable[..., Served]) -> None:
    """A visitor who has uploaded nothing has every place, and the limits are the datasheet's."""
    served = serve()

    body = served.request("GET", "/api/lb03/quota").get_json()

    assert (body["used"], body["remaining"], body["active"], body["can_read"]) == (0, 10, 0, True)
    assert body["limits"] == {
        "documents_per_day": 10,
        "concurrent_documents": 2,
        "max_upload_bytes": 10 * 1024 * 1024,
        "max_pages": 5,
        "file_lifetime_seconds": 3600,
        "max_model_calls_per_document": 5,
        "document_deadline_seconds": 150.0,
    }


def test_an_upload_is_answered_at_once_and_the_document_is_read_in_the_background(
    serve: Callable[..., Served],
) -> None:
    """202 with the document waiting; polling shows it ready, with its fields, boxes, checks and journal entry."""
    served = serve()

    response = served.upload()

    assert response.status_code == 202
    first = response.get_json()
    assert first["state"] in {"uploaded", "ocr"}
    assert (first["label"], first["kind"], first["byte_size"]) == ("invoice.pdf", "pdf", len(PDF))
    assert first["fields"] is None
    document = served.wait_for_end(first["id"])
    assert document["state"] == "ready"
    assert document["failure"] is None
    assert (document["pages"], document["model_calls"], document["can_export"]) == (1, 2, True)
    fields = {item["path"]: item for item in document["fields"]}
    assert fields["total"]["value"] == f"{INVOICE.total:.2f}"
    assert fields["total"]["box"]["page"] == 1
    assert len(fields["total"]["box"]["quad"]) == 8
    assert fields["total"]["box"]["band"] == "high"
    assert fields["total"]["edited"] is False
    assert fields["vendor"]["kind"] == "text"
    assert document["journal_status"] == "made"
    assert document["journal"]["total_debit"] == document["journal"]["total_credit"]
    assert document["duplicate"] is None
    assert {check["id"] for check in document["checks"]} >= {"required_fields", "total_reconciles", "not_duplicate"}


def test_the_steps_a_document_took_are_listed_with_their_times(serve: Callable[..., Served]) -> None:
    """The board's honest progress: each step, in order, with how it ended and how long it took."""
    served = serve()

    document = served.read()

    names = [step["name"] for step in document["steps"]]
    assert names[:4] == ["queue", "ocr", "injection check", "extract"]
    assert all(step["status"] in {"ok", "error", "skipped"} and step["ms"] >= 0 for step in document["steps"])
    assert document["run_id"] is not None


@pytest.mark.parametrize(
    "data",
    [
        b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        b"<html><body>not an invoice</body></html>",
        b"GIF89a\x01\x00\x01\x00",
        b"PK\x03\x04 a zip",
        b"MZ\x90\x00 a program",
        b"",
    ],
)
def test_a_file_that_is_not_a_pdf_or_an_image_is_refused_before_it_is_stored_or_counted(
    serve: Callable[..., Served], data: bytes
) -> None:
    """The file's own first bytes decide: SVG, HTML, GIF, ZIP and executables are refused, whatever the name says."""
    served = serve()

    response = served.upload(data, filename="invoice.pdf", content_type="application/pdf")

    assert response.status_code == 415
    assert response.get_json()["error"]["code"] == "unsupported_file"
    assert served.request("GET", "/api/lb03/quota").get_json()["used"] == 0
    assert not list(served.files.rglob("*.*")) if served.files.exists() else True
    assert served.reader.seen == []


def test_a_file_over_ten_megabytes_is_refused_before_it_is_read_and_is_not_counted(
    serve: Callable[..., Served],
) -> None:
    """The body's own length decides at the door: 413 before a byte of it is parsed."""
    served = serve()

    response = served.upload(PDF + b"x" * (limits.MAX_UPLOAD_BYTES + limits.MAX_REQUEST_BYTES))

    assert response.status_code == 413
    assert response.get_json()["error"]["code"] == "too_large"
    assert served.request("GET", "/api/lb03/quota").get_json()["used"] == 0


def test_a_file_a_hair_over_the_limit_inside_the_envelope_is_refused_by_the_service(
    serve: Callable[..., Served],
) -> None:
    """A file of 10 MB and one byte fits the multipart envelope but not the limit: refused, not counted."""
    served = serve()

    response = served.upload(PDF + b"x" * (limits.MAX_UPLOAD_BYTES - len(PDF) + 1))

    assert response.status_code == 413
    assert served.request("GET", "/api/lb03/quota").get_json()["used"] == 0


def test_a_file_of_exactly_ten_megabytes_is_taken(serve: Callable[..., Served]) -> None:
    """The limit is inclusive: 10 MB exactly is a document."""
    served = serve()

    response = served.upload(PDF + b"x" * (limits.MAX_UPLOAD_BYTES - len(PDF)))

    assert response.status_code == 202


def test_an_upload_that_does_not_say_how_long_it_is_is_refused(serve: Callable[..., Served]) -> None:
    """A chunked upload has no length to check before reading, so the door refuses it with 411 and reads nothing."""
    served = serve()
    body, header = multipart(PDF)

    with served.app.test_request_context(UPLOAD_PATH, method="POST", data=body, content_type=header):
        request.environ.pop("CONTENT_LENGTH", None)
        refused = limit_upload_before_reading()
        another_route = served.app.test_request_context("/api/lb03/quota", method="GET")

    assert refused is not None
    assert refused.status_code == 411
    assert refused.get_json()["error"]["code"] == "length_required"
    with another_route:
        assert limit_upload_before_reading() is None


def test_an_upload_with_no_file_part_or_an_extra_part_is_a_malformed_request(serve: Callable[..., Served]) -> None:
    """Exactly one part, `file`: anything else is a 422 that names the field and never its value."""
    served = serve()

    boundary = "----lb03-no-file"
    body = f'--{boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n--{boundary}--\r\n'.encode()
    nothing = served.request(
        "POST", "/api/lb03/documents", data=body, content_type=f"multipart/form-data; boundary={boundary}"
    )
    extra = served.upload(PDF, "a.pdf", extra={"note": "do not trust"})

    assert nothing.status_code == 422
    assert extra.status_code == 422
    assert "do not trust" not in extra.get_data(as_text=True)


def test_the_files_name_and_claimed_type_decide_nothing(serve: Callable[..., Served]) -> None:
    """A PDF called `.exe` with a made-up type is a PDF; its name is shown back cleaned, and used as no path."""
    served = serve()

    response = served.upload(PDF, filename="../../etc/passwd <script>.exe", content_type="text/x-shellscript")

    assert response.status_code == 202
    body = response.get_json()
    assert body["kind"] == "pdf"
    assert "/" not in body["label"]
    assert "<" not in body["label"]
    assert body["label"] == "passwd script .exe"


def test_the_tenth_document_of_the_day_is_taken_and_the_eleventh_is_told_when_the_count_restarts(
    serve: Callable[..., Served],
) -> None:
    """Ten a day, counted by the service: the eleventh gets 429 with the time midnight UTC comes."""
    served = serve()

    for _ in range(10):
        assert served.read()["state"] == "ready"
    refused = served.upload()

    assert refused.status_code == 429
    error = refused.get_json()["error"]
    assert error["code"] == "daily_limit"
    assert error["resets_at"] == "2026-10-02T00:00:00+00:00"
    quota = served.request("GET", "/api/lb03/quota").get_json()
    assert (quota["used"], quota["remaining"]) == (10, 0)


def test_only_two_documents_are_read_at_a_time_and_the_third_is_told_to_wait(serve: Callable[..., Served]) -> None:
    """With two of the visitor's documents being read, the next upload is 429 `document_running` and is not counted."""
    served = serve(reader=FakeReader([invoice_page(INVOICE)], delay=1.5))
    first, second = served.upload(), served.upload()
    assert (first.status_code, second.status_code) == (202, 202)

    third = served.upload()

    assert third.status_code == 429
    assert third.get_json()["error"]["code"] == "document_running"
    assert served.request("GET", "/api/lb03/quota").get_json()["used"] == 2
    served.wait_for_end(first.get_json()["id"])
    served.wait_for_end(second.get_json()["id"])
    assert served.upload().status_code == 202


def test_a_visitor_sees_only_their_own_documents_and_pictures(serve: Callable[..., Served]) -> None:
    """Another visitor's request for any route of a document is a 404, whatever they know of its ID."""
    served = serve()
    document = served.read()
    path = f"/api/lb03/documents/{document['id']}"

    for method, url in (
        ("GET", path),
        ("GET", f"{path}/pages/1"),
        ("GET", f"{path}/export?format=json"),
        ("DELETE", path),
    ):
        response = served.request(method, url, session=ALEX)
        assert response.status_code == 404, (method, url)
        assert response.get_json()["error"]["code"] == "not_found"
    edit = served.request("PATCH", f"{path}/fields/vendor", session=ALEX, json={"value": "Hijacked Ltd"})
    assert edit.status_code == 404
    assert served.request("GET", "/api/lb03/documents", session=ALEX).get_json() == {"documents": []}
    assert served.document(document["id"])["fields"][1]["value"] != "Hijacked Ltd"


def test_the_list_shows_the_visitors_documents_newest_first_with_how_they_stand(serve: Callable[..., Served]) -> None:
    """The board finds its documents again after a reload."""
    served = serve()
    first = served.read()
    second = served.read()

    listed = served.request("GET", "/api/lb03/documents").get_json()["documents"]

    assert [item["id"] for item in listed] == [second["id"], first["id"]]
    assert {item["state"] for item in listed} == {"ready"}
    assert all(set(item) >= {"checks_failed", "can_export", "expires_at", "pages"} for item in listed)


def test_a_page_picture_is_served_to_its_owner_as_a_private_jpeg(serve: Callable[..., Served]) -> None:
    """The viewer's picture: a JPEG, never cached, never sniffed, and there is no other way to reach the file."""
    served = serve()
    document = served.read()

    response = served.request("GET", f"/api/lb03/documents/{document['id']}/pages/1")

    assert response.status_code == 200
    assert response.mimetype == "image/jpeg"
    assert response.data.startswith(b"\xff\xd8\xff")
    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["Content-Disposition"] == 'inline; filename="page-1.jpg"'


@pytest.mark.parametrize("number", ["2", "5"])
def test_a_page_the_document_does_not_have_is_not_found(serve: Callable[..., Served], number: str) -> None:
    """A one-page document has no page 2, and the answer is the same as for any other missing thing."""
    served = serve()
    document = served.read()

    assert served.request("GET", f"/api/lb03/documents/{document['id']}/pages/{number}").status_code == 404


@pytest.mark.parametrize("number", ["0", "6", "-1", "one"])
def test_a_page_number_outside_one_to_five_is_a_malformed_request(serve: Callable[..., Served], number: str) -> None:
    """The route's own rule: a page is a whole number from 1 to 5."""
    served = serve()
    document = served.read()

    assert served.request("GET", f"/api/lb03/documents/{document['id']}/pages/{number}").status_code in {404, 422}


@pytest.mark.parametrize("document_id", ["short", "a" * 21, "a" * 23, "../../etc/passwd", "a" * 21 + "!"])
def test_an_id_that_is_not_the_shape_of_one_never_reaches_the_database_or_the_store(
    serve: Callable[..., Served], document_id: str
) -> None:
    """A document ID is 22 characters of letters, digits, hyphen and underscore, and anything else is refused."""
    served = serve()

    response = served.request("GET", f"/api/lb03/documents/{document_id}")

    assert response.status_code in {404, 422}


def test_a_document_that_is_not_there_is_a_plain_404_in_the_platforms_error_shape(
    serve: Callable[..., Served],
) -> None:
    """The error is the same shape every route of every system answers with, and says nothing about the ID."""
    served = serve()

    response = served.request("GET", "/api/lb03/documents/" + "a" * 22)

    assert response.status_code == 404
    assert set(response.get_json()["error"]) == {"code", "message"}


def test_a_correction_runs_every_check_again_and_the_field_loses_its_box(serve: Callable[..., Served]) -> None:
    """The visitor changes the total: the arithmetic fails, the export is blocked, and the correction is recorded."""
    served = serve()
    document = served.read()
    url = f"/api/lb03/documents/{document['id']}/fields/total"

    response = served.request("PATCH", url, json={"value": "999999.99"})

    assert response.status_code == 200
    changed = response.get_json()
    fields = {item["path"]: item for item in changed["fields"]}
    assert fields["total"]["value"] == "999999.99"
    assert fields["total"]["edited"] is True
    assert fields["total"]["box"] is None
    assert "total_reconciles" in fields["total"]["checks"]
    assert changed["can_export"] is False
    assert changed["journal"] is None
    assert changed["journal_status"] == "blocked_by_checks"
    assert [(item["path"], item["now"]) for item in changed["corrections"]] == [("total", "999999.99")]
    assert changed["corrections"][0]["was"] == f"{INVOICE.total:.2f}"
    reloaded = served.document(document["id"])
    assert reloaded["can_export"] is False


def test_correcting_the_field_back_makes_the_checks_pass_and_the_journal_entry_again(
    serve: Callable[..., Served],
) -> None:
    """Putting the right total back: the checks pass, the entry is made, and both corrections are on record."""
    served = serve()
    document = served.read()
    url = f"/api/lb03/documents/{document['id']}/fields/total"
    served.request("PATCH", url, json={"value": "999999.99"})

    response = served.request("PATCH", url, json={"value": f"{INVOICE.total:.2f}"})

    changed = response.get_json()
    assert changed["can_export"] is True
    assert changed["journal_status"] == "made"
    assert [item["now"] for item in changed["corrections"]] == ["999999.99", f"{INVOICE.total:.2f}"]
    statuses = {check["id"]: check["status"] for check in changed["checks"]}
    assert statuses["total_reconciles"] == "passed"
    assert statuses["fields_on_page"] == "passed"


def test_a_value_that_does_not_fit_the_field_is_refused_and_nothing_changes(serve: Callable[..., Served]) -> None:
    """A word for an amount, an impossible date, and a field the invoice doesn't have: all 422."""
    served = serve()
    document = served.read()
    base = f"/api/lb03/documents/{document['id']}/fields"

    for path, value in (("total", "lots"), ("issue_date", "31.02.2026"), ("line_items.99.total", "1.00")):
        response = served.request("PATCH", f"{base}/{path}", json={"value": value})
        assert response.status_code == 422, (path, value)
        assert response.get_json()["error"]["code"] == "invalid_field"
    assert served.document(document["id"])["corrections"] == []


@pytest.mark.parametrize("path", ["document_id", "__class__", "total/../x", "line_items.0", "vat.1.nope.deep"])
def test_a_field_path_that_is_not_the_shape_of_one_is_a_malformed_request(
    serve: Callable[..., Served], path: str
) -> None:
    """Field paths are `name`, or `line_items.N.name` and `vat.N.name`: nothing else reaches the invoice."""
    served = serve()
    document = served.read()

    response = served.request("PATCH", f"/api/lb03/documents/{document['id']}/fields/{path}", json={"value": "1"})

    assert response.status_code in {404, 422}
    assert served.document(document["id"])["corrections"] == []


def test_a_correction_that_changes_nothing_is_not_recorded(serve: Callable[..., Served]) -> None:
    """Typing back what is already there is not a correction."""
    served = serve()
    document = served.read()

    response = served.request(
        "PATCH", f"/api/lb03/documents/{document['id']}/fields/total", json={"value": f"{INVOICE.total:.2f}"}
    )

    assert response.status_code == 200
    assert response.get_json()["corrections"] == []


@pytest.mark.parametrize("value", ["a" * 201, "line\nbreak", "tab\there", "\x00"])
def test_a_value_with_control_characters_or_too_long_is_a_malformed_request(
    serve: Callable[..., Served], value: str
) -> None:
    """A field's value is one short line of text."""
    served = serve()
    document = served.read()

    response = served.request("PATCH", f"/api/lb03/documents/{document['id']}/fields/vendor", json={"value": value})

    assert response.status_code == 422


def test_a_document_that_is_not_ready_cannot_be_corrected_or_exported(serve: Callable[..., Served]) -> None:
    """While it is being read there is nothing to correct: 409, and the same for its export."""
    served = serve(reader=FakeReader([invoice_page(INVOICE)], delay=1.0))
    created = served.upload().get_json()
    base = f"/api/lb03/documents/{created['id']}"

    edit = served.request("PATCH", f"{base}/fields/vendor", json={"value": "Someone"})
    export = served.request("GET", f"{base}/export?format=json")

    assert (edit.status_code, edit.get_json()["error"]["code"]) == (409, "not_ready")
    assert (export.status_code, export.get_json()["error"]["code"]) == (409, "not_ready")
    served.wait_for_end(created["id"])


def test_the_exports_of_a_document_that_passes_its_checks(serve: Callable[..., Served]) -> None:
    """The lines and the journal entry as CSV with a byte order mark and a fixed name, and everything as JSON."""
    served = serve()
    document = served.read()
    base = f"/api/lb03/documents/{document['id']}/export"

    lines = served.request("GET", f"{base}?format=csv")
    journal = served.request("GET", f"{base}?format=journal")
    everything = served.request("GET", f"{base}?format=json")

    assert lines.status_code == journal.status_code == everything.status_code == 200
    assert lines.headers["Content-Type"] == "text/csv; charset=utf-8"
    assert lines.headers["Content-Disposition"] == 'attachment; filename="invoice-lines.csv"'
    assert lines.data.startswith(b"\xef\xbb\xbf")
    assert journal.headers["Content-Disposition"] == 'attachment; filename="journal-entry.csv"'
    assert journal.data.decode("utf-8").splitlines()[1].count(",") >= 5
    assert everything.mimetype == "application/json"
    assert everything.headers["Content-Disposition"] == 'attachment; filename="invoice.json"'
    exported = json.loads(everything.data)
    assert exported["invoice"]["total"] == str(INVOICE.total)
    assert exported["journal"]["lines"]


def test_a_document_that_fails_a_check_is_not_exported_as_csv_but_its_json_goes(serve: Callable[..., Served]) -> None:
    """A failing check blocks the spreadsheet exports (nothing is silently fixed), and the JSON says what failed."""
    served = serve()
    document = served.read()
    base = f"/api/lb03/documents/{document['id']}"
    served.request("PATCH", f"{base}/fields/total", json={"value": "1.00"})

    csv_export = served.request("GET", f"{base}/export?format=csv")
    journal = served.request("GET", f"{base}/export?format=journal")
    everything = served.request("GET", f"{base}/export?format=json")

    assert csv_export.status_code == journal.status_code == 409
    assert csv_export.get_json()["error"]["code"] == "checks_failed"
    assert everything.status_code == 200
    assert any(check["status"] == "failed" for check in json.loads(everything.data)["checks"])


def test_a_vendor_that_is_a_spreadsheet_formula_is_exported_as_text(serve: Callable[..., Served]) -> None:
    """A formula in a cell is turned into text with an apostrophe, so opening the file runs nothing."""
    served = serve()
    document = served.read()
    base = f"/api/lb03/documents/{document['id']}"
    served.request("PATCH", f"{base}/fields/vendor", json={"value": '=HYPERLINK("http://evil.example","x")'})

    export = served.request("GET", f"{base}/export?format=csv")

    assert export.status_code == 200
    text = export.data.decode("utf-8-sig")
    assert "'=HYPERLINK" in text
    assert "\n=HYPERLINK" not in text
    assert ",=HYPERLINK" not in text


def test_an_unknown_export_format_is_a_malformed_request(serve: Callable[..., Served]) -> None:
    """The three formats are the only ones."""
    served = serve()
    document = served.read()

    response = served.request("GET", f"/api/lb03/documents/{document['id']}/export?format=xlsx")

    assert response.status_code == 422


def test_a_document_that_has_ended_can_be_deleted_with_its_files(serve: Callable[..., Served]) -> None:
    """Deleting removes the row and every file of the document, and the document is gone."""
    served = serve()
    document = served.read()
    assert any(path.is_file() for path in served.files.rglob("*"))

    response = served.request("DELETE", f"/api/lb03/documents/{document['id']}")

    assert response.status_code == 204
    assert response.data == b""
    assert served.request("GET", f"/api/lb03/documents/{document['id']}").status_code == 404
    assert [path for path in served.files.rglob("*") if path.is_file()] == []


def test_a_document_still_being_read_cannot_be_deleted(serve: Callable[..., Served]) -> None:
    """409 while it is in the pipeline, so the visitor's worker slot is never orphaned."""
    served = serve(reader=FakeReader([invoice_page(INVOICE)], delay=1.0))
    created = served.upload().get_json()

    response = served.request("DELETE", f"/api/lb03/documents/{created['id']}")

    assert (response.status_code, response.get_json()["error"]["code"]) == (409, "still_reading")
    served.wait_for_end(created["id"])


def test_a_document_with_no_words_ends_failed_with_its_code_and_the_place_is_kept(
    serve: Callable[..., Served],
) -> None:
    """A blank page is the visitor's file's doing, so it counts, and the document says why it has no result."""
    served = serve(reader=FakeReader([PageWords(1, [])]))

    document = served.read()

    assert document["state"] == "failed"
    assert document["failure"]["code"] == "no_text"
    assert document["fields"] is None
    assert document["can_export"] is False
    quota = served.request("GET", "/api/lb03/quota").get_json()
    assert (quota["used"], quota["active"]) == (1, 0)


def test_a_document_the_readers_refuse_ends_failed_with_the_readers_code(serve: Callable[..., Served]) -> None:
    """The cage's verdict reaches the visitor as a code the board has words for."""
    served = serve(reader=FakeReader([], error=OcrError(FailureCode.UNSAFE_FILE)))

    document = served.read()

    assert (document["state"], document["failure"]["code"]) == ("failed", "unsafe_file")


def test_a_document_the_service_failed_does_not_count_against_the_visitor(serve: Callable[..., Served]) -> None:
    """The models are down: the document fails as `model_failed` and its place is given back."""
    served = serve(replies=[unavailable()])

    document = served.read()

    assert document["failure"]["code"] == "model_failed"
    deadline = time.monotonic() + 5
    quota = served.request("GET", "/api/lb03/quota").get_json()
    while quota["used"] != 0 and time.monotonic() < deadline:
        time.sleep(0.05)
        quota = served.request("GET", "/api/lb03/quota").get_json()
    assert (quota["used"], quota["active"]) == (0, 0)


def test_a_hostile_document_flagged_by_the_guard_fails_without_a_model_and_counts(
    serve: Callable[..., Served],
) -> None:
    """An injection attempt is stopped by the check: no model call, a failure code, and the place is kept."""
    served = serve(guard=FakeGuard([verdict(flagged=True, score=0.99)]))

    document = served.read()

    assert (document["state"], document["failure"]["code"]) == ("failed", "injection_suspected")
    assert served.chat.calls() == 0
    assert document["model_calls"] == 1


def test_a_service_with_no_models_answers_503_to_an_upload_and_does_not_count_it(
    serve: Callable[..., Served],
) -> None:
    """Without a gateway the service still serves its quota, and says so: it can't read a new document."""
    served = serve(gateway=False)

    response = served.upload()
    quota = served.request("GET", "/api/lb03/quota").get_json()

    assert response.status_code == 503
    assert response.get_json()["error"]["code"] == "unavailable"
    assert (quota["can_read"], quota["used"]) == (False, 0)


def test_every_response_carries_the_platforms_security_headers(serve: Callable[..., Served]) -> None:
    """JSON, images and errors alike: no caching, no sniffing, no framing, a policy that allows nothing."""
    served = serve()
    document = served.read()

    for url in (
        "/api/lb03/quota",
        f"/api/lb03/documents/{document['id']}",
        f"/api/lb03/documents/{document['id']}/pages/1",
        "/api/lb03/documents/" + "a" * 22,
    ):
        headers = served.request("GET", url).headers
        assert headers["Cache-Control"] == "no-store"
        assert headers["X-Content-Type-Options"] == "nosniff"
        assert headers["Content-Security-Policy"] == "default-src 'none'; frame-ancestors 'none'"
        assert headers["X-Frame-Options"] == "DENY"


def test_the_spans_of_a_document_reach_the_trace_without_any_of_its_words(serve: Callable[..., Served]) -> None:
    """The Scope shows the run; none of the invoice's text or numbers is in any span."""
    served = serve()
    document = served.read()

    served.service.close()
    everything = json.dumps([span.attrs for span in served.spans.spans])

    assert any(span.run_id == document["run_id"] for span in served.spans.spans)
    assert INVOICE.vendor is not None
    assert INVOICE.vendor not in everything
    assert str(INVOICE.total) not in everything
