"""Measuring the OCR on the synthetic documents: how many printed words it reads, and how many fields it boxes.

This is the number behind the datasheet's claims about reading, run for real (`just ocr-lb03`): every document
of the golden set goes through the real worker, cage and all, and the result is compared with what the
generator knows is on the page. Two things are measured.

**Word recall.** Every printed word of a document has a box from the generator (lb03/synthetic/words.py). A
printed word is *read* when OCR returned a word with the same letters and digits (case, accents and punctuation
ignored) whose box overlaps it by at least 0.3 (intersection over union of the two upright boxes). The
position-free figure counts a printed word read when the same word turns up anywhere on the page, as often as
it is printed: it says how much OCR got right even where its boxes drift. Word precision is the share of
returned words that are a printed word. The mean confidence of the words that were read and of those that
were not says whether the confidence number tells a good word from a bad one.

**Field boxes.** The golden set says what each document prints. Taking that as the model's answer (an oracle:
a perfect extraction), `place_fields` (lb03/boxes.py) finds each field on the OCR's words, and the box it
finds is compared with the box the generator knows the field is printed in. A field is *located* when the
rule gives it a box at all, a *hit* when its box overlaps the true one by at least 0.5, and a *lenient hit*
when its centre falls inside the true box. A field the rule did not locate is a miss in both. The oracle
means this measures OCR and the box rule, not the model.

The numbers are a property of these 43 synthetic documents and of this OCR. They say how well it reads print
and how badly it reads handwriting; they do not say how it reads your invoices. This is development tooling:
it needs the generator, which the running service does not carry.
"""

import asyncio
import json
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path

from lb03.boxes import PageWords, normalise, place_fields
from lb03.golden import (
    EVALS_DIRECTORY,
    SEED_DIRECTORY,
    FieldBox,
    GoldenCase,
    GoldenSet,
    printed_as_reply,
    read_golden_set,
    read_manifest,
)
from lb03.invoice import ExtractedInvoice
from lb03.ocr.pool import OcrError, OcrPool, PoolSettings, Reading, default_worker_limits
from lb03.ocr.protocol import OcrWord
from lb03.synthetic.build import GroundWord, Rendered, render_all

# Two word boxes must overlap by this much (intersection over union) for a printed word to count as read.
WORD_OVERLAP = 0.3
# A field's box must overlap the true one by this much to count as a hit.
FIELD_OVERLAP = 0.5
# A printed word must have at least this many letters or digits to be counted: bullets and rules are not words.
MIN_WORD_CHARACTERS = 1
AMOUNT_FIELDS = {"subtotal", "total", "unit_price", "base", "amount"}
type Box = tuple[float, float, float, float]


@dataclass
class CaseResult:
    """What was measured on one document."""

    id: str
    kind: str
    medium: str
    seconds: float
    printed_words: int = 0
    read_words: int = 0
    bag_read_words: int = 0
    returned_words: int = 0
    precise_words: int = 0
    confidence_read: float = 0.0
    confidence_missed: float = 0.0
    fields: int = 0
    located: int = 0
    hits: int = 0
    lenient_hits: int = 0
    by_field_kind: dict[str, list[int]] = field(default_factory=dict)
    refused: str | None = None


def bounding_box(quad: Sequence[float]) -> Box:
    """Return the upright box (left, top, right, bottom) that holds a quad's four corners."""
    xs, ys = quad[0::2], quad[1::2]
    return (min(xs), min(ys), max(xs), max(ys))


def overlap(first: Box, second: Box) -> float:
    """Return the intersection over union of two boxes: 0 when they miss each other, 1 when they are the same."""
    left, top = max(first[0], second[0]), max(first[1], second[1])
    right, bottom = min(first[2], second[2]), min(first[3], second[3])
    if right <= left or bottom <= top:
        return 0.0
    inside = (right - left) * (bottom - top)
    union = (first[2] - first[0]) * (first[3] - first[1]) + (second[2] - second[0]) * (second[3] - second[1]) - inside
    return inside / union if union > 0 else 0.0


def centre_inside(box: Box, container: Box) -> bool:
    """Tell whether the middle of a box lies inside another."""
    x, y = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    return container[0] <= x <= container[2] and container[1] <= y <= container[3]


