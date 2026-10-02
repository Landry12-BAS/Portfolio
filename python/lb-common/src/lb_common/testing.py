"""Helpers for the tests of every Python system: the shared corpus of visitor tokens.

Nothing in a running service imports this module. The corpus is one JSON file of signed
tokens, each with the verdict every verifier must give it
(packages/common/test/fixtures/visitor-tokens.json, made by
packages/common/scripts/visitor-token-corpus.ts). The TypeScript check in @lb/common, the
check in `lb_common.visitors` and the Django, Flask and Node systems built on them all run the
same file in their own tests, so they accept and refuse exactly the same tokens
(docs/SECURITY.md, section 2).
"""

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

# The repository's root: this file is python/lb-common/src/lb_common/testing.py.
REPOSITORY = Path(__file__).resolve().parents[4]
# Where the corpus lives, next to the tests of @lb/common that make and read it.
CORPUS_FILE = REPOSITORY / "packages" / "common" / "test" / "fixtures" / "visitor-tokens.json"

# What every verifier must say about a case.
Verdict = Literal["ok", "refuse"]


class CorpusToken(BaseModel):
    """One token of the corpus, the system it is checked for, and the verdict."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    name: str
    rule: str
    system: str
    token: str
    expect: Verdict
    # The visitor an accepted token names.
    session_key: str | None = Field(default=None, alias="sessionKey")


class CorpusHeader(BaseModel):
    """One Authorization header of the corpus, around a token of it."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str
    rule: str
    system: str
    authorization: str | None
    expect: Verdict


class CorpusKey(BaseModel):
    """One way of configuring the site's key, from the corpus."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str
    rule: str
    key: str
    expect: Verdict


class VisitorTokenCorpus(BaseModel):
    """The shared corpus: signed tokens, header values and keys, each with the verdict every verifier must give it."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    about: str
    # The rules the cases test, by number, in words.
    rules: dict[str, str]
    # The moment every case is judged at, in Unix seconds.
    now: int
    # The site's public key the signed cases were made for, as LB_WEB_TOKEN_KEY holds it.
    public_key: str = Field(alias="publicKey")
    tokens: list[CorpusToken]
    headers: list[CorpusHeader]
    keys: list[CorpusKey]


def load_visitor_token_corpus() -> VisitorTokenCorpus:
    """Read the shared corpus of visitor tokens and check its shape, so a change to the file is noticed."""
    return VisitorTokenCorpus.model_validate_json(CORPUS_FILE.read_text(encoding="utf-8"))
