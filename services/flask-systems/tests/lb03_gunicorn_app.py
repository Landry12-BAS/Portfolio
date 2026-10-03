"""The WSGI app the gunicorn proof serves: LB-03 as production wires it, with a model that waits for a second caller.

Gunicorn imports this module in its worker (`tests.lb03_gunicorn_app:app`), so the app, the runner's event loop and its
threads are all made after the fork, as in production. Everything is real but the models, the injection check and the
reader: the model blocks each call until a second call is in flight too, which a service that read documents one after
another could never allow, so a document that ends `ready` is proof that two were being read at the same moment.
"""

import json
import os
import threading
from collections.abc import Sequence
from datetime import UTC, datetime

from core.app import create_app
from core.databases import create_system_engine
from core.platform import Platform
from core.registry import SystemModule, SystemRuntime
from core.structured import ChatMessage, Completion
from lb03.api import SYSTEM_KEY, build_blueprint
from lb03.golden import printed_as_reply, read_golden_set
from lb03.invoice import ExtractedInvoice
from lb03.runner import RunnerSettings
from lb03.service import build_service
from lb_common.tracing import Tracer
from tests.lb03_support import FakeGuard, FakeReader, invoice_page
from tests.support import MemorySpanWriter, make_environment

# How long a call waits for the other one before the proof is called failed, unless the test says another time.
BARRIER_SECONDS = float(os.environ.get("LB03_PROOF_BARRIER_SECONDS", "20"))
# How long a worker that is told to stop gives the documents it holds, which a test shortens.
SHUTDOWN_GRACE_SECONDS = float(os.environ.get("LB03_PROOF_GRACE_SECONDS", "20"))


def plain_case_reply() -> tuple[str, ExtractedInvoice]:
    """Return the JSON a perfect model gives for a clean golden document, and the invoice it holds."""
    golden = read_golden_set()
    case = next(item for item in golden.cases if item.expect.outcome == "valid" and item.sample is None)
    assert case.printed is not None
    return json.dumps(printed_as_reply(case.printed)), ExtractedInvoice.from_reply(printed_as_reply(case.printed))


class BarrierChat:
    """A model whose calls each wait for a second call to be in flight, and which counts how many were at once."""

    def __init__(self, reply: str) -> None:
        """Answer every call with `reply`, once two calls are in flight together."""
        self._reply = reply
        self._barrier = threading.Barrier(2, timeout=BARRIER_SECONDS)
        self._lock = threading.Lock()
        self.in_flight = 0
        self.most_in_flight = 0

    def complete(
        self, alias: str, messages: Sequence[ChatMessage], max_tokens: int, timeout_seconds: float | None = None
    ) -> Completion:
        """Wait for another call to be in flight, then answer."""
        del alias, messages, max_tokens, timeout_seconds
        with self._lock:
            self.in_flight += 1
            self.most_in_flight = max(self.most_in_flight, self.in_flight)
        try:
            self._barrier.wait()
            return Completion(self._reply, "test/lb-fast")
        finally:
            with self._lock:
                self.in_flight -= 1


def build_app() -> object:
    """Build the app from the environment the proof sets: its database, the site's public key and a files folder."""
    reply, invoice = plain_case_reply()
    engine = create_system_engine(os.environ["LB03_PROOF_DATABASE_URL"], "lb03")
    environment = make_environment(
        FLASK_ALLOWED_HOSTS="localhost,127.0.0.1",
        LB03_FILES_DIR=os.environ["LB03_PROOF_FILES"],
        LB_WEB_TOKEN_KEY=os.environ["LB03_PROOF_SITE_KEY"],
    )
    spans = MemorySpanWriter()
    platform = Platform(
        environment=environment,
        engines={"lb03": engine},
        chat=BarrierChat(reply),
        tracer=Tracer(spans),
        clock=lambda: datetime.now(UTC),
        guard=FakeGuard(),
        span_writer=spans,
    )
    settings = RunnerSettings(shutdown_grace_seconds=SHUTDOWN_GRACE_SECONDS)
    service = build_service(platform, reader=FakeReader([invoice_page(invoice)], delay=0.3), runner_settings=settings)
    if service is None:
        raise RuntimeError("LB-03 could not be built for the proof.")
    runtime = SystemRuntime(build_blueprint(service, environment.web_token_key), service.is_ready)
    return create_app(platform, [SystemModule(key=SYSTEM_KEY, schema="lb03", build=lambda _: runtime)])


app = build_app()
