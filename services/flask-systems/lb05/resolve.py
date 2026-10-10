"""Resolving a question before a model reads it: the metrics and slices it names, and the dates it means.

Language models are poor at calendar arithmetic, and a metric defined a little differently in each
answer is a metric nobody can trust. So the first step of the chain is deterministic code. It reads
the question against the semantic layer's own names and synonyms, and against the date phrases
lb05/timeranges.py knows ("last quarter", "this year", "March 2026"), and hands the model plain
facts: which definitions apply, and which dates "last quarter" is. It never changes the question,
and what it reports is names from the layer and from the calendar, never the visitor's words, so it
may go into a trace span.

Matching is by whole words in a row, in lower case. When one phrase sits inside another ("repeat
buyers" inside "lost repeat buyers"), only the longer one counts.
"""

import re
from dataclasses import dataclass
from datetime import date
from typing import Self

from lb05.semantic_layer import DimensionSpec, MetricSpec, SemanticLayer
from lb05.timeranges import TimeRange, named_ranges, quarter_bounds

# A word of the question: letters and digits only, so punctuation and hyphens separate words.
WORD = re.compile(r"[a-z0-9]+")
MONTHS = (
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
)  # fmt: skip
MIN_YEAR = 2000
MAX_YEAR = 2100
# A question that names more date phrases than this is not given the rest: each one costs prompt space.
MAX_RANGES = 6
# The words a question may use for each named range, besides the range's own label.
RANGE_PHRASES: dict[str, tuple[str, ...]] = {
    "this_year": ("year to date", "ytd"),
    "last_quarter_a_year_ago": ("same quarter last year", "same quarter a year ago", "last quarter a year ago"),
    "quarter_before_last": ("two quarters ago", "the quarter before last", "quarter before last"),
    "year_before_last": ("two years ago", "the year before last", "year before last"),
    "last_7_days": ("past 7 days", "last seven days", "past seven days"),
    "last_30_days": ("past 30 days", "last thirty days", "past thirty days"),
    "last_90_days": ("past 90 days", "last ninety days", "past ninety days"),
    "last_12_months": ("past 12 months", "last twelve months", "past twelve months"),
}


@dataclass(frozen=True)
class Resolution:
    """What the question names: the metrics and dimensions from the layer, the date ranges, and the as-of day."""

    metrics: tuple[MetricSpec, ...]
    dimensions: tuple[DimensionSpec, ...]
    ranges: tuple[TimeRange, ...]
    as_of: date

    def metric_names(self) -> str:
        """List the resolved metrics' names, comma-separated, for a trace span."""
        return ",".join(metric.name for metric in self.metrics)

    def dimension_names(self) -> str:
        """List the resolved dimensions' names, comma-separated, for a trace span."""
        return ",".join(dimension.name for dimension in self.dimensions)

    def range_names(self) -> str:
        """List the resolved ranges' names, comma-separated, for a trace span."""
        return ",".join(found.name for found in self.ranges)


@dataclass(frozen=True)
class Span:
    """Where a phrase sits in the question: the positions of its first word and one past its last."""

    start: int
    end: int

    def length(self) -> int:
        """Return how many words the span covers."""
        return self.end - self.start

    def contains(self, other: Self) -> bool:
        """Tell whether this span covers another and is longer than it."""
        return self.start <= other.start and other.end <= self.end and self.length() > other.length()


def words_of(text: str) -> list[str]:
    """Split text into lower-case words."""
    return WORD.findall(text.lower())


def find_phrase(words: list[str], phrase: str) -> list[Span]:
    """Find every place a phrase appears in the question's words, as whole words in a row."""
    wanted = words_of(phrase)
    if not wanted:
        return []
    found: list[Span] = []
    for start in range(len(words) - len(wanted) + 1):
        if words[start : start + len(wanted)] == wanted:
            found.append(Span(start, start + len(wanted)))
    return found


def first_spans(words: list[str], phrases: list[str]) -> list[Span]:
    """Find every span any of the phrases covers."""
    spans: list[Span] = []
    for phrase in phrases:
        spans.extend(find_phrase(words, phrase))
    return spans


def mask(words: list[str], spans: list[Span]) -> list[str]:
    """Blank out the words a span covers, so a phrase already used for a date can't be read again as something else."""
    blanked = list(words)
    for span in spans:
        for position in range(span.start, span.end):
            blanked[position] = "_"
    return blanked


