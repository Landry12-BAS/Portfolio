"""Tests for LB-03's documents table (lb03/repository.py) on a real Postgres.

What these prove: a visitor reads only their own documents and only for the hour; a document that has ended stays
ended, even when the pipeline and the recovery of lost documents finish it at the same moment; and what is saved
comes back as the same checked reading.
"""

import threading
from datetime import UTC, date, datetime, timedelta

import pytest
from sqlalchemy import Engine, select

from lb03 import limits
from lb03.accounts import post, read_chart
from lb03.boxes import Placement
from lb03.checks import run_checks
from lb03.duplicates import Known, identity_of
from lb03.golden import SEED_DIRECTORY, printed_as_reply, read_golden_set
from lb03.invoice import ExtractedInvoice
from lb03.models import Document
from lb03.repository import (
    DocumentRepository,
    FinishedReading,
    NewDocument,
    checks_from_json,
    invoice_from_json,
)
from lb03.states import DocumentState, FailureCode

pytestmark = pytest.mark.integration

SAM = "session-of-sam-visitor-0001"
ALEX = "session-of-alex-visitor-0002"
NOW = datetime(2026, 10, 1, 9, 30, tzinfo=UTC)
CLEAN = "bohemia-packaging-2026-0412"


def new_document(document_id: str, session_key: str = SAM, **overrides: object) -> NewDocument:
    """Make what the service knows when a file is accepted."""
    values: dict[str, object] = {
        "id": document_id,
        "session_key": session_key,
        "label": "invoice.pdf",
        "kind": "pdf",
        "byte_size": 48_000,
        "file_sha256": "ab" * 32,
        "admitted_on": date(2026, 10, 1),
        **overrides,
    }
    return NewDocument(**values)  # type: ignore[arg-type]


def golden_invoice(case_id: str = CLEAN) -> ExtractedInvoice:
    """Make the invoice a perfect model would read from one of the golden documents."""
    case = read_golden_set().case(case_id)
    assert case.printed is not None
    return ExtractedInvoice.from_reply(printed_as_reply(case.printed))


def finished_reading(case_id: str = CLEAN, run_id: str = "run-0001") -> FinishedReading:
    """Make a finished reading of a golden document: its checks, its journal entry and its identity."""
    invoice = golden_invoice(case_id)
    return FinishedReading(
        invoice=invoice,
        placements={
            "total": Placement(
                path="total", page=1, quad=(0.5, 0.8, 0.7, 0.8, 0.7, 0.82, 0.5, 0.82), confidence=0.97, match=1.0
            )
        },
        checks=run_checks(invoice, date(2026, 10, 1)),
        journal=post(invoice, read_chart(SEED_DIRECTORY)),
        identity=identity_of(invoice),
        duplicate_of=None,
        duplicate_same_content=None,
        page_count=1,
        text_cut=False,
        model="test/lb-fast",
        model_calls=2,
        run_id=run_id,
        ocr_ms=900,
        elapsed_ms=4200,
        steps=[{"step": "ocr", "ms": 900}],
    )


@pytest.fixture
def repository(lb03_engine: Engine) -> DocumentRepository:
    """Return the repository on an empty documents table."""
    return DocumentRepository(lb03_engine)


def test_a_new_document_starts_uploaded_and_lives_for_an_hour(repository: DocumentRepository) -> None:
    """A row is made in `uploaded`, with no result yet, expiring one hour after it was counted."""
    stored = repository.create(new_document("doc-one"), NOW)

    assert (stored.state, stored.failure_code, stored.extraction, stored.checks) == ("uploaded", None, None, None)
    assert stored.expires_at == NOW + timedelta(seconds=limits.FILE_LIFETIME_SECONDS)
    assert (stored.steps, stored.corrections, stored.model_calls, stored.is_final) == ([], [], 0, False)


