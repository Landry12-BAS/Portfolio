"""LB-03's HTTP API, under /api/lb03: upload a document, watch it being read, correct it, export it, delete it.

Every route needs a visitor token minted for `lb-03` (core/visitors.py): visitors have no accounts, and the only thing
known about one is the hash of their session. A document is one of the visitor's own or it is not found; there is no
public address for a file, and a page picture is served only by the route here, to the visitor who uploaded it.

An upload is answered `202` at once with the document in state `uploaded`, and the board polls the document until it
is `ready` or `failed`. A document that is `ready` may still carry failing checks: that is a finding, not an error, and
it is in the document's `checks`. A document that is `failed` says why in a code. Only a request the service can't take
at all (no token, no place left today, an unsupported or too large file, a malformed body, the service not ready) is an
HTTP error.

The upload is a multipart body of one file part. Its size is limited before any of it is read (the request must say how
long it is, and no longer than ten megabytes and a few headers), the file's first bytes decide what it is and never its
name or the type the browser claims, and nothing here decodes it: that is the OCR worker's job, in a cage.
"""

import logging
from typing import Annotated, Any, Literal

from flask import Response, request
from flask_openapi3.models.file import FileStorage
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from core.app import COMMON_RESPONSES
from core.errors import ErrorOut, error_response
from core.openapi import APIBlueprint, Tag
from core.visitors import require_visitor, visitor_of_request
from lb03 import limits
from lb03.invoice import FIELD_PATH
from lb03.presenter import (
    DocumentListOut,
    DocumentOut,
    QuotaOut,
    document_out,
    limits_out,
    summary_out,
)
from lb03.service import NOT_SERVING_MESSAGE, TOO_LARGE_MESSAGE, Download, ExportFormat, Lb03Service, Refusal

logger = logging.getLogger(__name__)

SYSTEM_KEY = "lb-03"
UPLOAD_PATH = "/api/lb03/documents"
# The biggest value a visitor may type into a field: the longest field (a description) with room to spare.
MAX_FIELD_VALUE_CHARS = 200
# How many parts the upload may have: the file, and room for one stray field, which the form model then refuses.
MAX_FORM_PARTS = 3

type DocumentId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{22}$")]
type FieldPathText = Annotated[str, StringConstraints(pattern=FIELD_PATH.pattern)]

BINARY = {"type": "string", "format": "binary"}
PAGE_RESPONSE = {"description": "The JPEG picture of one page.", "content": {"image/jpeg": {"schema": BINARY}}}
EXPORT_RESPONSE = {
    "description": "The export: a CSV file (UTF-8 with a byte order mark) or the JSON of the whole reading.",
    "content": {"text/csv": {"schema": BINARY}, "application/json": {"schema": {"type": "object"}}},
}


class UploadIn(BaseModel):
    """The upload: exactly one part, `file`. Nothing else is accepted next to it."""

    model_config = ConfigDict(extra="forbid", arbitrary_types_allowed=True)

    file: FileStorage


class DocumentPath(BaseModel):
    """A document's address: its ID, which is 22 characters of letters, digits, hyphen and underscore."""

    document_id: DocumentId


class PagePath(DocumentPath):
    """A page of a document: the document's ID and the page's number, from 1."""

    number: Annotated[int, Field(ge=1, le=limits.MAX_PAGES)]


class FieldAddress(DocumentPath):
    """A field of a document: its ID and the field's path, such as `total` or `line_items.0.quantity`."""

    field_path: FieldPathText


class ExportQuery(BaseModel):
    """Which export to make: the lines as CSV, the journal entry as CSV, or everything as JSON."""

    model_config = ConfigDict(extra="forbid")

    format: Literal["csv", "journal", "json"] = "json"