def month_start_and_end(year: int, month: int) -> tuple[date, date]:
    """Return the first and last day of a calendar month."""
    first = date(year, month, 1)
    following = date(year + month // 12, month % 12 + 1, 1)
    return first, date.fromordinal(following.toordinal() - 1)


def explicit_ranges(words: list[str]) -> tuple[list[TimeRange], list[Span]]:
    """Find dates the question spells out: a year (`2025`), a quarter (`Q3 2025`) or a month and year (`March 2026`)."""
    ranges: list[TimeRange] = []
    spans: list[Span] = []
    for position, word in enumerate(words):
        following = words[position + 1] if position + 1 < len(words) else ""
        if word.isdigit() and word[:1] != "0" and MIN_YEAR <= int(word) <= MAX_YEAR:
            year = int(word)
            if position > 0 and (words[position - 1] in MONTHS or re.fullmatch(r"q[1-4]", words[position - 1])):
                continue
            ranges.append(TimeRange(f"year_{year}", str(year), date(year, 1, 1), date(year, 12, 31)))
            spans.append(Span(position, position + 1))
        elif re.fullmatch(r"q[1-4]", word) and following.isdigit() and MIN_YEAR <= int(following) <= MAX_YEAR:
            year, quarter = int(following), int(word[1])
            start, end = quarter_bounds(date(year, 3 * (quarter - 1) + 1, 1))
            ranges.append(TimeRange(f"q{quarter}_{year}", f"Q{quarter} {year}", start, end))
            spans.append(Span(position, position + 2))
        elif word in MONTHS and following.isdigit() and MIN_YEAR <= int(following) <= MAX_YEAR:
            year, month = int(following), MONTHS.index(word) + 1
            start, end = month_start_and_end(year, month)
            ranges.append(TimeRange(f"{word}_{year}", f"{word.capitalize()} {year}", start, end))
            spans.append(Span(position, position + 2))
    return ranges, spans


def named_range_matches(words: list[str], today: date) -> tuple[list[TimeRange], list[Span]]:
    """Find the named ranges ("last quarter", "this year") the question uses; of two that overlap, the longer wins."""
    candidates: list[tuple[TimeRange, Span]] = []
    for found in named_ranges(today).values():
        phrases = [found.label, found.name.replace("_", " "), *RANGE_PHRASES.get(found.name, ())]
        for span in first_spans(words, phrases):
            candidates.append((found, span))
    kept = [(found, span) for found, span in candidates if not any(other.contains(span) for _, other in candidates)]
    ordered = sorted(kept, key=lambda pair: pair[1].start)
    unique: dict[str, tuple[TimeRange, Span]] = {}
    for found, span in ordered:
        unique.setdefault(found.name, (found, span))
    return [pair[0] for pair in unique.values()], [pair[1] for pair in unique.values()]


def metric_terms(metric: MetricSpec) -> list[str]:
    """List the phrases that name a metric: its name, its label and its synonyms."""
    return [metric.name.replace("_", " "), metric.label, *metric.synonyms]


def dimension_terms(dimension: DimensionSpec) -> list[str]:
    """List the phrases that name a slice: its synonyms only, as its bare name is often an ordinary word ("month")."""
    return list(dimension.synonyms)


def resolve_metrics(words: list[str], layer: SemanticLayer) -> list[MetricSpec]:
    """Find the metrics the question names, dropping one whose phrase sits inside another metric's longer phrase."""
    found: list[tuple[MetricSpec, Span]] = []
    for metric in layer.metrics:
        found.extend((metric, span) for span in first_spans(words, metric_terms(metric)))
    kept: dict[str, MetricSpec] = {}
    for metric, span in found:
        if not any(other.contains(span) for _, other in found):
            kept.setdefault(metric.name, metric)
    return list(kept.values())


def resolve_dimensions(words: list[str], layer: SemanticLayer) -> list[DimensionSpec]:
    """Find the slices the question names, by their synonyms."""
    return [dimension for dimension in layer.dimensions if first_spans(words, dimension_terms(dimension))]


def resolve(question: str, layer: SemanticLayer, today: date) -> Resolution:
    """Resolve a question against the layer and the calendar, where `today` is the data's as-of day."""
    words = words_of(question)
    named, named_spans = named_range_matches(words, today)
    explicit, explicit_spans = explicit_ranges(words)
    remaining = mask(words, [*named_spans, *explicit_spans])
    return Resolution(
        metrics=tuple(resolve_metrics(remaining, layer)),
        dimensions=tuple(resolve_dimensions(remaining, layer)),
        ranges=tuple([*named, *explicit][:MAX_RANGES]),
        as_of=today,
    )
