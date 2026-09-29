"""Hybrid search over LB-01's policy passages: keywords and meaning, fused, then reranked.

Two searches run side by side on the English text. Postgres full-text search finds the
passages that share the query's words; pgvector finds the passages whose embedding is
closest to the query's, which catches the same idea put in other words. Reciprocal rank
fusion merges the two rankings without comparing their scores, which measure different
things, and the reranker then reads the query with each finalist to judge how well the
passage answers it.

Each half fails on its own. Without a query vector (lb-embed is pinned to one model and
has no fallback), search runs on keywords alone. Without the reranker, the fused order
stands and no relevance is claimed, so nothing downstream mistakes rank for relevance.
"""

import functools
import logging
import math
import operator
import re
from collections.abc import Sequence
from dataclasses import dataclass, replace
from typing import Protocol

from django.contrib.postgres.search import SearchQuery, SearchRank
from django.db.models import F
from openai import OpenAIError
from pgvector.django import CosineDistance

from lb01.models import EMBEDDING_DIMENSIONS, PolicyPassage

logger = logging.getLogger(__name__)

# How many candidates each half proposes, and how many fused candidates the reranker reads.
CANDIDATES_PER_HALF = 10
RERANK_CANDIDATES = 8
# How many passages a search returns: what the draft may cite.
FINALISTS = 4
# The usual reciprocal rank fusion constant: it keeps one list's top rank from outweighing
# agreement between both lists.
RRF_K = 60
# Words in any language: letters and digits, with inner apostrophes or hyphens.
WORD = re.compile(r"[^\W_]+(?:['-][^\W_]+)*")
# A longer query is cut to this many words, so no query can make a search expensive. It
# is room for a whole ticket, which the search eval also searches by.
MAX_QUERY_WORDS = 64


class RankedDocumentLike(Protocol):
    """One document's place in a ranking, as lb_common.gateway.RankedDocument gives it."""

    @property
    def index(self) -> int:
        """The document's position in the request."""
        ...

    @property
    def relevance_score(self) -> float:
        """How well the document answers the query, from 0 to 1."""
        ...


class SearchModels(Protocol):
    """The two model calls search makes. lb_common.gateway.Gateway provides both."""

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        """Return one embedding vector per text, in order."""
        ...

    def rerank(self, query: str, documents: Sequence[str]) -> Sequence[RankedDocumentLike]:
        """Score how well each document answers the query, best first."""
        ...


@dataclass(frozen=True)
class Hit:
    """One passage search found: how each half ranked it (from 1), and how relevant the reranker judged it."""

    key: str
    keyword_rank: int | None
    vector_rank: int | None
    fused_score: float
    relevance: float | None = None


@dataclass(frozen=True)
class SearchResult:
    """What a search found, best first, and which of its parts took part."""

    hits: list[Hit]
    used_vectors: bool
    reranked: bool

    def passage_keys(self) -> list[str]:
        """Return the keys of the passages found, best first."""
        return [hit.key for hit in self.hits]


def hybrid_search(query: str, vector: Sequence[float] | None, limit: int = FINALISTS) -> SearchResult:
    """Rank passages by keywords and, given a query vector, by meaning, and fuse the two rankings."""
    by_keywords = keyword_ranking(query, CANDIDATES_PER_HALF)
    by_meaning = vector_ranking(vector, CANDIDATES_PER_HALF) if vector is not None else []
    hits = [
        Hit(key, rank_of(key, by_keywords), rank_of(key, by_meaning), score)
        for key, score in fuse([by_keywords, by_meaning])[:limit]
    ]
    return SearchResult(hits=hits, used_vectors=bool(by_meaning), reranked=False)


def keyword_query(query: str) -> SearchQuery | None:
    """Turn a query into a full-text search that matches any of its words, or None when it has none.

    Each word becomes its own stemmed search, joined by OR: a passage needn't contain
    every word to be found, and one that contains more of them ranks higher. Postgres
    drops stop words such as "the" on its own.
    """
    words = WORD.findall(query)[:MAX_QUERY_WORDS]
    if not words:
        return None
    return functools.reduce(operator.or_, (SearchQuery(word, config="english") for word in words))


def keyword_ranking(query: str, limit: int) -> list[str]:
    """Return the keys of the passages that share the query's words, best first."""
    search = keyword_query(query)
    if search is None:
        return []
    ranked = (
        PolicyPassage.objects.filter(search=search)
        .annotate(rank=SearchRank(F("search"), search))
        .order_by("-rank", "key")
        .values_list("key", flat=True)
    )
    return list(ranked[:limit])


def vector_ranking(vector: Sequence[float], limit: int) -> list[str]:
    """Return the keys of the embedded passages closest in meaning to the query vector, best first."""
    if len(vector) != EMBEDDING_DIMENSIONS or not all(math.isfinite(value) for value in vector):
        raise ValueError(f"a query vector is {EMBEDDING_DIMENSIONS} finite numbers")
    ranked = (
        PolicyPassage.objects.filter(embedding__isnull=False)
        .annotate(distance=CosineDistance("embedding", list(vector)))
        .order_by("distance", "key")
        .values_list("key", flat=True)
    )
    return list(ranked[:limit])


def fuse(rankings: Sequence[Sequence[str]], k: int = RRF_K) -> list[tuple[str, float]]:
    """Merge rankings by reciprocal rank fusion: each ranking adds 1 / (k + rank) to a key's score.

    Returns every key with its score, best first; ties go to the key that sorts first,
    so the same inputs always give the same order.
    """
    scores: dict[str, float] = {}
    for ranking in rankings:
        for rank, key in enumerate(ranking, start=1):
            scores[key] = scores.get(key, 0.0) + 1.0 / (k + rank)
    return sorted(scores.items(), key=lambda item: (-item[1], item[0]))


def finalists(found: SearchResult, reranked: list[Hit] | None, limit: int = FINALISTS) -> SearchResult:
    """Keep the best `limit` hits: in the reranker's order when it worked, else in the fused order."""
    if reranked is None:
        return replace(found, hits=found.hits[:limit])
    return SearchResult(hits=reranked[:limit], used_vectors=found.used_vectors, reranked=True)


def rank_of(key: str, ranking: Sequence[str]) -> int | None:
    """Return a key's rank in a ranking, from 1, or None when the ranking doesn't hold it."""
    return ranking.index(key) + 1 if key in ranking else None


def embed_query(query: str, models: SearchModels) -> list[float] | None:
    """Embed the query, or return None when it has no words or lb-embed fails, so search goes on by keywords."""
    if keyword_query(query) is None:
        return None
    try:
        vectors = models.embed([query])
    except OpenAIError:
        logger.warning("lb-embed failed; searching by keywords alone.")
        return None
    return vectors[0]


def rerank_hits(query: str, hits: Sequence[Hit], models: SearchModels) -> list[Hit] | None:
    """Reorder the hits by the reranker's relevance, or return None when lb-rerank fails."""
    if not hits:
        return []
    rows = PolicyPassage.objects.filter(key__in=[hit.key for hit in hits]).values_list("key", "title_en", "text_en")
    documents_by_key = {key: f"{title}. {text}" for key, title, text in rows}
    documents = [documents_by_key[hit.key] for hit in hits]
    try:
        ranking = models.rerank(query, documents)
    except OpenAIError:
        logger.warning("lb-rerank failed; keeping the fused order.")
        return None
    return [replace(hits[document.index], relevance=document.relevance_score) for document in ranking]
