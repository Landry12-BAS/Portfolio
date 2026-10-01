"""Which language a visitor writes in, decided in code wherever code can decide it.

The concierge answers in the visitor's language, and its own wording (lb02/messages.py) is
written in English and Czech, so it has to know which one it is talking to. Asking a model
costs a gateway call, and a visitor's first message is usually plain enough not to need one:

1. Script. A message written in Chinese, Japanese, Korean, Greek, Hebrew or Thai letters is
   told apart by its letters alone; Arabic, Devanagari and Cyrillic mostly are.
2. Letters and words. For Latin script, each language has a few dozen of its commonest
   words (lb02/language_words.yaml) and a few letters no other language here uses: the ě
   and ř of Czech, the ľ of Slovak, the ł of Polish. A message scores one point for each
   common word, two for a greeting or a word that is nearly unmistakable, and two for each
   of those letters.

A message that scores clearly is `certain`. One that scores a little is `likely`: good
enough to open a conversation with, never enough to switch one that is under way. One that
scores nothing, such as "ok" or a name, is left to the model on a first message, and keeps
the conversation's language afterwards.

Czech and Slovak are the hard pair. They share most letters and many words, so the points
that tell them apart are the ones that count: the letters above, and words like chci and
chcem, pro and pre, děkuji and ďakujem.
"""

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Final, Self

from pydantic import Field, StringConstraints, model_validator

from core.data_files import StrictEntry, read_data_file

# Words are runs of letters in any alphabet; digits and underscores split them.
WORD: Final = re.compile(r"[^\W\d_]+")

# The names the prompts use for languages; any other code is used as it is.
LANGUAGE_NAMES: Final = {
    "en": "English",
    "cs": "Czech",
    "sk": "Slovak",
    "de": "German",
    "pl": "Polish",
    "es": "Spanish",
    "fr": "French",
    "it": "Italian",
    "pt": "Portuguese",
    "nl": "Dutch",
    "ru": "Russian",
    "uk": "Ukrainian",
    "el": "Greek",
    "he": "Hebrew",
    "ar": "Arabic",
    "zh": "Chinese",
    "ja": "Japanese",
    "ko": "Korean",
    "th": "Thai",
    "hi": "Hindi",
}

# A lowercase word of two letters or more, as language_words.yaml lists them.
Word = Annotated[str, StringConstraints(min_length=2, max_length=24, pattern=r"^[^\W\d_]+$")]
# A language's two-letter code.
LanguageCode = Annotated[str, StringConstraints(pattern=r"^[a-z]{2}$")]


class LanguageWords(StrictEntry):
    """One language's words and letters, as language_words.yaml lists them."""

    common: list[Word] = Field(min_length=30)
    strong: list[Word] = Field(default_factory=list)
    letters: str = ""

    @model_validator(mode="after")
    def _check_lowercase_and_known(self) -> Self:
        """Require lowercase words, and every strong word to be one the language also lists as common."""
        for word in [*self.common, *self.strong]:
            if word != word.casefold():
                raise ValueError(f"{word!r} must be lowercase")
        for word in self.strong:
            if word not in self.common:
                raise ValueError(f"the strong word {word!r} must also be a common word")
        return self


class WordFile(StrictEntry):
    """The whole of language_words.yaml."""

    languages: dict[LanguageCode, LanguageWords] = Field(min_length=2)


def load_words() -> dict[str, LanguageWords]:
    """Read the word lists that ship next to this module, failing at start-up if one is malformed."""
    return dict(read_data_file(Path(__file__).with_name("language_words.yaml"), WordFile).languages)


WORDS: Final = load_words()


@dataclass(frozen=True)
class Script:
    """An alphabet that names a language, or nearly: where its letters sit in Unicode, and the language to answer in."""

    ranges: tuple[tuple[int, int], ...]
    language: str
    certain: bool


# Checked in this order: Japanese kana before Han, because Japanese text mixes the two.
SCRIPTS: Final = (
    Script(((0x3040, 0x30FF),), "ja", True),
    Script(((0xAC00, 0xD7AF), (0x1100, 0x11FF)), "ko", True),
    Script(((0x4E00, 0x9FFF),), "zh", True),
    Script(((0x0370, 0x03FF),), "el", True),
    Script(((0x0590, 0x05FF),), "he", True),
    Script(((0x0E00, 0x0E7F),), "th", True),
    Script(((0x0600, 0x06FF),), "ar", False),
    Script(((0x0900, 0x097F),), "hi", False),
    Script(((0x0400, 0x04FF),), "ru", False),
)
# Cyrillic letters that separate Ukrainian and Russian from each other.
UKRAINIAN_LETTERS: Final = "іїєґ"
RUSSIAN_LETTERS: Final = "ыэъё"
# The points a message needs: enough to be certain, enough to be likely, and the lead over the runner-up.
CERTAIN_POINTS: Final = 3
LIKELY_POINTS: Final = 2
CERTAIN_LEAD: Final = 2


@dataclass(frozen=True)
class Detection:
    """What the letters and words say: a two-letter language code, and whether that is settled."""

    language: str
    certain: bool


def language_name(code: str) -> str:
    """Return a language's name for a prompt, or the code itself when it isn't one of the known ones."""
    return LANGUAGE_NAMES.get(code, code)


def detect(text: str) -> Detection | None:
    """Work out the language of a message from its letters and words, or None when they don't say."""
    return detect_by_script(text) or detect_latin(text)


def in_script(character: str, script: Script) -> bool:
    """Tell whether a letter sits in one of an alphabet's ranges."""
    return any(low <= ord(character) <= high for low, high in script.ranges)


def detect_by_script(text: str) -> Detection | None:
    """Recognise a message written mostly in an alphabet that names its language, or None for Latin script."""
    letters = [character for character in text if character.isalpha()]
    if not letters:
        return None
    for script in SCRIPTS:
        in_alphabet = sum(in_script(character, script) for character in letters)
        if in_alphabet * 2 >= len(letters):
            return cyrillic(text) if script.language == "ru" else Detection(script.language, script.certain)
    return None


def cyrillic(text: str) -> Detection:
    """Tell Ukrainian from Russian by the letters only one of them uses; with neither, guess Russian and say so."""
    lowered = text.casefold()
    if any(letter in lowered for letter in UKRAINIAN_LETTERS):
        return Detection("uk", True)
    if any(letter in lowered for letter in RUSSIAN_LETTERS):
        return Detection("ru", True)
    return Detection("ru", False)


def detect_latin(text: str) -> Detection | None:
    """Score a Latin-script message against every language's words and letters, and report a clear winner."""
    lowered = text.casefold()
    words = WORD.findall(lowered)
    scores = {language: score_language(entry, words, lowered) for language, entry in WORDS.items()}
    ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    (best, best_points), (_, second_points) = ranked[0], ranked[1]
    if best_points >= CERTAIN_POINTS and best_points - second_points >= CERTAIN_LEAD:
        return Detection(best, True)
    if best_points >= LIKELY_POINTS and best_points > second_points:
        return Detection(best, False)
    return None


def score_language(entry: LanguageWords, words: list[str], lowered: str) -> int:
    """Count a language's points: one for a common word, two for a strong word or a diagnostic letter."""
    common = set(entry.common)
    strong = set(entry.strong)
    points = sum(2 if word in strong else 1 for word in words if word in common)
    return points + 2 * sum(lowered.count(letter) for letter in entry.letters)
