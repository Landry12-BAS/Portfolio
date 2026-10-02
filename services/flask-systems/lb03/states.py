"""The states a document passes through, and the codes that say why one failed.

A document is `uploaded`, then read by OCR (`ocr`), then a model fills the schema (`extract`), then code
checks it (`validate`), then once at most the model is sent back to repair a failed check (`repair`, and
`validate` again), and it ends `ready` or `failed`. `ready` means the pipeline finished and there is
something to look at: it may still carry failed checks, which is a finding, not a failure. `failed` means
there is no result, and the code says why in a fixed vocabulary the board has words for.
"""

from enum import StrEnum


class DocumentState(StrEnum):
    """Where a document is in the pipeline."""

    UPLOADED = "uploaded"
    OCR = "ocr"
    EXTRACT = "extract"
    VALIDATE = "validate"
    REPAIR = "repair"
    READY = "ready"
    FAILED = "failed"


# The states a document ends in; its pipeline is over.
FINAL_STATES = frozenset({DocumentState.READY, DocumentState.FAILED})
# The states in which a pipeline is working on the document.
ACTIVE_STATES = frozenset(set(DocumentState) - FINAL_STATES)


class FailureCode(StrEnum):
    """Why a document has no result."""

    # The file is not what it says: not a PDF, PNG, JPEG or WebP. Refused at the door, never stored.
    UNSUPPORTED_FILE = "unsupported_file"
    # The file is over 10 MB. Refused at the door, never stored.
    TOO_LARGE = "too_large"
    # The OCR worker counted more than five pages.
    TOO_MANY_PAGES = "too_many_pages"
    # An image, or a page, has more pixels than the decompression-bomb cap.
    IMAGE_TOO_BIG = "image_too_big"
    # The file claims to be a PDF or an image and the decoder could not read it.
    UNREADABLE_FILE = "unreadable_file"
    # The PDF carries active content or a reference to something outside itself, which the reader refuses.
    UNSAFE_FILE = "unsafe_file"
    # OCR read the pages and found no words.
    NO_TEXT = "no_text"
    # The OCR worker crashed, ran out of time, or was stopped by its limits.
    OCR_FAILED = "ocr_failed"
    # The injection check flagged the text, so no model was shown it.
    INJECTION_SUSPECTED = "injection_suspected"
    # The injection check could not run, so the text counts as unchecked and no model was shown it.
    UNCHECKED = "unchecked"
    # The models are not answering, or the day's free capacity is used, or the reply could not be read.
    MODEL_FAILED = "model_failed"
    MODEL_BUDGET = "model_budget"
    MODEL_OUTPUT = "model_output"
    # The document took longer than its time, or needed more model calls than it is given.
    TIME_LIMIT = "time_limit"
    CALL_LIMIT = "call_limit"
    # The process that was reading the document stopped before it finished.
    INTERRUPTED = "interrupted"


# Failures that are the service's, not the visitor's file's: the document is given back to the visitor's day,
# up to a few a day (lb03/limits.py), because retrying later may work.
SERVICE_FAILURES = frozenset(
    {
        FailureCode.OCR_FAILED,
        FailureCode.UNCHECKED,
        FailureCode.MODEL_FAILED,
        FailureCode.MODEL_BUDGET,
        FailureCode.MODEL_OUTPUT,
        FailureCode.TIME_LIMIT,
        FailureCode.CALL_LIMIT,
        FailureCode.INTERRUPTED,
    }
)
