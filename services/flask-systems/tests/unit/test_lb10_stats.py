"""Tests for the lab's statistics: intervals that are reproducible, a paired verdict that never calls noise a win."""

from lb10.stats import bootstrap_interval, latency_percentiles, paired_comparison, percentile


def test_the_interval_is_reproducible_and_brackets_the_mean() -> None:
    """The same passes give the same interval, which holds the mean and widens for a small sample."""
    passes = [True] * 7 + [False] * 3
    first = bootstrap_interval(passes)
    second = bootstrap_interval(passes)
    assert first == second
    assert first.cases == 10
    assert first.mean == 0.7
    assert first.low <= 0.7 <= first.high
    assert first.high - first.low > 0.3


def test_a_sample_that_all_passes_has_a_degenerate_interval() -> None:
    """Ten of ten resample to ten of ten every time: the interval is a point at 1."""
    interval = bootstrap_interval([True] * 10)
    assert (interval.mean, interval.low, interval.high) == (1.0, 1.0, 1.0)
    assert bootstrap_interval([]).cases == 0


def test_one_changed_case_in_ten_is_no_detectable_difference() -> None:
    """A single case flipping is inside the noise of ten cases, and the verdict says so."""
    production = [True] * 7 + [False] * 3
    edited = [True] * 8 + [False] * 2
    comparison = paired_comparison(edited, production)
    assert comparison.verdict == "no_detectable_difference"
    assert comparison.improved == 1
    assert comparison.regressed == 0
    assert comparison.low <= 0.0 <= comparison.high
    assert round(comparison.difference, 3) == 0.1


def test_every_case_improving_is_better_and_every_case_regressing_is_worse() -> None:
    """A difference on every case leaves zero out of the interval."""
    assert paired_comparison([True] * 10, [False] * 10).verdict == "better"
    assert paired_comparison([False] * 10, [True] * 10).verdict == "worse"


def test_unequal_or_empty_samples_are_not_comparable() -> None:
    """A comparison needs the same cases on both sides."""
    assert paired_comparison([True], [True, False]).verdict == "not_comparable"
    assert paired_comparison([], []).verdict == "not_comparable"


def test_percentiles_interpolate_and_latencies_round() -> None:
    """The median of an even list sits between its middle values; the 95th leans on the slowest."""
    assert percentile([1.0, 3.0], 0.5) == 2.0
    assert percentile([5.0], 0.95) == 5.0
    p50, p95 = latency_percentiles([100, 200, 300, 400, 5000])
    assert p50 == 300
    assert p95 == 4080
    assert latency_percentiles([]) == (0, 0)