def test_a_visitor_reads_only_their_own_documents(repository: DocumentRepository) -> None:
    """Another visitor's id and the right id with the wrong visitor both find nothing."""
    repository.create(new_document("doc-sam"), NOW)
    repository.create(new_document("doc-alex", ALEX), NOW)

    assert repository.get("doc-sam", SAM, NOW) is not None
    assert repository.get("doc-sam", ALEX, NOW) is None
    assert repository.get("doc-alex", SAM, NOW) is None
    assert [document.id for document in repository.list_for(SAM, NOW)] == ["doc-sam"]
    assert [document.id for document in repository.list_for(ALEX, NOW)] == ["doc-alex"]


def test_a_document_is_gone_at_its_hour_even_before_the_sweep_removes_it(repository: DocumentRepository) -> None:
    """Reads stop at the expiry time, so a delayed sweep can't extend the hour."""
    repository.create(new_document("doc-sam"), NOW)
    just_before = NOW + timedelta(seconds=limits.FILE_LIFETIME_SECONDS - 1)
    at_expiry = NOW + timedelta(seconds=limits.FILE_LIFETIME_SECONDS)

    assert repository.get("doc-sam", SAM, just_before) is not None
    assert repository.get("doc-sam", SAM, at_expiry) is None
    assert repository.list_for(SAM, at_expiry) == []


def test_a_visitors_documents_are_listed_newest_first(repository: DocumentRepository) -> None:
    """The board shows the latest upload at the top."""
    for index, name in enumerate(("first", "second", "third")):
        repository.create(new_document(name), NOW + timedelta(minutes=index))

    assert [document.id for document in repository.list_for(SAM, NOW + timedelta(minutes=5))] == [
        "third",
        "second",
        "first",
    ]


def test_a_document_moves_through_its_states_and_each_step_is_noted(repository: DocumentRepository) -> None:
    """`advance` changes the state and appends the step, in order."""
    repository.create(new_document("doc-sam"), NOW)

    assert repository.advance("doc-sam", DocumentState.OCR, {"step": "ocr"}, NOW + timedelta(seconds=1))
    assert repository.advance("doc-sam", DocumentState.EXTRACT, {"step": "extract"}, NOW + timedelta(seconds=5))

    stored = repository.get("doc-sam", SAM, NOW)
    assert stored is not None
    assert stored.state == "extract"
    assert stored.steps == [{"step": "ocr"}, {"step": "extract"}]
    assert stored.updated_at == NOW + timedelta(seconds=5)


def test_a_finished_reading_comes_back_as_the_same_checked_reading(repository: DocumentRepository) -> None:
    """What is saved when a document is ready reads back as the same invoice, the same checks and the same journal."""
    reading = finished_reading()
    repository.create(new_document("doc-sam"), NOW)

    assert repository.finish_ready("doc-sam", reading, NOW + timedelta(seconds=9))

    stored = repository.get("doc-sam", SAM, NOW)
    assert stored is not None
    assert (stored.state, stored.failure_code, stored.page_count, stored.is_final) == ("ready", None, 1, True)
    assert stored.extraction is not None
    assert invoice_from_json(stored.extraction) == reading.invoice
    assert stored.checks is not None
    assert checks_from_json(stored.checks) == reading.checks
    assert stored.placements == {
        "total": {"page": 1, "quad": [0.5, 0.8, 0.7, 0.8, 0.7, 0.82, 0.5, 0.82], "confidence": 0.97, "match": 1.0}
    }
    assert stored.journal is not None
    assert stored.journal["reference"] == "Bohemia Packaging s.r.o. 2026-0412"
    debit = sum(float(line["debit"]) for line in stored.journal["lines"])
    credit = sum(float(line["credit"]) for line in stored.journal["lines"])
    assert debit == pytest.approx(credit)
    assert (stored.model, stored.model_calls, stored.run_id, stored.ocr_ms, stored.elapsed_ms) == (
        "test/lb-fast",
        2,
        "run-0001",
        900,
        4200,
    )
    assert stored.steps == [{"step": "ocr", "ms": 900}]


