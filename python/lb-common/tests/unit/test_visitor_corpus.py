"""Run the shared corpus of visitor tokens against the Python verifier.

The TypeScript check in @lb/common runs the same file (packages/common/test/unit/visitor-corpus.test.ts),
and the Django, Flask and Node systems run it through their own authentication, so every verifier accepts
and refuses exactly the same tokens (docs/SECURITY.md, section 2). The file is made by
packages/common/scripts/visitor-token-corpus.ts, which also says what each rule is.
"""

from typing import Any

import pytest

from lb_common.testing import CorpusHeader, CorpusKey, CorpusToken, load_visitor_token_corpus
from lb_common.visitors import Visitor, VisitorTokenError, load_public_key, verify_visitor_token, visitor_from_header

CORPUS = load_visitor_token_corpus()
PUBLIC_KEY = load_public_key(CORPUS.public_key)
# The longest a refusal's message may be: it names a reason, and never repeats what it was given.
LONGEST_MESSAGE = 200
# How much of the start of a token a refusal's message must never repeat.
PREFIX_LENGTH = 20


def now() -> float:
    """Return the moment every case is judged at."""
    return float(CORPUS.now)


def case_id(case: Any) -> str:
    """Name a case for the test report by what it says and the rule it tests."""
    return f"{case.name} ({case.rule})"


def test_the_corpus_names_a_rule_for_every_case_and_has_a_case_for_every_rule() -> None:
    """A case that names no rule, or a rule with no case, means the file and its rules have drifted apart."""
    named = {case.rule for case in CORPUS.tokens} | {case.rule for case in CORPUS.headers}
    named |= {case.rule for case in CORPUS.keys}

    assert sorted(named - set(CORPUS.rules)) == []
    assert sorted(set(CORPUS.rules) - named) == []


def test_each_case_has_its_own_name() -> None:
    """Names are unique, so a failure points at one case."""
    for names in (
        [case.name for case in CORPUS.tokens],
        [case.name for case in CORPUS.headers],
        [case.name for case in CORPUS.keys],
    ):
        assert len(names) == len(set(names))


@pytest.mark.parametrize("case", [case for case in CORPUS.tokens if case.expect == "ok"], ids=case_id)
def test_verify_visitor_token_accepts(case: CorpusToken) -> None:
    """A token the corpus says is good names its visitor and the system it was checked for."""
    visitor = verify_visitor_token(case.token, case.system, PUBLIC_KEY, now)

    assert visitor == Visitor(session_key=case.session_key or "", system=case.system)


@pytest.mark.parametrize("case", [case for case in CORPUS.tokens if case.expect == "refuse"], ids=case_id)
def test_verify_visitor_token_refuses(case: CorpusToken) -> None:
    """A token the corpus says is bad is refused with a VisitorTokenError, and nothing else escapes."""
    with pytest.raises(VisitorTokenError) as refusal:
        verify_visitor_token(case.token, case.system, PUBLIC_KEY, now)

    assert len(str(refusal.value)) < LONGEST_MESSAGE
    # The first characters of a token are what must never be repeated.
    if len(case.token) >= PREFIX_LENGTH:
        assert case.token[:PREFIX_LENGTH] not in str(refusal.value)


@pytest.mark.parametrize("case", [case for case in CORPUS.headers if case.expect == "ok"], ids=case_id)
def test_visitor_from_header_accepts(case: CorpusHeader) -> None:
    """A header the corpus says is good names the visitor of the token in it."""
    visitor = visitor_from_header(case.authorization, case.system, CORPUS.public_key, now)

    assert visitor.system == case.system


@pytest.mark.parametrize("case", [case for case in CORPUS.headers if case.expect == "refuse"], ids=case_id)
def test_visitor_from_header_refuses(case: CorpusHeader) -> None:
    """A header the corpus says is bad is refused with a VisitorTokenError."""
    with pytest.raises(VisitorTokenError):
        visitor_from_header(case.authorization, case.system, CORPUS.public_key, now)


@pytest.mark.parametrize("case", [case for case in CORPUS.keys if case.expect == "ok"], ids=case_id)
def test_load_public_key_accepts(case: CorpusKey) -> None:
    """A key the corpus says is good loads."""
    assert load_public_key(case.key) is not None


@pytest.mark.parametrize("case", [case for case in CORPUS.keys if case.expect == "refuse"], ids=case_id)
def test_load_public_key_refuses(case: CorpusKey) -> None:
    """A key the corpus says is bad is refused with a ValueError, which stops a service at startup."""
    with pytest.raises(ValueError, match="LB_WEB_TOKEN_KEY"):
        load_public_key(case.key)
