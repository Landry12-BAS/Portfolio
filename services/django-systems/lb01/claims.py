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


@dataclass(frozen=True)
class ClaimCheck:
    """Which sentences of a draft its sources support, and why the others failed."""

    unsupported: list[int] = field(default_factory=list)
    reasons: dict[int, str] = field(default_factory=dict)

    @property
    def supported(self) -> bool:
        """Tell whether every sentence passed."""
        return not self.unsupported


def check_claims(sentences: Sequence[DraftSentence], sources: Mapping[str, str]) -> ClaimCheck:
    """Check each sentence against the sources the drafter was given, by ID and by the numbers it states."""
    reasons: dict[int, str] = {}
    for index, sentence in enumerate(sentences):
        problem = sentence_problem(sentence, sources)
        if problem is not None:
            reasons[index] = problem
    return ClaimCheck(unsupported=sorted(reasons), reasons=reasons)


def sentence_problem(sentence: DraftSentence, sources: Mapping[str, str]) -> str | None:
    """Say what is wrong with one sentence, or return None when its sources support it."""
    stated = numbers_and_codes(sentence.text)
    if not sentence.sources:
        if stated or len(sentence.text) > MAX_COURTESY_CHARS or PROMISE_WORDS.search(sentence.text):
            return "states a fact without citing a source"
        return None
    unknown = [source for source in sentence.sources if source not in sources]
    if unknown:
        return f"cites a source it wasn't given: {', '.join(unknown)}"
    cited: set[str] = set()
    for source in sentence.sources:
        cited |= numbers_and_codes(sources[source])
    missing = sorted(stated - cited)
    if missing:
        return f"states {', '.join(missing)}, which its sources don't"
    return None
