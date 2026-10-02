"""The OCR worker: `python -m lb03.ocr.worker`, started by the service for one document and gone when it is read.

What it does, in this order, and why the order matters:

1. Load the libraries and read one line from standard input: the limits the service holds it to. The service is
   trusted; the file is not.
2. Set its own limits (CPU time, memory, size of a written file, open files). They count the whole process,
   libraries included, so it makes no difference that the libraries were loaded first.
3. Build the OCR engine from the models in its wheel. This reads files, so it comes before the cage closes.
4. Build the cage (lb03/ocr/sandbox.py) and prove it holds. From here the process can write only its scratch
   folder (the folder it was started in), open no socket and start no program.
5. Only now read the rest of standard input: the file.
6. Decode it (lb03/ocr/decode.py), read each page's words, write the page pictures and `result.json`, and print
   one status line. A file it refuses gets a status with a code; a crash or a kill leaves no status, and the
   service reads that as a failure of the reading.

Nothing of the file is printed or logged. The process imports no web, database or gateway code.
"""

import json
import sys
import time
from pathlib import Path

from PIL import Image
from pydantic import ValidationError
from rapidocr import RapidOCR

from lb03.limits import PAGE_JPEG_QUALITY
from lb03.ocr.decode import DecodeError, decode_document
from lb03.ocr.engine import build_engine, read_words
from lb03.ocr.protocol import MODEL_PICTURE, RESULT_FILE, OcrPage, OcrResult, SandboxReport, WorkerLimits, WorkerStatus
from lb03.ocr.sandbox import SandboxError, apply_rlimits, apply_sandbox
from lb03.states import FailureCode

# The limits line is a short JSON object; a longer line is not the service speaking.
MAX_LIMITS_LINE = 4_096
# What the worker exits with when it could not even start, and when its cage would not hold.
EXIT_BAD_REQUEST = 64
EXIT_NO_CAGE = 66


def say(status: WorkerStatus) -> None:
    """Print the one status line the service reads."""
    sys.stdout.write(status.model_dump_json() + "\n")
    sys.stdout.flush()


def refuse(code: FailureCode) -> None:
    """Tell the service the document was refused, and why."""
    say(WorkerStatus(ok=False, code=code))


def read_limits() -> WorkerLimits:
    """Read the service's limits from the first line of standard input."""
    line = sys.stdin.buffer.readline(MAX_LIMITS_LINE)
    return WorkerLimits.model_validate(json.loads(line))


def read_file(limits: WorkerLimits) -> bytes:
    """Read the file from standard input, holding no more than the size limit plus one byte of it."""
    data = sys.stdin.buffer.read(limits.max_bytes + 1)
    if len(data) > limits.max_bytes:
        raise DecodeError(FailureCode.TOO_LARGE)
    return data


def write_pages(document_pages: list[Image.Image], engine: RapidOCR, scratch: Path) -> list[OcrPage]:
    """Save each page as a JPEG in the scratch folder and read its words."""
    pages = []
    for number, image in enumerate(document_pages, start=1):
        picture = f"page-{number}.jpg"
        image.save(scratch / picture, "JPEG", quality=PAGE_JPEG_QUALITY)
        words = read_words(engine, image)
        pages.append(OcrPage(number=number, width=image.width, height=image.height, picture=picture, words=words))
    return pages


def write_model_picture(first_page: Image.Image, limits: WorkerLimits, scratch: Path) -> None:
    """Save a smaller JPEG of the first page, the picture the vision model is shown."""
    smaller = first_page.copy()
    smaller.thumbnail((limits.model_long_side, limits.model_long_side))
    smaller.save(scratch / MODEL_PICTURE, "JPEG", quality=limits.model_quality)


def read_document(limits: WorkerLimits, scratch: Path, engine: RapidOCR, started: float, report: SandboxReport) -> None:
    """Decode the file, read its pages, and leave the findings in the scratch folder, then say how it went."""
    try:
        document = decode_document(read_file(limits), limits)
        pages = write_pages(document.pages, engine, scratch)
        if not any(page.words for page in pages):
            raise DecodeError(FailureCode.NO_TEXT)
        write_model_picture(document.pages[0], limits, scratch)
        result = OcrResult(
            kind=document.kind.name,
            pages=pages,
            model_picture=MODEL_PICTURE,
            sandbox=report,
            elapsed_ms=round((time.monotonic() - started) * 1000),
        )
    except DecodeError as error:
        refuse(error.code)
        return
    except (MemoryError, ValidationError):
        refuse(FailureCode.OCR_FAILED)
        return
    (scratch / RESULT_FILE).write_text(result.model_dump_json(), encoding="utf-8")
    say(WorkerStatus(ok=True))


def main() -> int:
    """Run one document through the worker, and return the process's exit status."""
    started = time.monotonic()
    scratch = Path.cwd()
    try:
        limits = read_limits()
    except (ValueError, ValidationError):
        return EXIT_BAD_REQUEST
    apply_rlimits(limits)
    Image.init()
    engine = build_engine(limits.threads)
    try:
        report = apply_sandbox(scratch, limits)
    except SandboxError:
        refuse(FailureCode.OCR_FAILED)
        return EXIT_NO_CAGE
    read_document(limits, scratch, engine, started, report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
