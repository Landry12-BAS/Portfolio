"""The sweep: documents whose hour is over, files left behind, documents lost mid-reading, and old counters.

This is what keeps the datasheet's promise that nothing a visitor uploads outlives the hour. It is the service's own
sweep, not a storage rule: Cloudflare R2's lifecycle works in whole days, so a bucket rule alone could keep a file
for a day or more. The sweep runs every minute inside each worker (lb03/runner.py) and by hand with
`manage.py sweep_lb03`, and one pass does four things:

1. Recover the documents lost in the pipeline (their worker died), ending them `interrupted` and giving the
   visitor's place back, so no one is held on a document that will never finish.
2. Delete each document whose hour is over: its files first, then its row. A document still unfinished at its
   hour is ended first, so the visitor's counters are settled before the evidence goes.
3. Delete a file with no document: a document folder whose newest file is older than the hour, which is what a
   process that died between writing the file and writing the row leaves behind.
4. Delete the quota counters of days that are over.

Every step is safe to run twice, and safe to run in two workers at once: each deletes what is already past its
time, and what it can't delete it leaves for the next pass. A step that fails is logged by type and does not stop
the others.
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy.exc import SQLAlchemyError

from core.errors import describe_failure
from lb03 import limits
from lb03.quota import PostgresLedger
from lb03.repository import DocumentRepository, StoredDocument
from lb03.states import SERVICE_FAILURES, FailureCode
from lb03.storage import FileStore, StorageError, document_prefix, sweep_files

logger = logging.getLogger(__name__)

# How many documents one batch of the sweep takes, and how many batches a pass takes at most, so a long backlog
# is worked off in pieces over several passes.
BATCH_SIZE = 200
MAX_BATCHES = 50


@dataclass(frozen=True)
class SweepReport:
    """What one pass of the sweep did, as counts."""

    recovered: int
    expired: int
    files_deleted: int
    orphans: int
    counters: int


def end_lost(repository: DocumentRepository, ledger: PostgresLedger, document: StoredDocument, now: datetime) -> bool:
    """End a document whose pipeline is gone as `interrupted`, and give the visitor's place back; True if this did it.

    The document's final state is written once (the row's own check), so only the pass that wrote it gives the place
    back, and a document that finished a moment ago is left as it ended.
    """
    wrote = repository.finish_failed(
        document.id, FailureCode.INTERRUPTED, now, document.model_calls, document.run_id, []
    )
    if wrote:
        ledger.release(document.session_key, document.admitted_on, refund=FailureCode.INTERRUPTED in SERVICE_FAILURES)
    return wrote


def recover_lost(repository: DocumentRepository, ledger: PostgresLedger, now: datetime) -> int:
    """End the documents that have shown no sign of life for too long; return how many there were."""
    before = now - timedelta(seconds=limits.STALE_AFTER_SECONDS)
    recovered = 0
    for _ in range(MAX_BATCHES):
        lost = repository.stale(before, BATCH_SIZE)
        ended = [end_lost(repository, ledger, document, now) for document in lost]
        recovered += sum(1 for wrote in ended if wrote)
        if len(lost) < BATCH_SIZE:
            break
    return recovered


def delete_files_of(store: FileStore, document: StoredDocument) -> bool:
    """Delete a document's folder of files; False, logged, when the store could not."""
    try:
        store.delete_prefix(document_prefix(document.id))
    except StorageError as error:
        logger.error("Could not delete the files of an expired document: %s", describe_failure(error))
        return False
    return True


def delete_expired(
    repository: DocumentRepository, ledger: PostgresLedger, store: FileStore, now: datetime
) -> tuple[int, int]:
    """Delete the documents whose hour is over, files first and then the row; return (documents, folders with files).

    A document whose files could not be deleted keeps its row, so the next pass tries again and no file is left
    that nothing knows about.
    """
    removed = 0
    with_files = 0
    for _ in range(MAX_BATCHES):
        expired = repository.expired(now, BATCH_SIZE)
        deletable = []
        for document in expired:
            if not document.is_final:
                end_lost(repository, ledger, document, now)
            if delete_files_of(store, document):
                deletable.append(document.id)
                with_files += 1
        removed += repository.purge(deletable)
        if len(expired) < BATCH_SIZE or not deletable:
            break
    return removed, with_files


def attempt[Result](step: str, work: Callable[[], Result], default: Result) -> Result:
    """Run one step of the sweep; a failure is logged by type and place, and the step counts as done nothing."""
    try:
        return work()
    except (SQLAlchemyError, StorageError) as error:
        logger.error("The sweep step %s failed: %s", step, describe_failure(error))
        return default


def sweep(repository: DocumentRepository, ledger: PostgresLedger, store: FileStore, now: datetime) -> SweepReport:
    """Run one pass of the sweep as of `now`, and say what it did."""
    recovered = attempt("recover", lambda: recover_lost(repository, ledger, now), 0)
    expired, files_deleted = attempt("expire", lambda: delete_expired(repository, ledger, store, now), (0, 0))
    lifetime = timedelta(seconds=limits.FILE_LIFETIME_SECONDS)
    orphans = attempt("orphans", lambda: sweep_files(store, now, lifetime), 0)
    counters = attempt("counters", ledger.sweep, 0)
    return SweepReport(recovered, expired, files_deleted, orphans, counters)
