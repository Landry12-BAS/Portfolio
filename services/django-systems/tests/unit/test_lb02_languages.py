# ruff: noqa: RUF001 - the test data is text in other alphabets, whose letters look like Latin ones
"""Tests for LB-02's language detection: scripts, letters and words decide what code can, and say so when they can't."""

import pytest

from lb02.golden import read_golden_set
from lb02.languages import WORDS, Detection, detect, language_name

CERTAIN = [
    ("Hi! I'd like to book a cupping session for two people tomorrow afternoon.", "en"),
    ("Please confirm my booking now.", "en"),
    ("What can I book, and how long does each one take?", "en"),
    ("Dobrý den, chtěl bych si rezervovat degustaci kávy pro čtyři osoby zítra večer.", "cs"),
    ("Můžete mi prosím odpovídat česky? Ten termín ve 14:30 chci.", "cs"),
    ("Dobrý deň, chcem si rezervovať degustáciu pre troch ľudí zajtra večer.", "sk"),
    ("Guten Tag, ich möchte einen Röst-Workshop für zwei Personen übermorgen buchen.", "de"),
    ("Hola, quiero reservar una degustación para dos personas mañana, gracias.", "es"),
    ("Bonjour, je voudrais réserver une dégustation pour deux personnes demain.", "fr"),
    ("Ciao, vorrei prenotare una degustazione per due persone domani, grazie.", "it"),
    ("Olá, queria reservar uma degustação para duas pessoas amanhã, obrigado.", "pt"),
    ("Cześć, chcę zarezerwować degustację dla dwóch osób jutro, dziękuję.", "pl"),
    ("Hallo, ik wil graag een proeverij reserveren voor twee personen morgen.", "nl"),
]

SCRIPTS = [
    ("我想预订明天下午的咖啡品鉴，两个人。", "zh", True),
    ("明日の午後にコーヒーのテイスティングを予約したいです。", "ja", True),
    ("내일 오후에 커피 시음을 예약하고 싶어요.", "ko", True),
    ("Θα ήθελα να κλείσω μια δοκιμή καφέ για αύριο.", "el", True),
    ("אני רוצה להזמין טעימות קפה למחר", "he", True),
    ("ฉันอยากจองการชิมกาแฟพรุ่งนี้", "th", True),
    ("Здравствуйте, я хочу забронировать дегустацию на завтра, пожалуйста", "ru", False),
    ("Здравствуйте, это очень хорошо, мы хотим забронировать экскурсию", "ru", True),
    ("Добрий день, я хочу забронювати дегустацію на завтра, будь ласка. Це їжа.", "uk", True),
    ("Привіт, я хочу записатися на завтра", "uk", True),
    ("Привет", "ru", False),
]


@pytest.mark.parametrize(("text", "language"), CERTAIN)
def test_a_plain_message_is_recognised_for_certain(text: str, language: str) -> None:
    """A sentence of ordinary words scores clearly, and the winner is settled."""
    assert detect(text) == Detection(language, True)


@pytest.mark.parametrize(("text", "language", "certain"), SCRIPTS)
def test_an_alphabet_that_names_a_language_decides_it(text: str, language: str, certain: bool) -> None:
    """Chinese, Japanese, Korean, Greek, Hebrew, Thai and the Cyrillic languages are told by their letters."""
    assert detect(text) == Detection(language, certain)


def test_czech_and_slovak_are_told_apart() -> None:
    """The letters and words only one of them has decide, in both directions."""
    assert detect("Chci si rezervovat termín pro dvě osoby, děkuji.") == Detection("cs", True)
    assert detect("Chcem si rezervovať termín pre dve osoby, ďakujem.") == Detection("sk", True)
    assert detect("Áno, ten večerný termín mi vyhovuje.") == Detection("sk", False) or detect(
        "Áno, ten večerný termín mi vyhovuje."
    ) == Detection("sk", True)


@pytest.mark.parametrize(
    "text", ["ok", "1", "Jana Novak", "jana@example.test", "Ano.", "Ten termín beru.", "", "   ", "?!"]
)
def test_a_message_without_words_to_go_on_is_left_undecided_or_unsure(text: str) -> None:
    """A name, a number or a bare yes tells nothing certain, so the conversation keeps its language."""
    detection = detect(text)

    assert detection is None or not detection.certain


def test_a_greeting_alone_is_enough_to_open_a_conversation() -> None:
    """Hi and Hallo are likely, which is enough for a first message but never to switch a conversation."""
    assert detect("Hi") == Detection("en", False)
    assert detect("Hallo") == Detection("de", False)


def test_a_mixed_message_follows_the_language_most_of_it_is_in() -> None:
    """English with a Czech name stays English; Czech with an English word stays Czech."""
    assert detect("Please book it for Jana Dvořáková, thanks") == Detection("en", True)
    assert detect("Chci cupping pro dvě osoby, díky, ok") == Detection("cs", True)


def test_every_golden_conversation_opens_in_a_language_the_code_recognises() -> None:
    """The first message of each golden case is recognised as the case's language, so no first message needs a model."""
    for case in read_golden_set().cases:
        detection = detect(case.turns[0].say)
        assert detection is not None, case.id
        assert detection.language == case.language, f"{case.id}: {detection}"


def test_the_golden_switch_to_czech_is_a_certain_detection() -> None:
    """A conversation under way only switches on a certain detection, and the golden switch is one."""
    case = next(case for case in read_golden_set().cases if case.id == "switch-to-czech-en")

    assert detect(case.turns[1].say) == Detection("cs", True)


def test_the_word_lists_are_complete_enough_to_score() -> None:
    """Each language has dozens of words, and Czech and Slovak each have the letters that name them."""
    assert set(WORDS) >= {"en", "cs", "sk", "de", "pl", "es", "fr", "it", "pt", "nl"}
    assert all(len(entry.common) >= 30 for entry in WORDS.values())
    assert WORDS["cs"].letters == "ěřů"
    assert "ľ" in WORDS["sk"].letters


def test_languages_have_names_for_prompts_and_unknown_codes_stay_as_they_are() -> None:
    """The prompt says Czech, not cs; a code without a name is used as it is."""
    assert language_name("cs") == "Czech"
    assert language_name("sw") == "sw"