def squashed(text: str) -> str:
    """Reduce a word to its letters and digits, lower-cased and without accents, so two spellings compare equal."""
    return normalise(text).replace(" ", "")


def counted(words: Sequence[GroundWord]) -> list[GroundWord]:
    """Keep the printed words that have letters or digits: the ones that are words."""
    return [word for word in words if len(squashed(word.text)) >= MIN_WORD_CHARACTERS]


def match_words(printed: Sequence[GroundWord], returned: Sequence[tuple[int, OcrWord]]) -> tuple[set[int], set[int]]:
    """Pair printed words with returned ones of the same letters whose boxes overlap; return both matched sets.

    Each returned word serves one printed word, the best-overlapping first, so a word printed twice needs two reads.
    """
    used: set[int] = set()
    read: set[int] = set()
    for index, word in enumerate(printed):
        wanted = squashed(word.text)
        box = bounding_box(word.quad)
        best, best_overlap = None, WORD_OVERLAP
        for position, (page, candidate) in enumerate(returned):
            if position in used or page != word.page or squashed(candidate.text) != wanted:
                continue
            score = overlap(box, bounding_box(candidate.quad))
            if score >= best_overlap:
                best, best_overlap = position, score
        if best is not None:
            used.add(best)
            read.add(index)
    return read, used


def bag_recall_count(printed: Sequence[GroundWord], returned: Sequence[tuple[int, OcrWord]]) -> int:
    """Count the printed words that were returned somewhere on their page, as often as they are printed."""
    available: dict[tuple[int, str], int] = defaultdict(int)
    for page, returned_word in returned:
        available[(page, squashed(returned_word.text))] += 1
    found = 0
    for printed_word in printed:
        key = (printed_word.page, squashed(printed_word.text))
        if available[key] > 0:
            available[key] -= 1
            found += 1
    return found


def field_kind(path: str) -> str:
    """Name the kind of a field from its path: amount, quantity, rate, date, currency or text."""
    name = path.split(".")[-1]
    if name in AMOUNT_FIELDS or name == "total":
        return "amount"
    if name in {"quantity", "rate"}:
        return name
    if name.endswith("date"):
        return "date"
    return "currency" if name == "currency" else "text"


def measure_fields(case: GoldenCase, reading: Reading, truth: Sequence[FieldBox], result: CaseResult) -> None:
    """Find every printed field on the OCR's words, taking the golden set as the extraction, and score the boxes."""
    if case.printed is None:
        return
    invoice = ExtractedInvoice.from_reply(printed_as_reply(case.printed))
    pages = [PageWords(page.number, page.words) for page in reading.pages]
    placements = place_fields(invoice, pages)
    for box in truth:
        kind = field_kind(box.path)
        counts = result.by_field_kind.setdefault(kind, [0, 0, 0, 0])
        counts[0] += 1
        result.fields += 1
        placement = placements.get(box.path)
        if placement is None or placement.page != box.page:
            continue
        counts[1] += 1
        result.located += 1
        wanted, got = bounding_box(box.quad), bounding_box(placement.quad)
        if overlap(wanted, got) >= FIELD_OVERLAP:
            counts[2] += 1
            result.hits += 1
        if centre_inside(got, wanted):
            counts[3] += 1
            result.lenient_hits += 1


def measure_words(printed: Sequence[GroundWord], reading: Reading, result: CaseResult) -> None:
    """Count how many printed words were read, in position and anywhere on the page, and how precise OCR was."""
    returned = [(page.number, word) for page in reading.pages for word in page.words]
    words = counted(printed)
    read, used = match_words(words, returned)
    result.printed_words = len(words)
    result.read_words = len(read)
    result.bag_read_words = bag_recall_count(words, returned)
    result.returned_words = len(returned)
    result.precise_words = len(used)
    right = [word.confidence for position, (_, word) in enumerate(returned) if position in used]
    wrong = [word.confidence for position, (_, word) in enumerate(returned) if position not in used]
    result.confidence_read = sum(right) / len(right) if right else 0.0
    result.confidence_missed = sum(wrong) / len(wrong) if wrong else 0.0


