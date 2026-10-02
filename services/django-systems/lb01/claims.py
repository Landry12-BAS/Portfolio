"""The claim check: a draft may state only what its sources say.

It runs on every draft, without a model. A sentence passes when each source it cites is
one the drafter was actually given, and each number it states (a date, a price, a
number of days) appears in the sources it cites. A sentence without sources passes
only as courtesy, such as a greeting or a sign-off: short, with no number in it, and
no word that promises something (a refund, a replacement, a delivery), because an
uncited promise is exactly the invention this check exists to catch. A reply could go
out on its own only when every sentence passes (the LB-01 datasheet); for visitors a
person approves every reply anyway, with the failing sentences marked.
"""

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from enum import StrEnum

from lb01.numbers import numbers_and_codes
from lb01.prompts import DraftSentence

# The longest sentence that may go without a source, such as a greeting or a sign-off.
MAX_COURTESY_CHARS = 80
# The beginnings of words that promise something, in English and in Czech: money back, a
# replacement, a delivery, a cancellation. An uncited sentence that uses one is a claim.
PROMISE_WORDS = re.compile(
    r"\b(?:refund|replac|free|credit|compensat|discount|voucher|cancel|return|exchang|deliver|ship|send|sent"
    r"|guarant|warrant|vrát|vrác|náhrad|zdarma|slev|kredit|dobropis|zruš|vyměn|výměn|doruč|odešl|pošl|záruk)",
    re.IGNORECASE,
)


class ProblemCode(StrEnum):
    """What is wrong with a sentence, as a stable code each language words for itself."""

    UNCITED_FACT = "uncited_fact"
    UNKNOWN_SOURCE = "unknown_source"
    UNSTATED_NUMBERS = "unstated_numbers"


@dataclass(frozen=True)
class ClaimProblem:
    """One sentence's problem: its code, and the sources or numbers the code is about."""

    code: ProblemCode
    items: tuple[str, ...] = ()


# How each problem reads to a person, by language. The agent console shows the visitor's own
# language, so a Czech visitor never reads an English explanation.
PROBLEM_TEXT: dict[str, dict[ProblemCode, str]] = {
    "en": {
        ProblemCode.UNCITED_FACT: "states a fact without citing a source",
        ProblemCode.UNKNOWN_SOURCE: "cites a source it wasn't given: {items}",
        ProblemCode.UNSTATED_NUMBERS: "states {items}, which its sources don't",
    },
    "cs": {
        ProblemCode.UNCITED_FACT: "uvádí tvrzení bez zdroje",
        ProblemCode.UNKNOWN_SOURCE: "cituje zdroj, který nedostal: {items}",
        ProblemCode.UNSTATED_NUMBERS: "uvádí {items}, což jeho zdroje neobsahují",
    },
}


def describe_problem(problem: ClaimProblem, language: str = "en") -> str:
    """Word a problem in a language, falling back to English for one the table doesn't cover."""
    templates = PROBLEM_TEXT.get(language, PROBLEM_TEXT["en"])
    return templates[problem.code].format(items=", ".join(problem.items))


@dataclass(frozen=True)
class ClaimCheck:
    """Which sentences of a draft its sources support, and what is wrong with the others."""

    unsupported: list[int] = field(default_factory=list)
    problems: dict[int, ClaimProblem] = field(default_factory=dict)

    @property
    def supported(self) -> bool:
        """Tell whether every sentence passed."""
        return not self.unsupported

    @property
    def reasons(self) -> dict[int, str]:
        """Word every problem in English, as the logs and the stored draft keep it."""
        return {index: describe_problem(problem) for index, problem in self.problems.items()}


def check_claims(sentences: Sequence[DraftSentence], sources: Mapping[str, str]) -> ClaimCheck:
    """Check each sentence against the sources the drafter was given, by ID and by the numbers it states."""
    problems: dict[int, ClaimProblem] = {}
    for index, sentence in enumerate(sentences):
        problem = sentence_problem(sentence, sources)
        if problem is not None:
            problems[index] = problem
    return ClaimCheck(unsupported=sorted(problems), problems=problems)


def sentence_problem(sentence: DraftSentence, sources: Mapping[str, str]) -> ClaimProblem | None:
    """Say what is wrong with one sentence, or return None when its sources support it."""
    stated = numbers_and_codes(sentence.text)
    if not sentence.sources:
        if stated or len(sentence.text) > MAX_COURTESY_CHARS or PROMISE_WORDS.search(sentence.text):
            return ClaimProblem(ProblemCode.UNCITED_FACT)
        return None
    unknown = [source for source in sentence.sources if source not in sources]
    if unknown:
        return ClaimProblem(ProblemCode.UNKNOWN_SOURCE, tuple(unknown))
    cited: set[str] = set()
    for source in sentence.sources:
        cited |= numbers_and_codes(sources[source])
    missing = sorted(stated - cited)
    if missing:
        return ClaimProblem(ProblemCode.UNSTATED_NUMBERS, tuple(missing))
    return None
