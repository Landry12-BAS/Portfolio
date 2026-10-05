"""The statistics a run's report rests on, in code and tested: intervals, a paired comparison, percentiles.

Ten cases is a small sample, and a score on ten cases is noise more often than people think. So every score
comes with a bootstrap confidence interval (a seeded generator, a thousand resamples of the cases with
replacement, the 2.5th and 97.5th percentiles of the resampled means), and the comparison with production is
a paired bootstrap of the per-case differences on the same cases: the interval of the difference, and a plain
verdict that says "no detectable difference" when the interval spans zero, rather than calling noise a win.
The generator is seeded from the data, so the same results always give the same interval.
"""

import math
import random
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from lb10.limits import BOOTSTRAP_RESAMPLES, CONFIDENCE_LEVEL

# What a paired comparison says in one word.
type Verdict = Literal["better", "worse", "no_detectable_difference", "not_comparable"]


@dataclass(frozen=True)
class Interval:
    """A score with its confidence interval, all as shares between 0 and 1."""

    mean: float
    low: float
    high: float
    cases: int


@dataclass(frozen=True)
class PairedComparison:
    """How a variant compares with production on the same cases: the difference, its interval, and the verdict."""

    difference: float
    low: float
    high: float
    verdict: Verdict
    improved: int
    regressed: int
    cases: int


def mean(values: Sequence[float]) -> float:
    """Return the mean, or 0 for no values."""
    return sum(values) / len(values) if values else 0.0


def percentile(sorted_values: Sequence[float], share: float) -> float:
    """Return the value at a share of a sorted list, interpolating between neighbours."""
    if not sorted_values:
        return 0.0
    if len(sorted_values) == 1:
        return float(sorted_values[0])
    position = share * (len(sorted_values) - 1)
    below = math.floor(position)
    above = min(below + 1, len(sorted_values) - 1)
    weight = position - below
    return float(sorted_values[below]) * (1 - weight) + float(sorted_values[above]) * weight


def seed_from(values: Sequence[float]) -> int:
    """Make the bootstrap's seed from the data, so the same results always give the same interval."""
    return hash(tuple(round(value, 6) for value in values)) & 0xFFFFFFFF


def resampled_means(values: Sequence[float], resamples: int, seed: int) -> list[float]:
    """Draw `resamples` means of samples with replacement from `values`."""
    generator = random.Random(seed)  # noqa: S311 - a reproducible bootstrap, not a secret
    size = len(values)
    return [mean(generator.choices(values, k=size)) for _ in range(resamples)]


def bootstrap_interval(passes: Sequence[bool], resamples: int = BOOTSTRAP_RESAMPLES) -> Interval:
    """Return the share of passing cases with its bootstrap confidence interval."""
    values = [1.0 if passed else 0.0 for passed in passes]
    if not values:
        return Interval(0.0, 0.0, 0.0, 0)
    means = sorted(resampled_means(values, resamples, seed_from(values)))
    tail = (1 - CONFIDENCE_LEVEL) / 2
    return Interval(mean(values), percentile(means, tail), percentile(means, 1 - tail), len(values))


def paired_comparison(
    variant: Sequence[bool], production: Sequence[bool], resamples: int = BOOTSTRAP_RESAMPLES
) -> PairedComparison:
    """Compare a variant with production case by case: a paired bootstrap of the differences, and the verdict.

    Both sequences list the same cases in the same order. The verdict is `better` or `worse` only when the
    interval of the mean difference leaves zero out; otherwise the difference is not detectable on this
    sample, whatever the two scores say.
    """
    if len(variant) != len(production) or not variant:
        return PairedComparison(0.0, 0.0, 0.0, "not_comparable", 0, 0, 0)
    differences = [float(after) - float(before) for after, before in zip(variant, production, strict=True)]
    means = sorted(resampled_means(differences, resamples, seed_from(differences)))
    tail = (1 - CONFIDENCE_LEVEL) / 2
    low, high = percentile(means, tail), percentile(means, 1 - tail)
    verdict: Verdict = "no_detectable_difference"
    if low > 0:
        verdict = "better"
    elif high < 0:
        verdict = "worse"
    return PairedComparison(
        difference=mean(differences),
        low=low,
        high=high,
        verdict=verdict,
        improved=sum(1 for difference in differences if difference > 0),
        regressed=sum(1 for difference in differences if difference < 0),
        cases=len(differences),
    )


def latency_percentiles(latencies_ms: Sequence[int]) -> tuple[int, int]:
    """Return the median and the 95th percentile of a run's latencies, in milliseconds."""
    ordered = sorted(float(value) for value in latencies_ms)
    return round(percentile(ordered, 0.5)), round(percentile(ordered, 0.95))
