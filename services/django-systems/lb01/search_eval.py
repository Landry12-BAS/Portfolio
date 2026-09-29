"""Retrieval recall on the golden set: how often search brings every passage a reply should cite within reach.

Each golden case that expects citations is searched two ways:

- by its `query`, the English search query a good classifier writes, which measures
  search itself;
- by its ticket, the customer's own words in English or Czech, which measures how
  well search copes without the classifier's help. English keywords can't match a
  Czech ticket; the multilingual embedding can, and this is where fusion earns its keep.

A case counts as found at k when every expected passage is among the first k results.
Recall at 4 is what a draft gets to read; recall at 8 is what the reranker can choose
from, the ceiling for the final four.

No model is called. Keyword search needs none, and hybrid search uses the vectors
recorded in evals/lb01/query-embeddings.json, with the passage vectors the seed loaded.
The gate in evals/lb01/search-baseline.yaml holds each number to its last measured value.
"""

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from django.conf import settings
from pydantic import Field

from core.data_files import StrictEntry, read_data_file
from lb01.embeddings import EmbeddingFile, read_embedding_file
from lb01.golden import GoldenSet
from lb01.search import RERANK_CANDIDATES, hybrid_search

# The depths recall is measured at: what the draft reads, and what the reranker reads.
DRAFT_DEPTH = 4
RERANK_DEPTH = RERANK_CANDIDATES

# What a case is searched by: the classifier's English query, or the customer's ticket.
type QuerySource = Literal["query", "ticket"]
QUERY_SOURCES: tuple[QuerySource, ...] = ("query", "ticket")
# Which search runs: keywords alone, or keywords and vectors fused.
type SearchMode = Literal["keyword", "hybrid"]


class Recall(StrictEntry):
    """Recall at the two depths that matter, each from 0 to 1."""

    recall_at_4: float = Field(ge=0.0, le=1.0)
    recall_at_8: float = Field(ge=0.0, le=1.0)


class SourceBaseline(StrictEntry):
    """The lowest recall allowed for one query source. Hybrid stays unset until vectors are recorded."""

    keyword: Recall
    hybrid: Recall | None = None


class SearchBaseline(StrictEntry):
    """The retrieval gate, for both query sources."""

    query: SourceBaseline
    ticket: SourceBaseline

    def for_source(self, source: QuerySource) -> SourceBaseline:
        """Return the baseline for one query source."""
        return self.query if source == "query" else self.ticket


@dataclass(frozen=True)
class GradedCase:
    """A golden case whose retrieval is graded: what it is searched by, and the passages it expects."""

    case_id: str
    query: str
    ticket: str
    expected: tuple[str, ...]

    def text(self, source: QuerySource) -> str:
        """Return what the case is searched by from one source."""
        return self.query if source == "query" else self.ticket


@dataclass(frozen=True)
class CaseResult:
    """What search returned for one golden case, next to what the case expects it to find."""

    case_id: str
    expected: tuple[str, ...]
    ranked: tuple[str, ...]

    def found_at(self, depth: int) -> bool:
        """Tell whether every expected passage is within the first `depth` results."""
        return set(self.expected) <= set(self.ranked[:depth])


@dataclass(frozen=True)
class RecallReport:
    """One query source and search mode's results over the golden set."""

    source: QuerySource
    mode: SearchMode
    cases: list[CaseResult]

    def recall_at(self, depth: int) -> float:
        """Return the share of cases whose expected passages are all within the first `depth` results."""
        if not self.cases:
            return 0.0
        return sum(case.found_at(depth) for case in self.cases) / len(self.cases)

    def misses_at(self, depth: int) -> list[CaseResult]:
        """Return the cases that miss at least one expected passage within the first `depth` results."""
        return [case for case in self.cases if not case.found_at(depth)]

    def as_recall(self) -> Recall:
        """Give the report as the baseline keeps it: three places, rounded down, so a gate never asks for more."""
        return Recall(
            recall_at_4=round_down(self.recall_at(DRAFT_DEPTH)), recall_at_8=round_down(self.recall_at(RERANK_DEPTH))
        )


def round_down(value: float) -> float:
    """Cut a recall to three decimal places without rounding it up."""
    return math.floor(value * 1_000) / 1_000


def recorded_key(case_id: str, source: QuerySource) -> str:
    """Return the key a case's recorded vector has in query-embeddings.json, such as `torn-bag.ticket`."""
    return f"{case_id}.{source}"


def graded_cases(golden: GoldenSet) -> list[GradedCase]:
    """Return every golden case that expects citations, with its query and its ticket."""
    graded: list[GradedCase] = []
    for case in golden.cases:
        if case.expect.cites and case.expect.query is not None:
            graded.append(GradedCase(case.id, case.expect.query, case.ticket, tuple(case.expect.cites)))
    return graded


def texts_to_record(golden: GoldenSet) -> dict[str, str]:
    """Return every text the search eval needs a vector for, keyed as query-embeddings.json keys it."""
    texts: dict[str, str] = {}
    for case in graded_cases(golden):
        for source in QUERY_SOURCES:
            texts[recorded_key(case.case_id, source)] = case.text(source)
    return texts


def measure(golden: GoldenSet, query_vectors: EmbeddingFile | None) -> list[RecallReport]:
    """Measure keyword recall for both query sources, and hybrid recall for each source fully recorded.

    Run it against a database seeded from data/seed/lb01, so the passages carry the
    vectors recorded for them.
    """
    graded = graded_cases(golden)
    reports: list[RecallReport] = []
    for source in QUERY_SOURCES:
        vectors = recorded_vectors(graded, source, query_vectors)
        keyword = RecallReport(source, "keyword", [])
        hybrid = RecallReport(source, "hybrid", []) if graded and len(vectors) == len(graded) else None
        for case in graded:
            text = case.text(source)
            keyword.cases.append(CaseResult(case.case_id, case.expected, tuple(search_keys(text, None))))
            if hybrid is not None:
                hybrid.cases.append(
                    CaseResult(case.case_id, case.expected, tuple(search_keys(text, vectors[case.case_id])))
                )
        reports.append(keyword)
        if hybrid is not None:
            reports.append(hybrid)
    return reports


def recorded_vectors(
    graded: list[GradedCase], source: QuerySource, recorded: EmbeddingFile | None
) -> dict[str, list[float]]:
    """Return each case's recorded vector for one source, where one matches the case's current text."""
    vectors: dict[str, list[float]] = {}
    if recorded is None:
        return vectors
    for case in graded:
        vector = recorded.vector_for(recorded_key(case.case_id, source), case.text(source))
        if vector is not None:
            vectors[case.case_id] = vector
    return vectors


def search_keys(text: str, vector: list[float] | None) -> list[str]:
    """Search for a text, by keywords alone or fused with its vector, and return the keys found."""
    return hybrid_search(text, vector, limit=RERANK_DEPTH).keys()


def read_query_vectors(path: Path | None = None) -> EmbeddingFile | None:
    """Read the recorded golden-set vectors, by default evals/lb01/query-embeddings.json, if recorded."""
    return read_embedding_file(path or settings.EVALS_DIR / "lb01" / "query-embeddings.json")


def read_baseline(path: Path | None = None) -> SearchBaseline:
    """Read the retrieval gate, by default evals/lb01/search-baseline.yaml."""
    return read_data_file(path or settings.EVALS_DIR / "lb01" / "search-baseline.yaml", SearchBaseline)