def test_amounts_are_stored_as_exact_decimal_text_never_as_floats(repository: DocumentRepository) -> None:
    """The extraction column holds money as strings, so no amount passes through a binary float."""
    reading = finished_reading()
    repository.create(new_document("doc-sam"), NOW)
    repository.finish_ready("doc-sam", reading, NOW)

    stored = repository.get("doc-sam", SAM, NOW)

    assert stored is not None
    assert stored.extraction is not None
    assert isinstance(stored.extraction["total"], str)
    assert stored.extraction["total"] == str(reading.invoice.total)
    assert all(isinstance(item["total"], str) for item in stored.extraction["line_items"])


def test_the_identity_of_a_ready_document_is_kept_for_the_duplicate_check(repository: DocumentRepository) -> None:
    """The vendor key, the number key and the content hash are columns, so a duplicate is found by an index."""
    reading = finished_reading()
    repository.create(new_document("doc-sam"), NOW)
    repository.finish_ready("doc-sam", reading, NOW)

    stored = repository.get("doc-sam", SAM, NOW)

    assert stored is not None
    assert reading.identity is not None
    assert (stored.identity_vendor, stored.identity_number, stored.content_hash) == (
        reading.identity.vendor,
        reading.identity.number,
        reading.identity.content,
    )


def test_a_failed_document_keeps_its_code_and_what_was_spent(repository: DocumentRepository) -> None:
    """`failed` names why in the fixed vocabulary, and records the calls and the run for the trace."""
    repository.create(new_document("doc-sam"), NOW)

    assert repository.finish_failed(
        "doc-sam", FailureCode.INJECTION_SUSPECTED, NOW, model_calls=1, run_id="run-0002", steps=[{"step": "guard"}]
    )

    stored = repository.get("doc-sam", SAM, NOW)
    assert stored is not None
    assert (stored.state, stored.failure_code, stored.model_calls, stored.run_id) == (
        "failed",
        "injection_suspected",
        1,
        "run-0002",
    )
    assert stored.extraction is None


def test_a_document_that_has_ended_stays_ended(repository: DocumentRepository) -> None:
    """A late step of the pipeline, or the recovery of a lost document, can't overwrite a ready or failed one."""
    repository.create(new_document("ready-one"), NOW)
    repository.create(new_document("failed-one"), NOW)
    repository.finish_ready("ready-one", finished_reading(), NOW)
    repository.finish_failed("failed-one", FailureCode.NO_TEXT, NOW, 0, None, [])

    assert not repository.advance("ready-one", DocumentState.OCR, {"step": "late"}, NOW)
    assert not repository.finish_failed("ready-one", FailureCode.INTERRUPTED, NOW, 0, None, [])
    assert not repository.finish_ready("failed-one", finished_reading(), NOW)
    assert not repository.advance("failed-one", DocumentState.EXTRACT, {"step": "late"}, NOW)

    ready, failed = repository.get("ready-one", SAM, NOW), repository.get("failed-one", SAM, NOW)
    assert ready is not None
    assert failed is not None
    assert (ready.state, failed.state, failed.failure_code) == ("ready", "failed", "no_text")
    assert ready.steps == [{"step": "ocr", "ms": 900}]


