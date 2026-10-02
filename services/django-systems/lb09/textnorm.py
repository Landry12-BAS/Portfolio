"""Comparing words the way a person reads them: without case, punctuation or the differences between quotes.

Every rule that matches text with text goes through `fold`: a quote the model gives has to be found in the
transcript, a golden item is paired with an extracted one by its words, and a name has to appear in what was
said. Folding both sides the same way means "I'll" with either apostrophe, "re-profile" and "re profile", and
"Sure," and "sure" are the same words, while a quote that is not in the transcript stays not in it.
"""

import unicodedata


def fold(text: str) -> str:
    """Reduce text to lowercase words separated by single spaces.

    Letters and digits are kept, folded to lowercase; every other character, a hyphen, an apostrophe of either
    shape or a full stop, is a gap between words.
    """
    kept = [character if character.isalnum() else " " for character in unicodedata.normalize("NFKC", text).casefold()]
    return " ".join("".join(kept).split())


def words_of(text: str) -> list[str]:
    """Return the folded words of a text, in order."""
    return fold(text).split()


def has_all_words(text: str, words: list[str]) -> bool:
    """Tell whether a text holds every one of the words, read as parts of words so "order" is in "ordering"."""
    folded = fold(text)
    return all(fold(word) in folded for word in words)
