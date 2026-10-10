"""The claim "two documents in flight do not wait for each other", proved under the server production runs.

The runner's own tests prove it on a runner. This proves it under gunicorn with the `gthread` worker class, one worker
process and eight threads, the settings of gunicorn.conf.py, with the app imported after the fork: two uploads from two
visitors are answered `202` at once, and both documents are read in the background while the web threads stay free. The
model of the test app blocks each call until a second call is in flight (tests/lb03_gunicorn_app.py), so a service that
read its documents one after the other would leave both calls waiting for each other until the barrier gave up, and the
documents would fail instead of ending `ready`.

What this does not prove, and the datasheet does not claim: that OCR runs in parallel. OCR is CPU work, done in a worker
process of its own and bounded to a few at once; it is the waits for models and storage that overlap.
"""

import http.client
import json
import os
import signal
import subprocess
import sys
import time
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from core.databases import create_system_engine
from core.migrations import upgrade
from lb03.models import MIGRATIONS
from lb03.quota import PostgresLedger
from lb03.repository import DocumentRepository
from tests.lb03_serving import ALEX, PDF, SAM, multipart
from tests.support import SiteKey

pytestmark = pytest.mark.integration

SERVICE_DIRECTORY = Path(__file__).resolve().parents[2]
# One of the ports this work was given (8131 to 8139): never a port another service of the repository uses.
PORT = 8131
START_SECONDS = 30.0
STOP_SECONDS = 25.0
DOCUMENT_SECONDS = 40.0


class Server:
    """A running gunicorn, and a way to talk to it as a visitor with a valid token."""

    def __init__(self, site_key: SiteKey, log: Path, process: subprocess.Popen[bytes], database_url: str) -> None:
        """Remember the key the visitors' tokens are minted with, the log, the process and its database."""
        self.site_key = site_key
        self.log = log
        self.process = process
        self.database_url = database_url

    def request(
        self, method: str, path: str, session: str, body: bytes | None = None, content_type: str | None = None
    ) -> tuple[int, bytes]:
        """Send one request on a connection of its own, and return the status and the body."""
        headers = dict(self.site_key.headers("lb-03", session))
        if content_type is not None:
            headers["Content-Type"] = content_type
        connection = http.client.HTTPConnection("localhost", PORT, timeout=30)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def upload(self, session: str) -> dict[str, Any]:
        """Upload a small PDF as the visitor, expecting 202, and return the document."""
        body, header = multipart(PDF)
        status, data = self.request("POST", "/api/lb03/documents", session, body, header)
        assert status == 202, data
        return dict(json.loads(data))

    def document(self, session: str, document_id: str) -> dict[str, Any]:
        """Read a document as its visitor."""
        status, data = self.request("GET", f"/api/lb03/documents/{document_id}", session)
        assert status == 200, data
        return dict(json.loads(data))

    def wait_for_end(self, session: str, document_id: str) -> dict[str, Any]:
        """Poll a document until it ends, as the board does."""
        deadline = time.monotonic() + DOCUMENT_SECONDS
        while time.monotonic() < deadline:
            document = self.document(session, document_id)
            if document["state"] in {"ready", "failed"}:
                return document
            time.sleep(0.1)
        raise AssertionError(f"the document did not end in time; the server said:\n{self.tail()}")

    def tail(self) -> str:
        """Return the last of the server's log, for a failing test to show."""
        return self.log.read_text(errors="replace")[-3000:] if self.log.exists() else "(no log)"


def stop(process: subprocess.Popen[bytes]) -> None:
    """Stop gunicorn and everything it started: ask nicely, then kill the whole process group."""
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=STOP_SECONDS)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()