def test_the_pipeline_and_the_recovery_ending_one_document_together_have_exactly_one_winner(
    repository: DocumentRepository,
) -> None:
    """Twenty threads race to end one document, as ready or as failed: one write lands and the rest see False."""
    repository.create(new_document("doc-sam"), NOW)
    barrier = threading.Barrier(20)
    outcomes: list[bool] = [False] * 20

    def finish(index: int) -> None:
        """Wait for the others, then end the document in the way this thread's number picks."""
        barrier.wait()
        if index % 2:
            outcomes[index] = repository.finish_ready("doc-sam", finished_reading(), NOW)
        else:
            outcomes[index] = repository.finish_failed("doc-sam", FailureCode.INTERRUPTED, NOW, 0, None, [])

    threads = [threading.Thread(target=finish, args=(index,)) for index in range(20)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert outcomes.count(True) == 1
    stored = repository.get("doc-sam", SAM, NOW)
    assert stored is not None
    assert (stored.state == "ready") == (stored.failure_code is None)
    assert (stored.extraction is not None) == (stored.state == "ready")


def test_a_correction_is_saved_with_a_note_of_the_change_and_only_on_a_ready_document(
    repository: DocumentRepository,
) -> None:
    """The visitor's edit replaces the reading, its checks and the entry, and the corrections list grows."""
    reading = finished_reading()
    repository.create(new_document("doc-sam"), NOW)
    edited = reading.invoice.model_copy(update={"vendor": "Bohemia Packaging a.s."})
    correction = {"path": "vendor", "was": "Bohemia Packaging s.r.o.", "now": "Bohemia Packaging a.s."}

    assert not repository.save_edit("doc-sam", SAM, edited, reading.checks, reading.journal, correction, NOW)
    repository.finish_ready("doc-sam", reading, NOW)
    assert repository.save_edit("doc-sam", SAM, edited, reading.checks, reading.journal, correction, NOW)
    assert repository.save_edit("doc-sam", SAM, edited, reading.checks, reading.journal, correction, NOW)

    stored = repository.get("doc-sam", SAM, NOW)
    assert stored is not None
    assert stored.extraction is not None
    assert invoice_from_json(stored.extraction).vendor == "Bohemia Packaging a.s."
    assert stored.corrections == [correction, correction]


def test_nobody_edits_another_visitors_document_or_one_that_has_expired(repository: DocumentRepository) -> None:
    """The edit is by id and visitor and within the hour, like every read."""
    reading = finished_reading()
    repository.create(new_document("doc-sam"), NOW)
    repository.finish_ready("doc-sam", reading, NOW)
    edited = reading.invoice.model_copy(update={"vendor": "Someone Else"})

    other_visitor = repository.save_edit("doc-sam", ALEX, edited, reading.checks, None, {"path": "vendor"}, NOW)
    too_late = repository.save_edit(
        "doc-sam", SAM, edited, reading.checks, None, {"path": "vendor"}, NOW + timedelta(hours=2)
    )

    assert (other_visitor, too_late) == (False, False)
    stored = repository.get("doc-sam", SAM, NOW)
    assert stored is not None
    assert (stored.extraction or {}).get("vendor") == "Bohemia Packaging s.r.o."
    assert stored.corrections == []


def test_the_duplicate_check_sees_only_the_visitors_other_finished_documents_of_the_hour(
    repository: DocumentRepository,
) -> None:
    """Identities come from the same visitor's ready documents of the hour, never the one being read."""
    repository.create(new_document("old-ready"), NOW)
    repository.finish_ready("old-ready", finished_reading(), NOW)
    repository.create(new_document("still-reading"), NOW + timedelta(minutes=1))
    repository.create(new_document("failed"), NOW + timedelta(minutes=2))
    repository.finish_failed("failed", FailureCode.NO_TEXT, NOW, 0, None, [])
    repository.create(new_document("this-one"), NOW + timedelta(minutes=3))
    repository.finish_ready("this-one", finished_reading(), NOW)
    repository.create(new_document("alexs", ALEX), NOW)
    repository.finish_ready("alexs", finished_reading(), NOW)
    now = NOW + timedelta(minutes=10)

    known = repository.known_identities(SAM, now, exclude="this-one")

    reading = finished_reading()
    assert reading.identity is not None
    assert known == [Known("document", "old-ready", reading.identity)]
    later = NOW + timedelta(hours=2)
    assert repository.known_identities(SAM, later, exclude="this-one") == []


def test_a_visitor_can_delete_their_own_document_and_nobody_elses(repository: DocumentRepository) -> None:
    """Delete is by id and visitor."""
    repository.create(new_document("doc-sam"), NOW)

    assert not repository.delete("doc-sam", ALEX)
    assert repository.delete("doc-sam", SAM)
    assert not repository.delete("doc-sam", SAM)
    assert repository.get("doc-sam", SAM, NOW) is None


def test_the_sweep_finds_the_expired_in_order_and_purges_them_by_id(repository: DocumentRepository) -> None:
    """`expired` returns the documents whose hour is over, oldest first, and `purge` removes exactly those."""
    repository.create(new_document("oldest"), NOW)
    repository.create(new_document("older"), NOW + timedelta(minutes=10))
    repository.create(new_document("fresh"), NOW + timedelta(minutes=55))
    now = NOW + timedelta(minutes=80)

    expired = repository.expired(now, limit=10)

    assert [document.id for document in expired] == ["oldest", "older"]
    assert [document.id for document in repository.expired(now, limit=1)] == ["oldest"]
    assert repository.purge([document.id for document in expired]) == 2
    assert repository.purge([]) == 0
    assert [document.id for document in repository.list_for(SAM, now)] == ["fresh"]


def test_a_document_nobody_has_touched_for_a_while_is_found_as_lost_and_a_touch_keeps_it_alive(
    repository: DocumentRepository,
) -> None:
    """Recovery looks at documents still in the pipeline that have been quiet; finished ones are never lost."""
    repository.create(new_document("quiet"), NOW)
    repository.create(new_document("busy"), NOW)
    repository.create(new_document("done"), NOW)
    repository.finish_ready("done", finished_reading(), NOW)
    later = NOW + timedelta(seconds=limits.STALE_AFTER_SECONDS + 60)

    repository.touch("busy", later - timedelta(seconds=10))
    repository.touch("done", later - timedelta(seconds=10))
    lost = repository.stale(later - timedelta(seconds=limits.STALE_AFTER_SECONDS), limit=10)

    assert [document.id for document in lost] == ["quiet"]


def test_the_pipeline_can_read_a_document_by_id_alone(repository: DocumentRepository) -> None:
    """The pipeline works on a document it was handed the id of; the visitor's routes never use this read."""
    repository.create(new_document("doc-sam"), NOW)

    assert repository.get_for_pipeline("doc-sam") is not None
    assert repository.get_for_pipeline("missing") is None


def test_the_duplicate_columns_record_what_the_reading_found(repository: DocumentRepository) -> None:
    """A document that duplicates another says which, and whether its content matches."""
    reading = finished_reading()
    duplicate = FinishedReading(
        **{**reading.__dict__, "duplicate_of": "sample:bohemia", "duplicate_same_content": True}
    )
    repository.create(new_document("doc-sam"), NOW)
    repository.finish_ready("doc-sam", duplicate, NOW)

    stored = repository.get("doc-sam", SAM, NOW)

    assert stored is not None
    assert (stored.duplicate_of, stored.duplicate_same_content) == ("sample:bohemia", True)


def test_the_check_that_failed_survives_a_round_trip_with_its_numbers(repository: DocumentRepository) -> None:
    """A failing document keeps what the code computed and what the document says, for the board to show."""
    failing = next(item for item in read_golden_set().cases if item.expect.outcome == "needs_review")
    invoice = golden_invoice(failing.id)
    results = run_checks(invoice, date(2026, 10, 1))
    reading = FinishedReading(**{**finished_reading().__dict__, "invoice": invoice, "checks": results, "journal": None})
    repository.create(new_document("doc-sam"), NOW)
    repository.finish_ready("doc-sam", reading, NOW)

    stored = repository.get("doc-sam", SAM, NOW)

    assert stored is not None
    assert stored.checks is not None
    returned = checks_from_json(stored.checks)
    assert returned == results
    assert {result.id for result in returned if result.failed} == set(failing.expect.failing_checks)
    assert any(result.failed and result.expected is not None and result.actual is not None for result in returned)
    assert stored.journal is None


def test_the_table_holds_nothing_after_everything_is_purged(
    lb03_engine: Engine, repository: DocumentRepository
) -> None:
    """A last look at the table itself: purged documents leave no row behind."""
    repository.create(new_document("doc-sam"), NOW)
    repository.purge(["doc-sam"])

    with lb03_engine.connect() as connection:
        assert connection.execute(select(Document.id)).first() is None
