"""JSON answers for Django's own errors, so the API never serves an HTML error page."""

from django.http import HttpRequest, JsonResponse


def error_body(code: str, message: str) -> dict[str, dict[str, str]]:
    """Build an error in the shape the whole platform uses: `{"error": {"code", "message"}}`."""
    return {"error": {"code": code, "message": message}}


def not_found(request: HttpRequest, exception: Exception) -> JsonResponse:  # noqa: ARG001 - Django's handler signature
    """Answer an unknown path with a JSON 404 that doesn't repeat the path, whatever was asked."""
    return JsonResponse(error_body("not_found", "There is nothing at this address."), status=404)


def server_error(request: HttpRequest) -> JsonResponse:  # noqa: ARG001 - Django's handler signature
    """Answer an unexpected failure with a JSON 500 that reveals nothing about it or the request."""
    return JsonResponse(error_body("internal_error", "The service hit an internal error."), status=500)
