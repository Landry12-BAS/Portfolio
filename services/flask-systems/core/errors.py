"""JSON answers for every error, so the API never serves an HTML error page.

All errors use the shape the whole platform answers with, `{"error": {"code", "message"}}`.
Messages are fixed sentences: they never repeat the path, the headers or the body of
the request that caused them, whatever it held. A failure nobody expected is logged by
its type and place only, because the message of an exception can quote what a visitor
wrote.
"""

import logging
import traceback

from flask import Flask, Response, jsonify
from flask.typing import ResponseReturnValue
from pydantic import BaseModel, ValidationError
from werkzeug.exceptions import HTTPException, MethodNotAllowed

logger = logging.getLogger(__name__)

# What each status the API can answer with is called, and what is said about it.
HTTP_ERRORS = {
    400: ("bad_request", "The request can't be understood."),
    404: ("not_found", "There is nothing at this address."),
    405: ("method_not_allowed", "This address doesn't answer that method."),
    413: ("request_too_large", "The request is larger than this service accepts."),
    415: ("unsupported_media_type", "Send the request as JSON."),
}
UNEXPECTED_ERROR = ("internal_error", "The service hit an internal error.")


class ErrorDetail(BaseModel):
    """What went wrong, as a stable code and a sentence for people.

    `fields` names the fields a 422 faults, and `resets_at` says when a daily limit starts again.
    """

    code: str
    message: str
    fields: str | None = None
    resets_at: str | None = None


class ErrorOut(BaseModel):
    """The error shape the whole platform answers with, as the OpenAPI document describes it."""

    error: ErrorDetail


def error_body(code: str, message: str) -> dict[str, dict[str, str]]:
    """Build an error in the shape the whole platform uses: `{"error": {"code", "message"}}`."""
    return {"error": {"code": code, "message": message}}


def error_response(status: int, code: str, message: str, **extra: str) -> Response:
    """Build a JSON error response; `extra` adds fields next to the code and message, such as `fields`."""
    body = error_body(code, message)
    body["error"].update(extra)
    response = jsonify(body)
    response.status_code = status
    return response


def invalid_request_response(error: ValidationError) -> Response:
    """Answer a malformed request with 422, naming the fields at fault but never echoing their values."""
    fields = sorted({".".join(str(part) for part in issue["loc"]) for issue in error.errors()})
    return error_response(
        422, "invalid_request", "The request doesn't have the expected form.", fields=", ".join(fields)
    )


def describe_failure(error: BaseException) -> str:
    """Say what failed and where, as the exception's type and the last place in this code it passed through.

    The exception's message is left out on purpose: it may quote a visitor's words.
    """
    frames = traceback.extract_tb(error.__traceback__)
    if not frames:
        return type(error).__name__
    last = frames[-1]
    return f"{type(error).__name__} at {last.filename}:{last.lineno} in {last.name}"


def http_error(error: HTTPException) -> ResponseReturnValue:
    """Answer an HTTP error Flask or Werkzeug raised, in the platform's shape and without echoing the request."""
    status = error.code or 500
    code, message = HTTP_ERRORS.get(status, ("http_error", "The request can't be served."))
    response = error_response(status, code, message)
    if isinstance(error, MethodNotAllowed) and error.valid_methods:
        response.headers["Allow"] = ", ".join(error.valid_methods)
    return response


def unexpected_error(error: Exception) -> ResponseReturnValue:
    """Answer a failure nobody expected with a generic 500, and log what failed without its message."""
    logger.error("Unhandled failure: %s", describe_failure(error))
    code, message = UNEXPECTED_ERROR
    return error_response(500, code, message)


def register_error_handlers(app: Flask) -> None:
    """Make every error the app can raise answer as JSON in the platform's shape."""
    app.register_error_handler(HTTPException, http_error)
    app.register_error_handler(Exception, unexpected_error)