async def measure_case(
    pool: OcrPool, case: GoldenCase, rendered: Rendered, truth: Sequence[FieldBox], data: bytes
) -> CaseResult:
    """Read one document with the real worker and score it; a refusal is recorded, not scored."""
    result = CaseResult(case.id, case.kind, case.render.medium, 0.0)
    try:
        reading = await pool.read(data)
    except OcrError as error:
        result.refused = error.code.value
        return result
    result.seconds = reading.wall_ms / 1000
    measure_words(rendered.words, reading, result)
    measure_fields(case, reading, truth, result)
    return result


def measurable(golden: GoldenSet, only: str | None) -> list[GoldenCase]:
    """List the cases the measurement reads: those with a printed truth, one per file, optionally just one."""
    cases = [case for case in golden.cases if case.printed is not None and case.render.copy_of is None]
    return [case for case in cases if only is None or case.id == only]


async def measure_all(only: str | None, workers: int, page_side: int | None = None) -> list[CaseResult]:
    """Draw the ground truth, then read every measurable document through a pool of real workers."""
    golden = read_golden_set()
    manifest = {entry.id: entry for entry in read_manifest().files}
    rendered = render_all(golden)
    worker_limits = default_worker_limits()
    if page_side is not None:
        worker_limits = worker_limits.model_copy(update={"page_long_side": page_side})
    pool = OcrPool(PoolSettings(workers=workers, worker_limits=worker_limits))
    cases = measurable(golden, only)

    async def one(case: GoldenCase) -> CaseResult:
        """Measure one case."""
        data = (SEED_DIRECTORY / case.file).read_bytes()
        return await measure_case(pool, case, rendered[case.id], manifest[case.id].fields, data)

    return list(await asyncio.gather(*(one(case) for case in cases)))


def share(part: int, whole: int) -> float:
    """Return a share as a number from 0 to 1, with an empty whole counting as 0."""
    return part / whole if whole else 0.0


@dataclass
class Summary:
    """The measurement of a group of documents, added up."""

    documents: int = 0
    refused: int = 0
    seconds: float = 0.0
    printed_words: int = 0
    read_words: int = 0
    bag_read_words: int = 0
    returned_words: int = 0
    precise_words: int = 0
    fields: int = 0
    located: int = 0
    hits: int = 0
    lenient_hits: int = 0
    confidence_read: float = 0.0
    confidence_missed: float = 0.0

    def add(self, result: CaseResult) -> None:
        """Add one document to the group."""
        self.documents += 1
        if result.refused:
            self.refused += 1
            return
        self.seconds += result.seconds
        for name in (
            "printed_words",
            "read_words",
            "bag_read_words",
            "returned_words",
            "precise_words",
            "fields",
            "located",
            "hits",
            "lenient_hits",
        ):
            setattr(self, name, getattr(self, name) + getattr(result, name))
        self.confidence_read += result.confidence_read
        self.confidence_missed += result.confidence_missed

    @property
    def read(self) -> int:
        """Return how many documents were read (not refused)."""
        return self.documents - self.refused

    def rows(self) -> dict[str, float]:
        """Return the group's figures as shares and means."""
        return {
            "documents": float(self.documents),
            "word_recall": share(self.read_words, self.printed_words),
            "word_recall_anywhere": share(self.bag_read_words, self.printed_words),
            "word_precision": share(self.precise_words, self.returned_words),
            "fields_located": share(self.located, self.fields),
            "field_box_hits": share(self.hits, self.fields),
            "field_box_lenient_hits": share(self.lenient_hits, self.fields),
            "confidence_of_read_words": self.confidence_read / self.read if self.read else 0.0,
            "confidence_of_wrong_words": self.confidence_missed / self.read if self.read else 0.0,
            "seconds_per_document": self.seconds / self.read if self.read else 0.0,
        }


def summarise(results: Sequence[CaseResult]) -> dict[str, Summary]:
    """Group the results by the kind of document, and add a line for all of them."""
    groups: dict[str, Summary] = defaultdict(Summary)
    for result in results:
        groups[result.kind].add(result)
        groups["all"].add(result)
    return dict(sorted(groups.items(), key=lambda entry: (entry[0] == "all", entry[0])))


