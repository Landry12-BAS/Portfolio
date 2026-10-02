"""Serving LB-03 for the tests that go through its HTTP API: the real app over a real Postgres, with fakes for the rest.

`build_served` assembles what production assembles (the platform, the service as `lb03/service.py` builds it, the
blueprint, the app factory) and replaces only what a test must not run: the models, the injection check and,
unless a test asks for the real one, the OCR reader. `Served` is a visitor's-eye view of it: it sends requests with a
valid token, uploads files as a browser would, and polls a document until it ends.
"""

import itertools
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from flask import Flask
from sqlalchemy import Engine
from werkzeug.test import TestResponse

from core.app import create_app
from core.platform import Platform
from core.registry import SystemModule, SystemRuntime
from lb03.api import SYSTEM_KEY, build_blueprint
from lb03.pipeline import Reader
from lb03.service import Lb03Service, build_service
from lb_common.tracing import Tracer
from tests.lb03_support import FakeGuard
from tests.support import FakeChat, MemorySpanWriter, SiteKey, make_environment

SAM = "session-of-sam-visitor-0001"
ALEX = "session-of-alex-visitor-0002"
NOW = datetime(2026, 10, 1, 9, 30, tzinfo=UTC)
PDF = b"%PDF-1.7\n%a small file the fake reader never opens\n"


def multipart(
    data: bytes, filename: str = "invoice.pdf", content_type: str | None = None, extra: dict[str, str] | None = None
) -> tuple[bytes, str]:
    """Write a multipart body by hand: one file part and any extra fields, as a browser or the site's proxy sends it."""
    boundary = "----lb03-test-" + secrets.token_hex(8)
    parts: list[bytes] = []
    for name, value in (extra or {}).items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    kind = f"Content-Type: {content_type}\r\n" if content_type else ""
    head = f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n{kind}\r\n'
    parts.append(head.encode() + data + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def moving_clock() -> Callable[[], datetime]:
    """Return a clock that is a millisecond later each time it is read, so documents have an order."""
    ticks = itertools.count()
    return lambda: NOW + timedelta(milliseconds=next(ticks))


@dataclass
class Served:
    """LB-03 served through the real app factory over a real Postgres, with a fake reader and fake models."""

    app: Flask
    site_key: SiteKey
    service: Lb03Service
    chat: FakeChat
    reader: Any
    spans: MemorySpanWriter
    files: Path

    def request(
        self, method: str, path: str, session: str = SAM, system: str = SYSTEM_KEY, **options: Any
    ) -> TestResponse:
        """Send a request as a visitor with a valid token, from a client of its own."""
        headers = {**self.site_key.headers(system, session), **options.pop("headers", {})}
        # Buffered, so the response is read to its end and the request (and the temporary file of a big upload) closed.
        return self.app.test_client().open(path, method=method, headers=headers, buffered=True, **options)

    def upload(
        self,
        data: bytes = PDF,
        filename: str = "invoice.pdf",
        session: str = SAM,
        content_type: str | None = None,
        extra: dict[str, str] | None = None,
    ) -> TestResponse:
        """Upload a file as a multipart body with one file part (and any extra fields a test adds)."""
        body, header = multipart(data, filename, content_type, extra)
        return self.request("POST", "/api/lb03/documents", session, data=body, content_type=header)

    def document(self, document_id: str, session: str = SAM) -> dict[str, Any]:
        """Read a document as JSON, failing the test if it isn't answered with 200."""
        response = self.request("GET", f"/api/lb03/documents/{document_id}", session)
        assert response.status_code == 200, response.get_data(as_text=True)
        return dict(response.get_json())

    def correct(self, document_id: str, path: str, value: str, session: str = SAM) -> TestResponse:
        """Correct one field of a document, as the board's editable table does."""
        url = f"/api/lb03/documents/{document_id}/corrections"
        return self.request("POST", url, session, json={"path": path, "value": value})

    def wait_for_end(self, document_id: str, session: str = SAM, timeout: float = 15.0) -> dict[str, Any]:
        """Poll a document until it is ready or failed, as the board does, and return it."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            document = self.document(document_id, session)
            if document["state"] in {"ready", "failed"}:
                return document
            time.sleep(0.05)
        raise AssertionError("the document did not end in time")

    def read(self, session: str = SAM, **upload_options: Any) -> dict[str, Any]:
        """Upload a document and wait for it to end."""
        response = self.upload(session=session, **upload_options)
        assert response.status_code == 202, response.get_data(as_text=True)
        return self.wait_for_end(response.get_json()["id"], session)


def build_served(
    engine: Engine,
    folder: Path,
    reader: Reader | None,
    replies: list[str | Exception],
    gateway: bool = True,
    guard: FakeGuard | None = None,
) -> Served:
    """Build the platform and LB-03's runtime as production does, with the models and perhaps the reader replaced."""
    site_key = SiteKey()
    files = folder / "files"
    environment = make_environment(LB03_FILES_DIR=str(files), LB_WEB_TOKEN_KEY=site_key.public)
    spans = MemorySpanWriter()
    chat = FakeChat({"lb-fast": list(replies), "lb-vision": list(replies)})
    platform = Platform(
        environment=environment,
        engines={"lb03": engine},
        chat=chat if gateway else None,
        tracer=Tracer(spans),
        clock=moving_clock(),
        guard=(guard or FakeGuard()) if gateway else None,
        span_writer=spans,
    )
    service = build_service(platform, reader=reader)
    if service is None:
        raise AssertionError("LB-03 could not be built for the test.")
    runtime = SystemRuntime(build_blueprint(service, site_key.public), service.is_ready)
    module = SystemModule(key=SYSTEM_KEY, schema="lb03", build=lambda _: runtime)
    return Served(create_app(platform, [module]), site_key, service, chat, reader, spans, files)
