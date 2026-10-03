"""Word error rate: how many words a transcriber got wrong, over the words that were said.

The usual measure of a transcriber: the fewest insertions, deletions and substitutions that turn the
words it heard into the words of the script, divided by the script's words, after both are folded
(lb09/textnorm.py) so that case and punctuation count for nothing. `just wer-lb09` measures each committed
meeting's audio with a real transcriber; this is the arithmetic, which needs neither.
"""

from dataclasses import dataclass

from lb09.textnorm import words_of


@dataclass(frozen=True)
class WordErrors:
    """The edits between what was said and what was heard, and the rate they add up to."""

    reference_words: int
    substitutions: int
    deletions: int
    insertions: int

    @property
    def errors(self) -> int:
        """Return how many edits there were."""
        return self.substitutions + self.deletions + self.insertions

    @property
    def rate(self) -> float:
        """Return the word error rate: edits over the words said; 0 for silence heard as silence."""
        if self.reference_words == 0:
            return 0.0 if self.insertions == 0 else 1.0
        return self.errors / self.reference_words


def word_error_rate(reference: str, hypothesis: str) -> WordErrors:
    """Count the fewest edits that turn the heard words into the said words, with the classic edit distance."""
    said = words_of(reference)
    heard = words_of(hypothesis)
    # cost[i][j]: edits between the first i said words and the first j heard words, with the edit kinds kept.
    rows: list[list[tuple[int, int, int, int]]] = [[(0, 0, 0, 0)] * (len(heard) + 1) for _ in range(len(said) + 1)]
    for i in range(1, len(said) + 1):
        rows[i][0] = (i, 0, i, 0)
    for j in range(1, len(heard) + 1):
        rows[0][j] = (j, 0, 0, j)
    for i in range(1, len(said) + 1):
        for j in range(1, len(heard) + 1):
            if said[i - 1] == heard[j - 1]:
                rows[i][j] = rows[i - 1][j - 1]
                continue
            total, subs, dels, ins = rows[i - 1][j - 1]
            substitute = (total + 1, subs + 1, dels, ins)
            total, subs, dels, ins = rows[i - 1][j]
            delete = (total + 1, subs, dels + 1, ins)
            total, subs, dels, ins = rows[i][j - 1]
            insert = (total + 1, subs, dels, ins + 1)
            rows[i][j] = min(substitute, delete, insert)
    _, subs, dels, ins = rows[len(said)][len(heard)]
    return WordErrors(reference_words=len(said), substitutions=subs, deletions=dels, insertions=ins)
