"""Tests for lb01.claims: every fact in a draft must come from a source it cites."""

from lb01.claims import ClaimProblem, ProblemCode, check_claims, describe_problem
from lb01.prompts import DraftSentence

SOURCES = {
    "passage:damaged.torn-bags": "Torn bags: send a photo within 14 days of delivery and we send a replacement.",
    "order:BB-1040": "Order BB-1040: delivered. Dates: placed 2026-09-22, delivered 2026-09-05. Total 667 CZK.",
}


def sentence(text: str, *sources: str) -> DraftSentence:
    """Make a draft sentence citing `sources`."""
    return DraftSentence(text=text, sources=list(sources))


def test_facts_backed_by_their_sources_pass() -> None:
    """Numbers and codes found in the cited sources are supported."""
    check = check_claims(
        [
            sentence("Hello Sam,"),
            sentence("Order BB-1040 cost 667 CZK.", "order:BB-1040"),
            sentence("Send us a photo within 14 days.", "passage:damaged.torn-bags"),
            sentence("Basalt & Bean support"),
        ],
        SOURCES,
    )

    assert check.supported
    assert check.unsupported == []


def test_a_number_the_sources_dont_state_fails() -> None:
    """A wrong deadline, cited to a real passage, is caught."""
    check = check_claims([sentence("Send us a photo within 30 days.", "passage:damaged.torn-bags")], SOURCES)

    assert check.unsupported == [0]
    assert check.reasons[0] == "states 30, which its sources don't"


def test_a_source_the_drafter_wasnt_given_fails() -> None:
    """Citing a passage outside the search results is unsupported, however plausible."""
    check = check_claims([sentence("You can pause for 3 months.", "passage:subscriptions.skip-and-pause")], SOURCES)

    assert check.reasons[0] == "cites a source it wasn't given: passage:subscriptions.skip-and-pause"


def test_an_uncited_sentence_passes_only_as_short_courtesy() -> None:
    """Greetings and a sign-off pass; an uncited number or a long uncited statement doesn't."""
    long_statement = (
        "Our team looks at every message carefully, and we are always happy to help you with anything at all."
    )

    check = check_claims(
        [
            sentence("Hello Sam,"),
            sentence("Thank you for writing to us."),
            sentence("Your order cost 667 CZK."),
            sentence(long_statement),
            sentence("Basalt & Bean support"),
        ],
        SOURCES,
    )

    assert check.unsupported == [2, 3]
    assert check.reasons[2] == "states a fact without citing a source"


def test_an_uncited_promise_fails_however_short() -> None:
    """A promise of money back, a replacement or a delivery needs a source, in English or in Czech."""
    check = check_claims(
        [
            sentence("We will refund you in full."),
            sentence("A replacement is on its way."),
            sentence("Peníze vám vrátíme."),
            sentence("Pošleme vám nový sáček zdarma."),
            sentence("We're sorry about the torn bag."),
        ],
        SOURCES,
    )

    assert check.unsupported == [0, 1, 2, 3]


def test_dates_match_however_the_reply_writes_them() -> None:
    """The order's ISO date 2026-09-05 supports a Czech 5. 9. 2026."""
    check = check_claims([sentence("Objednávka byla doručena 5. 9. 2026.", "order:BB-1040")], SOURCES)

    assert check.supported


def test_problems_are_codes_with_the_sources_or_numbers_they_are_about() -> None:
    """A failed sentence keeps what is wrong as data, so any language can word it."""
    check = check_claims(
        [
            sentence("Send us a photo within 30 days.", "passage:damaged.torn-bags"),
            sentence("You can pause for 3 months.", "passage:subscriptions.skip-and-pause"),
            sentence("Your refund is on its way."),
        ],
        SOURCES,
    )

    assert check.problems == {
        0: ClaimProblem(ProblemCode.UNSTATED_NUMBERS, ("30",)),
        1: ClaimProblem(ProblemCode.UNKNOWN_SOURCE, ("passage:subscriptions.skip-and-pause",)),
        2: ClaimProblem(ProblemCode.UNCITED_FACT),
    }


def test_every_problem_is_worded_in_english_and_in_czech() -> None:
    """Czech visitors read the explanation in Czech; an unknown language falls back to English."""
    unstated = ClaimProblem(ProblemCode.UNSTATED_NUMBERS, ("30", "14"))

    assert describe_problem(unstated, "en") == "states 30, 14, which its sources don't"
    assert describe_problem(unstated, "cs") == "uvádí 30, 14, což jeho zdroje neobsahují"
    assert describe_problem(ClaimProblem(ProblemCode.UNCITED_FACT), "cs") == "uvádí tvrzení bez zdroje"
    assert describe_problem(ClaimProblem(ProblemCode.UNKNOWN_SOURCE, ("order:BB-1040",)), "cs") == (
        "cituje zdroj, který nedostal: order:BB-1040"
    )
    assert describe_problem(unstated, "de") == describe_problem(unstated, "en")