def by_field_kind(results: Sequence[CaseResult]) -> dict[str, dict[str, float]]:
    """Add up the field boxes by the kind of field: how many of each, and how many were located and hit."""
    totals: dict[str, list[int]] = defaultdict(lambda: [0, 0, 0, 0])
    for result in results:
        for kind, counts in result.by_field_kind.items():
            for position, count in enumerate(counts):
                totals[kind][position] += count
    return {
        kind: {
            "fields": float(counts[0]),
            "located": share(counts[1], counts[0]),
            "hits": share(counts[2], counts[0]),
            "lenient_hits": share(counts[3], counts[0]),
        }
        for kind, counts in sorted(totals.items())
    }


def render_table(results: Sequence[CaseResult]) -> str:
    """Write the measurement as the plain-text table the command prints and the README quotes."""
    lines = [
        f"{'group':<16}{'docs':>5}{'refused':>8}{'word recall':>13}{'anywhere':>10}{'precision':>11}"
        f"{'located':>9}{'box hit':>9}{'lenient':>9}{'s/doc':>7}",
    ]
    for name, summary in summarise(results).items():
        rows = summary.rows()
        lines.append(
            f"{name:<16}{summary.documents:>5}{summary.refused:>8}{rows['word_recall']:>13.1%}"
            f"{rows['word_recall_anywhere']:>10.1%}{rows['word_precision']:>11.1%}{rows['fields_located']:>9.1%}"
            f"{rows['field_box_hits']:>9.1%}{rows['field_box_lenient_hits']:>9.1%}{rows['seconds_per_document']:>7.1f}"
        )
    lines.append("")
    lines.append(f"{'field kind':<16}{'fields':>7}{'located':>9}{'box hit':>9}{'lenient':>9}")
    for kind, figures in by_field_kind(results).items():
        lines.append(
            f"{kind:<16}{int(figures['fields']):>7}{figures['located']:>9.1%}{figures['hits']:>9.1%}"
            f"{figures['lenient_hits']:>9.1%}"
        )
    everything = summarise(results)["all"].rows()
    lines.append("")
    lines.append(
        f"Confidence: {everything['confidence_of_read_words']:.3f} on words that were read, "
        f"{everything['confidence_of_wrong_words']:.3f} on words that were not."
    )
    refused = [(result.id, result.refused) for result in results if result.refused]
    if refused:
        lines.append("Refused by the reader: " + ", ".join(f"{name} ({code})" for name, code in refused))
    return "\n".join(lines)


def render_report(results: Sequence[CaseResult], seconds: float) -> str:
    """Write the measurement as JSON, with every document's figures, for the record."""
    report = {
        "documents": [asdict(result) for result in results],
        "groups": {name: summary.rows() for name, summary in summarise(results).items()},
        "field_kinds": by_field_kind(results),
        "wall_seconds": round(seconds, 1),
    }
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_report(path: Path, results: Sequence[CaseResult], seconds: float) -> None:
    """Save the JSON report to a file."""
    path.write_text(render_report(results, seconds), encoding="utf-8")


# Where the measured baseline lives, and how far below it a later run may fall before `--check` fails.
BASELINE_FILE = EVALS_DIRECTORY / "ocr-baseline.json"
BASELINE_MARGIN = 0.03
BASELINE_FIGURES = ("word_recall", "fields_located", "field_box_hits")


def baseline_of(results: Sequence[CaseResult]) -> dict[str, dict[str, float]]:
    """Take the figures `--check` holds a later run to: three shares for each kind of document and for all of them."""
    return {
        name: {figure: round(summary.rows()[figure], 4) for figure in BASELINE_FIGURES}
        for name, summary in summarise(results).items()
    }


def write_baseline(results: Sequence[CaseResult], path: Path = BASELINE_FILE) -> None:
    """Record this run as the baseline, with the margin it is held to."""
    document = {"margin": BASELINE_MARGIN, "groups": baseline_of(results)}
    path.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def regressions(results: Sequence[CaseResult], path: Path = BASELINE_FILE) -> list[str]:
    """List every figure that fell more than the margin below the committed baseline; nothing means no regression."""
    recorded = json.loads(path.read_text(encoding="utf-8"))
    margin = float(recorded["margin"])
    now = baseline_of(results)
    problems = []
    for name, figures in recorded["groups"].items():
        if name not in now:
            problems.append(f"{name}: not measured now")
            continue
        for figure, before in figures.items():
            if now[name][figure] < before - margin:
                problems.append(
                    f"{name} {figure}: {now[name][figure]:.3f} is below the baseline {before:.3f} by more than {margin}"
                )
    return problems
