"""A worker that boots starts LB-03's background work at once, without waiting for the first upload.

The runner (lb03/runner.py) starts its loop lazily, at the first document it is handed. That is how a test wants it,
but it left a hole in production: a worker that gunicorn respawned after a crash, or recycled after its two thousand
requests, did no sweep at all until somebody uploaded something. The documents the dead worker had been reading stayed
`extract` for as long as nobody did, and the files of documents whose hour was over stayed on disk or in the bucket,
which the service promises to delete. Found by killing a worker mid-document in the real service: the document was
still being "read" three minutes later. `create_app(..., start_background=True)`, which `wsgi.py` asks for, now starts
each system's background work as the worker boots, and the first thing it does is a sweep.
"""

import secrets
import time
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import Engine

from core import shutdown
from core.app import create_app
from core.platform import Platform
from lb03 import limits
from lb03.module import LB03
from lb03.repository import DocumentRepository, NewDocument
from lb03.states import DocumentState
from lb03.storage import LocalFileStore, original_key
from lb_common.tracing import Tracer
from tests.lb03_support import FakeGuard
from tests.support import FakeChat, MemorySpanWriter, SiteKey, make_environment

pytestmark = pytest.mark.integration

SAM = "session-of-sam-visitor-0001"


@pytest.fixture(autouse=True)
def wound_down() -> Iterator[None]:
    """End the runner each test started, which a worker does as it stops, so no thread outlives its test."""
    yield
    shutdown.run_all()


def platform_for(engine: Engine, folder: Path) -> Platform:
    """Build the platform a worker has, with the models and the injection check replaced by fakes."""
    spans = MemorySpanWriter()
    environment = make_environment(LB03_FILES_DIR=str(folder / "files"), LB_WEB_TOKEN_KEY=SiteKey().public)
    return Platform(
        environment=environment,
        engines={"lb03": engine},
        chat=FakeChat({}),
        tracer=Tracer(spans),
        clock=lambda: datetime.now(UTC),
        guard=FakeGuard(),
        span_writer=spans,
    )


def lost_document(engine: Engine, folder: Path, quiet_for: float) -> str:
    """Leave a document in the model's hands that nobody has touched for `quiet_for` seconds, as a crash leaves one."""
    repository = DocumentRepository(engine)
    now = datetime.now(UTC)
    document_id = secrets.token_urlsafe(16)
    LocalFileStore(folder / "files").put(original_key(document_id, "pdf"), b"%PDF-1.7 a file", "application/pdf")
    repository.create(NewDocument(document_id, SAM, "invoice.pdf", "pdf", 15, "ab" * 32, now.date()), now)
    repository.advance(document_id, DocumentState.EXTRACT, [], now)
    repository.touch([document_id], now - timedelta(seconds=quiet_for))
    return document_id


def wait_for(condition: Callable[[], bool], timeout: float = 15.0) -> bool:
    """Poll until a condition holds or the time is up; return whether it held."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.05)
    return condition()


def test_a_booting_worker_ends_the_documents_its_predecessor_lost_before_any_upload(
    lb03_engine: Engine, tmp_path: Path
) -> None:
    """The sweep runs as the worker starts: the lost document is `interrupted`, with no visitor having uploaded."""
    document_id = lost_document(lb03_engine, tmp_path, limits.STALE_AFTER_SECONDS + 120)
    repository = DocumentRepository(lb03_engine)

    create_app(platform_for(lb03_engine, tmp_path), [LB03], start_background=True)

    def ended() -> bool:
        """Say whether the lost document has been ended."""
        stored = repository.get(document_id, SAM, datetime.now(UTC))
        return stored is not None and stored.state == "failed" and stored.failure_code == "interrupted"

    assert wait_for(ended), "the booting worker never swept"


def test_an_app_that_was_not_asked_to_start_its_background_work_does_not_sweep(
    lb03_engine: Engine, tmp_path: Path
) -> None:
    """A test's app, or the one a command builds to read its OpenAPI document, starts no thread of its own."""
    document_id = lost_document(lb03_engine, tmp_path, limits.STALE_AFTER_SECONDS + 120)
    repository = DocumentRepository(lb03_engine)

    create_app(platform_for(lb03_engine, tmp_path), [LB03])
    time.sleep(0.5)

    stored = repository.get(document_id, SAM, datetime.now(UTC))
    assert stored is not None
    assert stored.state == "extract"
