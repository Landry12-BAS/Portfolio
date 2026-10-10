"""Tests for what LB-03's upload does when it cannot hand a document to the readers, on a real Postgres.

The readers can be full or closing, and a store or a database can fail, between the moment a visitor's upload is
counted and the moment a reader takes it. None of that is the visitor's doing, so the place goes back every time:
the day's refunds, which are capped because a failure inside a reader can be made on purpose, are not spent on it.
"""

from datetime import UTC, datetime
from pathlib import Path
from typing import cast

import pytest
from sqlalchemy import Engine

from lb03 import limits
from lb03.accounts import ChartOfAccounts
from lb03.pipeline import Job
from lb03.quota import PostgresLedger
from lb03.repository import DocumentRepository
from lb03.runner import PipelineRunner, RunnerBusyError, RunnerClosedError
from lb03.service import Lb03Service, Refusal
from lb03.storage import LocalFileStore

pytestmark = pytest.mark.integration

SAM = "session-of-sam-visitor-0001"
PDF = b"%PDF-1.7 a file that is only here to be sniffed"


class DoorKeeper:
    """A runner that takes no document: it is full, or closing, as the test says."""

    def __init__(self, error: Exception) -> None:
        """Refuse every document with `error`."""
        self.error = error
        self.refused = 0

    def start(self) -> None:
        """Do nothing: there are no readers."""

    def close(self) -> None:
        """Do nothing: there are no readers."""

    def submit(self, job: Job) -> None:  # noqa: ARG002 - the runner's signature
        """Refuse the document."""
        self.refused += 1
        raise self.error


def service_with(engine: Engine, folder: Path, error: Exception) -> tuple[Lb03Service, PostgresLedger, DoorKeeper]:
    """Make the service on the real repository and ledger, with a runner that refuses every document with `error`."""
    ledger = PostgresLedger(engine, lambda: datetime.now(UTC))
    runner = DoorKeeper(error)
    service = Lb03Service(
        DocumentRepository(engine),
        ledger,
        LocalFileStore(folder / "files"),
        cast(PipelineRunner, runner),
        cast(ChartOfAccounts, None),
        [],
        lambda: datetime.now(UTC),
        lambda: True,
    )
    return service, ledger, runner


@pytest.mark.parametrize(
    ("error", "code"),
    [(RunnerBusyError("full"), "readers_busy"), (RunnerClosedError("closing"), "unavailable")],
)
def test_a_visitor_turned_away_more_often_than_the_refunds_allow_keeps_every_place(
    lb03_engine: Engine, tmp_path: Path, error: Exception, code: str
) -> None:
    """Five refusals in a row, past the cap on refunds, leave the visitor with all ten documents of their day."""
    service, ledger, runner = service_with(lb03_engine, tmp_path, error)
    turned_away = limits.MAX_REFUNDS_PER_DAY + 2

    for _ in range(turned_away):
        answer = service.upload(SAM, "invoice.pdf", PDF)
        assert isinstance(answer, Refusal)
        assert answer.code == code

    assert runner.refused == turned_away
    usage = ledger.usage(SAM)
    assert usage.remaining == limits.DOCUMENTS_PER_DAY
    assert usage.active == 0