class FieldEditIn(BaseModel):
    """A correction: the text the visitor typed into one field. Empty text empties the field."""

    model_config = ConfigDict(extra="forbid")

    value: Annotated[str, StringConstraints(strip_whitespace=True, max_length=MAX_FIELD_VALUE_CHARS)]

    @field_validator("value")
    @classmethod
    def _check_printable(cls, value: str) -> str:
        """Refuse control characters: a field's value is one line of text."""
        if any(not character.isprintable() for character in value):
            raise ValueError("A value is plain text on one line.")
        return value


def refusal_response(refusal: Refusal) -> Response:
    """Answer with a refusal in the platform's error shape, with when the count starts again if it has a limit."""
    extra = {"resets_at": refusal.resets_at} if refusal.resets_at is not None else {}
    return error_response(refusal.status, refusal.code, refusal.message, **extra)


def download_response(download: Download) -> Response:
    """Answer with a file the visitor asked for, offered as an attachment under a fixed name."""
    response = Response(download.content, mimetype=download.media_type.split(";", 1)[0])
    response.headers["Content-Type"] = download.media_type
    response.headers["Content-Disposition"] = f'attachment; filename="{download.filename}"'
    return response


def limit_upload_before_reading() -> Response | None:
    """Limit an upload before any of it is read: it must say how long it is, and it may not be longer than the limit.

    The app-wide limit is a few kilobytes, which is right for every other route here; this one raises it for the
    upload alone, and keeps the number of parts of the multipart body small.
    """
    if request.method != "POST" or request.path != UPLOAD_PATH:
        return None
    length = request.content_length
    if length is None:
        return error_response(411, "length_required", "The upload must say how long it is.")
    if length > limits.MAX_REQUEST_BYTES:
        return error_response(413, "too_large", TOO_LARGE_MESSAGE)
    request.max_content_length = limits.MAX_REQUEST_BYTES
    request.max_form_parts = MAX_FORM_PARTS
    return None


