"""Unit tests for the word error rate: the edits between what was said and what was heard."""

from lb09.wer import word_error_rate


def test_the_same_words_have_no_errors_whatever_the_punctuation_and_case() -> None:
    """Folding first means a transcriber is not blamed for commas."""
    measured = word_error_rate("Good morning, everyone. This is Hannah!", "good morning everyone this is hannah")
    assert measured.errors == 0
    assert measured.rate == 0.0
    assert measured.reference_words == 6


def test_each_kind_of_edit_is_counted() -> None:
    """A wrong word, a missing word and an extra word are one substitution, one deletion and one insertion."""
    measured = word_error_rate("roast the colombian first on monday", "roast a colombian on monday please")
    assert (measured.substitutions, measured.deletions, measured.insertions) == (1, 1, 1)
    assert measured.rate == 3 / 6


def test_silence_heard_as_silence_is_perfect_and_words_heard_in_silence_are_all_wrong() -> None:
    """With nothing said, the rate is 0 for nothing heard and 1 for anything heard."""
    assert word_error_rate("", "").rate == 0.0
    assert word_error_rate("", "hello").rate == 1.0
    assert word_error_rate("hello", "").rate == 1.0
