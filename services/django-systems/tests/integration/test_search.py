"""Integration tests for LB-01's hybrid search, on the seeded policy corpus in a real Postgres.

Each passage gets a one-hot stand-in vector, so a query vector points at exactly one
passage and the tests can tell which half of search found what. The model calls go to
fakes that behave like lb-embed and lb-rerank, including when they fail.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date

import pytest
from django.conf import settings

from lb01.models import PolicyPassage
from lb01.search import (
    FINALISTS,
    RERANK_CANDIDATES,
    hybrid_search,
    keyword_ranking,
    search_policies,
    vector_ranking,
)
from lb01.seed import seed
from lb_common.gateway import GatewayResponseError
from tests.support import one_hot

pytestmark = [pytest.mark.integration, pytest.mark.django_db(databases=["lb01"])]


@dataclass(frozen=True)
class FakeRanked:
    """One document's place in a fake ranking."""

    index: int
    relevance_score: float


@dataclass
class FakeModels:
    """Stands in for the gateway's lb-embed and lb-rerank, and remembers every call.

    The fake reranker prefers documents later in the request, so a reranked result is
    visibly different from the fused order it was given.
    """

    vector: list[float] | None = None
    embed_fails: bool = False
    rerank_fails: bool = False
    embedded: list[list[str]] = field(default_factory=list)
    reranked: list[tuple[str, list[str]]] = field(default_factory=list)

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        """Return the fake's vector for the query, or fail like an unavailable provider."""
        self.embedded.append(list(texts))
        if self.embed_fails or self.vector is None:
            raise GatewayResponseError("lb-embed is unavailable.")
        return [self.vector]

    def rerank(self, query: str, documents: Sequence[str]) -> list[FakeRanked]:
        """Score later documents higher, or fail like an unavailable provider."""
        self.reranked.append((query, list(documents)))
        if self.rerank_fails:
            raise GatewayResponseError("lb-rerank is unavailable.")
        scores = [FakeRanked(index, (index + 1) / len(documents)) for index in range(len(documents))]
        return sorted(scores, key=lambda ranked: ranked.relevance_score, reverse=True)


@pytest.fixture
def corpus() -> list[str]:
    """Seed the real policy corpus, give each passage a one-hot vector, and return the keys in vector order."""
    seed(settings.SEED_DIR / "lb01", date(2026, 10, 1))
    keys = list(PolicyPassage.objects.order_by("key").values_list("key", flat=True))
    for position, key in enumerate(keys):
        PolicyPassage.objects.filter(key=key).update(embedding=one_hot(position))
    return keys


def pointing_at(corpus: list[str], key: str) -> list[float]:
    """Return a query vector whose closest passage is `key`."""
    return one_hot(corpus.index(key))


@pytest.mark.usefixtures("corpus")
def test_keyword_ranking_finds_passages_that_share_the_querys_words() -> None:
    """Stemmed words find their passage: `bags arriving torn` finds Torn or crushed bags."""
    assert keyword_ranking("bags arriving torn", 10)[0] == "damaged.torn-bags"


@pytest.mark.usefixtures("corpus")
def test_keyword_ranking_finds_nothing_without_a_real_word() -> None:
    """Stop words alone match nothing."""
    assert keyword_ranking("the and of", 10) == []


def test_vector_ranking_puts_the_closest_passage_first(corpus: list[str]) -> None:
    """The passage whose vector the query's points at comes first."""
    assert vector_ranking(pointing_at(corpus, "coffee.storage"), 10)[0] == "coffee.storage"


@pytest.mark.usefixtures("corpus")
def test_vector_ranking_skips_passages_without_a_vector() -> None:
    """A passage waiting for `just embed` is never ranked by meaning."""
    PolicyPassage.objects.exclude(key="coffee.storage").update(embedding=None)

    assert vector_ranking(one_hot(0), 10) == ["coffee.storage"]


@pytest.mark.usefixtures("corpus")
def test_vector_ranking_refuses_a_malformed_vector() -> None:
    """A vector of the wrong size never reaches the database."""
    with pytest.raises(ValueError, match="finite numbers"):
        vector_ranking([1.0, 2.0], 10)


def test_hybrid_search_finds_by_meaning_what_keywords_cant(corpus: list[str]) -> None:
    """A Czech query shares no English words with its passage, and its vector finds it anyway."""
    result = hybrid_search("Ve které dny pražíte?", pointing_at(corpus, "shipping.roast-days"))

    assert result.keys()[0] == "shipping.roast-days"
    assert (result.hits[0].keyword_rank, result.hits[0].vector_rank) == (None, 1)
    assert result.used_vectors
    assert not result.reranked


@pytest.mark.usefixtures("corpus")
def test_hybrid_search_without_a_vector_is_keyword_search() -> None:
    """Without a query vector, search runs on keywords and says so."""
    result = hybrid_search("bags arriving torn", None)

    assert result.keys()[0] == "damaged.torn-bags"
    assert not result.used_vectors


def test_a_passage_both_halves_agree_on_comes_first(corpus: list[str]) -> None:
    """When keywords and the vector both rank a passage first, fusion keeps it first."""
    result = hybrid_search("bags arriving torn", pointing_at(corpus, "damaged.torn-bags"))

    top = result.hits[0]
    assert (top.key, top.keyword_rank, top.vector_rank) == ("damaged.torn-bags", 1, 1)


def test_search_reranks_the_fused_candidates(corpus: list[str]) -> None:
    """The reranker reads the fused candidates, English title and text, and its order decides."""
    models = FakeModels(vector=pointing_at(corpus, "damaged.torn-bags"))

    result = search_policies("bags arriving torn", models)

    query, documents = models.reranked[0]
    assert query == "bags arriving torn"
    assert len(documents) == RERANK_CANDIDATES
    assert documents[0].startswith("Torn or crushed bags. If a bag arrives torn")
    assert result.reranked
    assert result.used_vectors
    assert len(result.hits) == FINALISTS
    relevances = [hit.relevance for hit in result.hits if hit.relevance is not None]
    assert len(relevances) == FINALISTS
    assert relevances == sorted(relevances, reverse=True)
    assert result.keys()[0] != "damaged.torn-bags"


@pytest.mark.usefixtures("corpus")
def test_search_goes_on_by_keywords_when_embedding_fails() -> None:
    """lb-embed has no fallback, so its failure leaves keywords and the reranker to do the work."""
    models = FakeModels(embed_fails=True)

    result = search_policies("bags arriving torn", models)

    _, documents = models.reranked[0]
    assert documents[0].startswith("Torn or crushed bags.")
    assert not result.used_vectors
    assert result.reranked


def test_search_keeps_the_fused_order_when_reranking_fails(corpus: list[str]) -> None:
    """Without the reranker, the fused order stands and no relevance is claimed."""
    models = FakeModels(vector=pointing_at(corpus, "damaged.torn-bags"), rerank_fails=True)

    result = search_policies("bags arriving torn", models)

    assert not result.reranked
    assert result.keys()[0] == "damaged.torn-bags"
    assert len(result.hits) == FINALISTS
    assert all(hit.relevance is None for hit in result.hits)


@pytest.mark.usefixtures("corpus")
def test_a_query_without_words_calls_no_model() -> None:
    """Nothing is searched, and no quota is spent, for a query of punctuation."""
    models = FakeModels(vector=one_hot(0))

    result = search_policies(" ?! ", models)

    assert result.hits == []
    assert (models.embedded, models.reranked) == ([], [])