def build_blueprint(service: Lb03Service | None, web_token_key: str | None) -> APIBlueprint:
    """Build LB-03's routes. With no `service` (it could not start) every route answers 503 after the token check."""
    blueprint = APIBlueprint(
        "lb03",
        __name__,
        url_prefix="/api/lb03",
        abp_tags=[Tag(name="lb-03")],
        abp_security=[{"visitor": []}],
        abp_responses={**COMMON_RESPONSES, 401: ErrorOut, 503: ErrorOut},
    )
    blueprint.before_request(require_visitor(SYSTEM_KEY, web_token_key))
    blueprint.before_request(limit_upload_before_reading)

    @blueprint.post("/documents", responses={202: DocumentOut, 413: ErrorOut, 415: ErrorOut, 429: ErrorOut})
    def upload(form: UploadIn) -> Response | tuple[dict[str, Any], int]:
        """Upload an invoice, a credit note or a till receipt (PDF, PNG, JPEG or WebP, up to 10 MB and 5 pages).

        Answers 202 at once with the document in state `uploaded`; poll it to watch it being read. Counts against
        the visitor's 10 documents a day, which the service enforces itself, and two documents are read at a time.
        A document the service itself fails to read is not counted, for up to three such documents a day.
        """
        if service is None:
            return error_response(503, "unavailable", NOT_SERVING_MESSAGE)
        data = form.file.stream.read(limits.MAX_UPLOAD_BYTES + 1)
        result = service.upload(visitor_of_request().session_key, form.file.filename, data)
        if isinstance(result, Refusal):
            return refusal_response(result)
        return document_out(result, service.queued_ahead(result)).model_dump(mode="json"), 202

    @blueprint.get("/documents", responses={200: DocumentListOut})
    def list_documents() -> Response | dict[str, Any]:
        """List the visitor's documents of the hour, newest first, so the board can find them after a reload."""
        if service is None:
            return error_response(503, "unavailable", NOT_SERVING_MESSAGE)
        documents = service.documents(visitor_of_request().session_key)
        return DocumentListOut(documents=[summary_out(stored) for stored in documents]).model_dump(mode="json")

    @blueprint.get("/documents/<document_id>", responses={200: DocumentOut, 404: ErrorOut})
    def get_document(path: DocumentPath) -> Response | dict[str, Any]:
        """Read one document: its state while it is being read, and when it is ready its fields, boxes and checks."""
        if service is None:
            return error_response(503, "unavailable", NOT_SERVING_MESSAGE)
        stored = service.document(visitor_of_request().session_key, path.document_id)
        if stored is None:
            return refusal_response(Refusal(404, "not_found", "There is no such document."))
        return document_out(stored, service.queued_ahead(stored)).model_dump(mode="json")

    @blueprint.patch(
        "/documents/<document_id>/fields/<field_path>",
        responses={200: DocumentOut, 404: ErrorOut, 409: ErrorOut, 422: ErrorOut},
    )
    def edit_field(path: FieldAddress, body: FieldEditIn) -> Response | dict[str, Any]:
        """Correct one field of a read document: every check runs again, and the correction is recorded.

        A corrected field counts as confirmed by the visitor and loses its box. The duplicate check and the journal
        entry are made again from the corrected reading.
        """
        if service is None:
            return error_response(503, "unavailable", NOT_SERVING_MESSAGE)
        result = service.edit_field(visitor_of_request().session_key, path.document_id, path.field_path, body.value)
        if isinstance(result, Refusal):
            return refusal_response(result)
        return document_out(result).model_dump(mode="json")

    @blueprint.get("/documents/<document_id>/pages/<int:number>", responses={200: PAGE_RESPONSE, 404: ErrorOut})
    def get_page(path: PagePath) -> Response:
        """Read the picture of one page of the visitor's document, for the viewer. Never served any other way."""
        if service is None:
            return error_response(503, "unavailable", NOT_SERVING_MESSAGE)
        picture = service.page_picture(visitor_of_request().session_key, path.document_id, path.number)
        if isinstance(picture, Refusal):
            return refusal_response(picture)
        response = Response(picture, mimetype="image/jpeg")
        response.headers["Content-Disposition"] = f'inline; filename="page-{path.number}.jpg"'
        return response

    @blueprint.get("/documents/<document_id>/export", responses={200: EXPORT_RESPONSE, 404: ErrorOut, 409: ErrorOut})
    def export_document(path: DocumentPath, query: ExportQuery) -> Response:
        """Export a read document: its lines or its journal entry as CSV, or everything as JSON.

        The CSV exports are refused (409) while a failed check stops the export. The JSON always goes.
        """
        if service is None:
            return error_response(503, "unavailable", NOT_SERVING_MESSAGE)
        export_format: ExportFormat = query.format
        result = service.export(visitor_of_request().session_key, path.document_id, export_format)
        if isinstance(result, Refusal):
            return refusal_response(result)
        return download_response(result)

    @blueprint.delete("/documents/<document_id>", responses={204: None, 404: ErrorOut, 409: ErrorOut})
    def delete_document(path: DocumentPath) -> Response | tuple[str, int]:
        """Delete a document that has ended, with its files. A document still being read can't be deleted yet."""
        if service is None:
            return error_response(503, "unavailable", NOT_SERVING_MESSAGE)
        refusal = service.delete(visitor_of_request().session_key, path.document_id)
        if refusal is not None:
            return refusal_response(refusal)
        return "", 204

    @blueprint.get("/quota", responses={200: QuotaOut})
    def quota() -> Response | dict[str, Any]:
        """Read how many documents the visitor has left today, how many are being read, and the limits."""
        if service is None:
            return error_response(503, "unavailable", NOT_SERVING_MESSAGE)
        usage = service.usage(visitor_of_request().session_key)
        return QuotaOut(
            used=usage.used,
            remaining=usage.remaining,
            active=usage.active,
            resets_at=usage.resets_at,
            can_read=service.can_read(),
            limits=limits_out(),
        ).model_dump(mode="json")

    return blueprint
