"""What the OCR worker and the service say to each other: the limits it is given, and the words it found.

The service writes one line of JSON (`WorkerLimits`) to the worker's standard input, then the file's bytes.
The worker answers with one line on its standard output (`WorkerStatus`) and leaves its findings in its scratch
folder: `result.json` (an `OcrResult`) and the page pictures it names. All of it is untrusted on the way back,
since the worker is the process a hostile file would be trying to take over, so every number here has bounds
and every list has a length, and the service reads the files with those schemas and nothing else.

Boxes are quads: four corners, clockwise from the top left, each `x, y` as a share of the page's width and
height. A rotated photograph's words are not upright rectangles, and the board draws what the OCR saw.
"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from lb03.limits import MAX_PAGES
from lb03.states import FailureCode

# The most words one page may carry back, the longest one, and the most bytes one result file may weigh.
MAX_WORDS_PER_PAGE = 4_000
MAX_WORD_CHARS = 120
MAX_RESULT_BYTES = 12 * 1024 * 1024
MAX_PICTURE_BYTES = 3 * 1024 * 1024
RESULT_FILE = "result.json"
MODEL_PICTURE = "model.jpg"

type Quad = tuple[float, float, float, float, float, float, float, float]
# A corner may be a little off the page: a rotated word at the edge. Further than this is no word.
Corner = Annotated[float, Field(ge=-0.5, le=1.5, allow_inf_nan=False)]
Name = Annotated[str, StringConstraints(pattern=r"^[a-z0-9.-]{1,40}$")]


class Strict(BaseModel):
    """The base of every message: nothing unknown, nothing mutable."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class WorkerLimits(Strict):
    """What the service tells the worker about the file it is about to send: the limits it must hold to."""

    max_bytes: int = Field(gt=0)
    max_pages: int = Field(gt=0, le=MAX_PAGES)
    max_pixels: int = Field(gt=0)
    cpu_seconds: int = Field(gt=0, le=600)
    memory_bytes: int = Field(gt=0)
    file_bytes: int = Field(gt=0)
    open_files: int = Field(default=64, ge=16, le=1024)
    page_long_side: int = Field(gt=0)
    model_long_side: int = Field(gt=0)
    model_quality: int = Field(ge=30, le=95)
    threads: int = Field(default=2, ge=1, le=8)
    # Refuse to run when the kernel has no Landlock, instead of running with one layer less.
    require_landlock: bool = False


class OcrWord(Strict):
    """One word: its text, the share of certainty the recogniser gave it, where it is, and which line it is on."""

    text: Annotated[str, StringConstraints(min_length=1, max_length=MAX_WORD_CHARS)]
    confidence: Annotated[float, Field(ge=0.0, le=1.0, allow_inf_nan=False)]
    quad: tuple[Corner, Corner, Corner, Corner, Corner, Corner, Corner, Corner]
    line: Annotated[int, Field(ge=0, le=MAX_WORDS_PER_PAGE)]


class OcrPage(Strict):
    """One page: its number, the size of the picture the words were read from, the picture's file, and the words."""

    number: Annotated[int, Field(ge=1, le=MAX_PAGES)]
    width: Annotated[int, Field(ge=1, le=20_000)]
    height: Annotated[int, Field(ge=1, le=20_000)]
    picture: Name
    words: Annotated[list[OcrWord], Field(max_length=MAX_WORDS_PER_PAGE)]


class SandboxReport(Strict):
    """Which walls the worker put up round itself, so the service can say so in its trace."""

    rlimits: bool
    no_new_privileges: bool
    seccomp: bool
    landlock_abi: Annotated[int, Field(ge=0, le=20)]
    # How willing the worker made itself to be the kernel's first victim when memory runs out (0 when it could not).
    oom_score_adj: Annotated[int, Field(ge=-1000, le=1000)] = 0


class OcrResult(Strict):
    """Everything the worker read from one document."""

    kind: Literal["pdf", "png", "jpeg", "webp"]
    pages: Annotated[list[OcrPage], Field(min_length=1, max_length=MAX_PAGES)]
    model_picture: Name | None
    sandbox: SandboxReport
    elapsed_ms: Annotated[int, Field(ge=0, le=3_600_000)]


class WorkerStatus(Strict):
    """The one line the worker prints: it read the document, or it refused it, and why."""

    ok: bool
    code: FailureCode | None = None
