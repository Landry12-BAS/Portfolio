"""Tests for the resolver (lb05/resolve.py): the metrics, slices and dates a question names, before a model reads it."""

from datetime import date

import pytest

from lb05.resolve import (
    MAX_RANGES,
    Resolution,
    Span,
    explicit_ranges,
    find_phrase,
    month_start_and_end,
    resolve,
    words_of,
)
from lb05.semantic_layer import SemanticLayer
from tests.support import DATA_AS_OF


def resolved(question: str, layer: SemanticLayer) -> Resolution:
    """Resolve a question against the real layer, as of the test data's last day."""
    return resolve(question, layer, DATA_AS_OF)


def names(question: str, layer: SemanticLayer) -> tuple[set[str], set[str], dict[str, tuple[date, date]]]:
    """Resolve a question and return its metric names, slice names and ranges (by name, with their ends)."""
    found = resolved(question, layer)
    return (
        {metric.name for metric in found.metrics},
        {dimension.name for dimension in found.dimensions},
        {item.name: (item.start, item.end) for item in found.ranges},
    )


def test_a_metric_and_a_named_range_are_found(layer: SemanticLayer) -> None:
    """The plainest question: one metric, and what 'last quarter' means counted from the data's last day."""
    metrics, dimensions, ranges = names("What was our revenue last quarter?", layer)
    assert metrics == {"revenue"}
    assert dimensions == set()
    assert ranges == {"last_quarter": (date(2026, 7, 1), date(2026, 9, 30))}


def test_the_headline_question_resolves_to_lost_repeat_buyers_not_repeat_buyers(layer: SemanticLayer) -> None:
    """'Lost the most repeat buyers' names the longer metric, so the shorter one inside it does not count."""
    metrics, _, ranges = names("Which coffees lost the most repeat buyers last quarter?", layer)
    assert metrics == {"lost_repeat_buyers"}
    assert "last_quarter" in ranges


def test_repeat_buyers_alone_are_repeat_buyers(layer: SemanticLayer) -> None:
    """Without 'lost', the same words name the other metric."""
    metrics, _, _ = names("How many repeat buyers did Kenya Nyeri have?", layer)
    assert metrics == {"repeat_buyers"}


def test_a_slice_is_found_by_its_synonyms(layer: SemanticLayer) -> None:
    """'Monthly' and 'per country' name the month and country slices."""
    _, dimensions, ranges = names("Show monthly revenue per country for 2025", layer)
    assert dimensions == {"month", "customer_country"}
    assert ranges == {"year_2025": (date(2025, 1, 1), date(2025, 12, 31))}


def test_a_date_phrase_is_not_read_again_as_a_slice(layer: SemanticLayer) -> None:
    """'Last month' is a range, so the word 'month' in it does not make a month slice; 'by month' does."""
    assert names("What was revenue last month?", layer)[1] == set()
    assert names("What was revenue by month?", layer)[1] == {"month"}


def test_an_explicit_quarter_a_month_and_a_year(layer: SemanticLayer) -> None:
    """Dates the question spells out are resolved too, and a month's year is not also read as a year."""
    _, _, quarter = names("Average order value in Q3 2026", layer)
    assert quarter == {"q3_2026": (date(2026, 7, 1), date(2026, 9, 30))}
    _, _, month = names("How many customers signed up in March 2026?", layer)
    assert month == {"march_2026": (date(2026, 3, 1), date(2026, 3, 31))}
    assert names("How many customers signed up in March 2026?", layer)[0] == {"new_customers"}


def test_several_ranges_in_one_question(layer: SemanticLayer) -> None:
    """A comparison names two ranges, and both are given."""
    _, _, ranges = names("Compare revenue this year with last year", layer)
    assert set(ranges) == {"this_year", "last_year"}
    assert ranges["last_year"] == (date(2025, 1, 1), date(2025, 12, 31))


def test_the_longer_date_phrase_wins(layer: SemanticLayer) -> None:
    """'The quarter before last' is not 'last quarter', and 'last quarter a year earlier' is neither."""
    assert set(names("revenue in the quarter before last", layer)[2]) == {"quarter_before_last"}
    assert set(names("revenue last quarter a year earlier", layer)[2]) == {"last_quarter_a_year_ago"}
    assert set(names("orders in the last 30 days", layer)[2]) == {"last_30_days"}


def test_a_question_with_nothing_to_resolve_resolves_to_nothing(layer: SemanticLayer) -> None:
    """The model is left to it: the resolver adds nothing that is not there."""
    metrics, dimensions, ranges = names("What is the meaning of life?", layer)
    assert (metrics, dimensions, ranges) == (set(), set(), {})


def test_case_and_punctuation_do_not_matter(layer: SemanticLayer) -> None:
    """Words are matched in lower case, and hyphens and punctuation only separate them."""
    metrics, _, ranges = names("REVENUE?! (last-quarter)", layer)
    assert metrics == {"revenue"}
    assert "last_quarter" in ranges


def test_a_question_cannot_ask_for_more_ranges_than_a_prompt_has_room_for(layer: SemanticLayer) -> None:
    """Many dates in one question are cut to the first few."""
    found = resolved("2018 2019 2020 2021 2022 2023 2024 2025", layer)
    assert len(found.ranges) == MAX_RANGES


def test_years_outside_the_calendar_the_data_could_have_are_ignored() -> None:
    """A number that is not a plausible year is just a number."""
    ranges, _ = explicit_ranges(words_of("1999 2101 12345"))
    assert ranges == []


def test_the_names_are_listed_for_a_trace_span(layer: SemanticLayer) -> None:
    """The resolution reports names from the layer and the calendar: nothing the visitor typed."""
    found = resolved("revenue by month last quarter", layer)
    assert found.metric_names() == "revenue"
    assert found.dimension_names() == "month"
    assert found.range_names() == "last_quarter"
    assert found.as_of == DATA_AS_OF


def test_phrases_are_found_as_whole_words_in_a_row() -> None:
    """A phrase matches words in a row, never part of a word or words apart."""
    words = words_of("the revenue of revenues and re venue")
    assert find_phrase(words, "revenue") == [Span(1, 2)]
    assert find_phrase(words, "of revenue") == []
    assert find_phrase(words, "") == []


def test_a_span_contains_only_a_shorter_span_inside_it() -> None:
    """A phrase inside a longer one is dropped; two equal spans are not."""
    assert Span(0, 3).contains(Span(1, 3))
    assert not Span(1, 3).contains(Span(0, 3))
    assert not Span(0, 2).contains(Span(0, 2))


@pytest.mark.parametrize(
    ("year", "month", "last_day"),
    [(2026, 2, 28), (2028, 2, 29), (2026, 12, 31), (2026, 4, 30)],
)
def test_a_month_ends_on_its_last_day(year: int, month: int, last_day: int) -> None:
    """Months of every length, a leap February and December included."""
    assert month_start_and_end(year, month) == (date(year, month, 1), date(year, month, last_day))
