"""The ten cases a visitor run uses: a fixed, seeded, stratified sample of a pack.

A visitor run can afford ten cases (the datasheet). Which ten matters: a sample of easy cases alone
would flatter every prompt, and a sample that changed from run to run would make two visitors' scores
incomparable and the cached production baseline useless. So the sample is drawn once per pack version
with a random generator seeded from that version, and it is stratified: every hard case is drawn from
first, then the rest in proportion, so the hard cases are always in it. The same pack always gives the
same ten, and a changed pack gives a new ten with a new baseline.
"""

import random
from collections.abc import Sequence

from lb10.packs import Difficulty, EvalPack, PackCase

# How many cases a visitor run uses (the LB-10 datasheet), and the least of them that must be hard.
SAMPLE_SIZE = 10
MIN_HARD = 3
# The order in which the strata are filled when the proportions leave places over.
STRATA: tuple[Difficulty, ...] = ("hard", "medium", "easy")


def seed_of(version: str) -> int:
    """Turn a pack version (hex digits) into the seed of its sample."""
    return int(version, 16)


def by_difficulty(cases: Sequence[PackCase]) -> dict[Difficulty, list[PackCase]]:
    """Group cases by difficulty, keeping the pack's order inside each group."""
    groups: dict[Difficulty, list[PackCase]] = {"hard": [], "medium": [], "easy": []}
    for case in cases:
        groups[case.difficulty].append(case)
    return groups


def places_per_stratum(groups: dict[Difficulty, list[PackCase]], size: int) -> dict[Difficulty, int]:
    """Decide how many places each difficulty gets: hard first (its share, or MIN_HARD), the rest in proportion.

    Every stratum gets at most as many places as it has cases, and the places left over by a short
    stratum go to the others, hard ones first.
    """
    total = sum(len(group) for group in groups.values())
    places: dict[Difficulty, int] = {}
    for difficulty in STRATA:
        share = round(size * len(groups[difficulty]) / total) if total else 0
        wanted = max(share, MIN_HARD) if difficulty == "hard" else share
        places[difficulty] = min(wanted, len(groups[difficulty]))
    left = size - sum(places.values())
    for difficulty in STRATA:
        room = len(groups[difficulty]) - places[difficulty]
        extra = min(max(left, 0), room)
        places[difficulty] += extra
        left -= extra
    while sum(places.values()) > size:
        for difficulty in reversed(STRATA):
            if places[difficulty] > (MIN_HARD if difficulty == "hard" else 0) and sum(places.values()) > size:
                places[difficulty] -= 1
    return places


def sample_cases(pack: EvalPack, size: int = SAMPLE_SIZE) -> list[PackCase]:
    """Draw the pack's fixed sample: `size` cases, stratified by difficulty, in the pack's order."""
    if len(pack.cases) <= size:
        return list(pack.cases)
    generator = random.Random(seed_of(pack.version()))  # noqa: S311 - a reproducible sample, not a secret
    groups = by_difficulty(pack.cases)
    places = places_per_stratum(groups, size)
    chosen_ids: set[str] = set()
    for difficulty in STRATA:
        drawn = generator.sample(groups[difficulty], places[difficulty])
        chosen_ids.update(case.id for case in drawn)
    return [case for case in pack.cases if case.id in chosen_ids]
