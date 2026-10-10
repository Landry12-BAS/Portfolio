"""Tests for the parts of lb01.search that need no database: fusion, ranks and query words."""

import pytest

from lb01.search import WORD, fuse, keyword_query, rank_of


def test_fusion_rewards_agreement_between_rankings() -> None:
    """A key both rankings place well beats one that only a single ranking places first."""
    fused = fuse([["a", "b", "c"], ["b", "c", "a"]])

    assert [key for key, _ in fused] == ["b", "a", "c"]


def test_fusion_adds_one_over_k_plus_rank() -> None:
    """Each ranking adds 1 / (k + rank) to a key's score."""
    fused = dict(fuse([["a", "b"], ["a"]], k=60))

    assert fused["a"] == pytest.approx(2 / 61)
    assert fused["b"] == pytest.approx(1 / 62)


def test_fusion_breaks_ties_by_key() -> None:
    """Equal scores come back in key order, so the same inputs always give the same ranking."""
    assert [key for key, _ in fuse([["b"], ["a"]])] == ["a", "b"]


def test_one_ranking_alone_keeps_its_order() -> None:
    """Without vectors, fusion leaves the keyword ranking as it was."""
    assert [key for key, _ in fuse([["c", "a", "b"], []])] == ["c", "a", "b"]


def test_rank_of_counts_from_one() -> None:
    """Ranks start at 1, and a key a ranking doesn't hold has none."""
    assert rank_of("b", ["a", "b"]) == 2
    assert rank_of("z", ["a"]) is None


def test_a_keyword_query_needs_a_word() -> None:
    """Punctuation alone makes no query, so no search runs on it."""
    assert keyword_query(" ?! … ") is None
    assert keyword_query("torn bag") is not None


def test_words_are_read_in_any_language() -> None:
    """Accented letters, inner apostrophes and hyphens stay inside their words."""
    assert WORD.findall("Čerstvá káva, don't re-roast!") == ["Čerstvá", "káva", "don't", "re-roast"]