@pytest.fixture
def server(make_database: Callable[[], str], tmp_path: Path) -> Iterator[Server]:
    """Start gunicorn (gthread, one worker, eight threads) on LB-03's test app, and stop it afterwards."""
    url = make_database()
    engine = create_system_engine(url, "lb03")
    upgrade(engine, "lb03", MIGRATIONS)
    engine.dispose()
    site_key = SiteKey()
    log = tmp_path / "gunicorn.log"
    environment = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": os.environ.get("HOME", str(tmp_path)),
        "PYTHONPATH": str(SERVICE_DIRECTORY),
        "GUNICORN_BIND": f"127.0.0.1:{PORT}",
        "GUNICORN_WORKERS": "1",
        "GUNICORN_THREADS": "8",
        "LB03_PROOF_DATABASE_URL": url,
        "LB03_PROOF_FILES": str(tmp_path / "files"),
        "LB03_PROOF_SITE_KEY": site_key.public,
        "LB03_PROOF_BARRIER_SECONDS": "4",
        "LB03_PROOF_GRACE_SECONDS": "1",
    }
    with log.open("wb") as handle:
        process = subprocess.Popen(
            [sys.executable, "-m", "gunicorn", "--config", "gunicorn.conf.py", "tests.lb03_gunicorn_app:app"],
            cwd=SERVICE_DIRECTORY,
            env=environment,
            stdout=handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    started = Server(site_key, log, process, url)
    deadline = time.monotonic() + START_SECONDS
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise AssertionError(f"gunicorn stopped at start:\n{started.tail()}")
        try:
            status, _ = started.request("GET", "/api/healthz", SAM)
        except OSError:
            time.sleep(0.2)
            continue
        if status == 200:
            break
    else:
        stop(process)
        raise AssertionError(f"gunicorn did not start in time:\n{started.tail()}")
    yield started
    stop(process)


def test_two_documents_are_in_flight_at_once_under_gunicorn_gthread(server: Server) -> None:
    """Each model call waits for a second one: both documents end ready only if they were read at the same time."""
    first = server.upload(SAM)
    second = server.upload(ALEX)

    ended = [server.wait_for_end(SAM, first["id"]), server.wait_for_end(ALEX, second["id"])]

    assert [document["state"] for document in ended] == ["ready", "ready"], server.tail()
    assert all(document["model_calls"] == 2 for document in ended)


def test_the_web_threads_stay_free_while_documents_are_being_read(server: Server) -> None:
    """With two documents held in the pipeline, twenty requests at once are all answered promptly."""
    first = server.upload(SAM)
    second = server.upload(ALEX)

    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=20) as pool:
        answers = list(pool.map(lambda _: server.request("GET", "/api/lb03/quota", SAM), range(20)))
    elapsed = time.monotonic() - started

    assert [status for status, _ in answers] == [200] * 20
    assert elapsed < 5.0, f"twenty quota reads took {elapsed:.1f} seconds"
    server.wait_for_end(SAM, first["id"])
    server.wait_for_end(ALEX, second["id"])


def test_an_upload_is_answered_before_the_document_has_been_read(server: Server) -> None:
    """The 202 comes back while the reader is still working: the request thread never waits for the pipeline."""
    started = time.monotonic()
    created = server.upload(SAM)
    answered_in = time.monotonic() - started

    assert created["state"] in {"uploaded", "ocr"}
    assert answered_in < 2.0
    # The other visitor's document lets the first one's model call through, so nothing is left running.
    other = server.upload(ALEX)
    server.wait_for_end(SAM, created["id"])
    server.wait_for_end(ALEX, other["id"])


def test_a_worker_told_to_stop_ends_the_document_it_holds_and_gives_the_place_back(server: Server) -> None:
    """A lone document waits at the barrier in its model call; the worker is stopped, and the document is settled.

    Nothing is left for the sweep to find lost: the document is `interrupted`, and the visitor has the place back.
    """
    created = server.upload(SAM)
    deadline = time.monotonic() + 15
    while server.document(SAM, created["id"])["state"] != "extract" and time.monotonic() < deadline:
        time.sleep(0.05)

    os.killpg(server.process.pid, signal.SIGTERM)
    server.process.wait(timeout=STOP_SECONDS)

    engine = create_system_engine(server.database_url, "lb03")
    try:
        stored = DocumentRepository(engine).get_for_pipeline(created["id"])
        usage = PostgresLedger(engine, lambda: datetime.now(UTC)).usage(SAM)
    finally:
        engine.dispose()
    assert stored is not None
    assert (stored.state, stored.failure_code) == ("failed", "interrupted"), server.tail()
    assert (usage.used, usage.active) == (0, 0)
