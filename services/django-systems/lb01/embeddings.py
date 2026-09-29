"""Recorded embeddings: LB-01's policy passages and golden queries, embedded once through the gateway.

Recording the vectors in the repository means a deploy never spends quota on the corpus,
every environment searches with the same vectors, and CI measures hybrid search without
calling a provider. Each vector is kept with a hash of the exact text it was made from,
so an edited passage or query is never paired with a stale vector: until the next
`just embed`, it is found by its keywords alone.

Vectors are stored as base64 of little-endian float32, exactly as lb-embed returned
them: 1,024 numbers in 5,464 characters.
"""

import base64
import hashlib
import json
import math
import struct
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Literal, Self

from pydantic import Field, StringConstraints, ValidationError, model_validator

from core.data_files import DataFileError, Key, StrictEntry
from lb01.models import EMBEDDING_DIMENSIONS

# One vector's bytes: float32, four bytes a number.
VECTOR_BYTES = EMBEDDING_DIMENSIONS * 4
VECTOR_FORMAT = f"<{EMBEDDING_DIMENSIONS}f"
# What a file of recorded vectors says about itself.
RECORDING_NOTE = "Recorded by `just embed` (manage.py embed_lb01) through lb-embed. Regenerate it; never edit it."
# The gateway takes up to 128 texts, and up to 8,000 estimated tokens, in one embedding
# call (services/gateway/routing.yaml); batches stay under both, with a margin.
MAX_BATCH_TEXTS = 128
MAX_BATCH_TOKENS = 7_000
# The gateway's own estimate of a text's tokens (services/gateway/src/budget/estimate.ts).
CHARS_PER_TOKEN = 3.5

# A SHA-256 digest, in hexadecimal.
Sha256 = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
# One float32 vector of EMBEDDING_DIMENSIONS numbers, in base64.
Base64Vector = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9+/]+={0,2}$", max_length=VECTOR_BYTES * 2)]


class RecordedVector(StrictEntry):
    """One text's embedding, with the hash of the text it was made from."""

    text_sha256: Sha256
    vector: Base64Vector

    @model_validator(mode="after")
    def _check_vector(self) -> Self:
        """Refuse a vector of the wrong length or with a value that isn't a finite number."""
        decode_vector(self.vector)
        return self

    def values(self) -> list[float]:
        """Return the vector's numbers."""
        return decode_vector(self.vector)


class EmbeddingFile(StrictEntry):
    """A file of recorded embeddings, keyed by passage key or golden case ID."""

    about: str = RECORDING_NOTE
    alias: Literal["lb-embed"] = "lb-embed"
    dimensions: Literal[1024] = EMBEDDING_DIMENSIONS
    vectors: dict[Key, RecordedVector] = Field(default_factory=dict)

    def vector_for(self, key: str, text: str) -> list[float] | None:
        """Return the recorded vector for `key` if it was made from exactly `text`, else None."""
        recorded = self.vectors.get(key)
        if recorded is None or recorded.text_sha256 != text_sha256(text):
            return None
        return recorded.values()


@dataclass(frozen=True)
class Recording:
    """The result of recording: both files as they should now be, and how many texts were embedded."""

    passages: EmbeddingFile
    queries: EmbeddingFile
    embedded: int


def text_sha256(text: str) -> str:
    """Hash a text, to tell whether a recorded vector was made from it."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def passage_text(title_en: str, text_en: str) -> str:
    """Return the text a passage's embedding is made from: its English title and text."""
    return f"{title_en}\n{text_en}"


def encode_vector(values: Sequence[float]) -> str:
    """Store a vector as base64 of little-endian float32, refusing one of the wrong length."""
    if len(values) != EMBEDDING_DIMENSIONS or not all(math.isfinite(value) for value in values):
        raise ValueError(f"an embedding is {EMBEDDING_DIMENSIONS} finite numbers")
    return base64.b64encode(struct.pack(VECTOR_FORMAT, *values)).decode("ascii")


def decode_vector(text: str) -> list[float]:
    """Read a stored vector back, refusing one of the wrong length or with a non-finite value."""
    raw = base64.b64decode(text, validate=True)
    if len(raw) != VECTOR_BYTES:
        raise ValueError(f"a vector is {VECTOR_BYTES} bytes of float32, not {len(raw)}")
    values = list(struct.unpack(VECTOR_FORMAT, raw))
    if not all(math.isfinite(value) for value in values):
        raise ValueError("a vector holds a value that isn't a finite number")
    return values


def read_embedding_file(path: Path) -> EmbeddingFile | None:
    """Read a file of recorded vectors, or return None when there is none yet."""
    try:
        content = path.read_bytes()
    except FileNotFoundError:
        return None
    except OSError as error:
        raise DataFileError(f"{path} can't be read: {error.strerror}") from None
    try:
        return EmbeddingFile.model_validate_json(content)
    except ValidationError as error:
        problems = [f"{'.'.join(str(part) for part in issue['loc'])}: {issue['msg']}" for issue in error.errors()]
        raise DataFileError(f"{path} doesn't follow its schema:\n- " + "\n- ".join(problems)) from None


def write_embedding_file(path: Path, recorded: EmbeddingFile) -> None:
    """Write a file of recorded vectors, keys sorted, so a new recording changes only what changed."""
    path.write_text(json.dumps(recorded.model_dump(), indent=1, sort_keys=True) + "\n", encoding="utf-8")


def record(
    passages: Mapping[str, str],
    queries: Mapping[str, str],
    recorded_passages: EmbeddingFile | None,
    recorded_queries: EmbeddingFile | None,
    embed: Callable[[list[str]], list[list[float]]],
    again: bool = False,
) -> Recording:
    """Embed every passage and query text that has no vector for its current wording, and keep the rest.

    `passages` and `queries` map each key to the text to embed. `embed` turns a batch of
    texts into their vectors, in order. With `again`, every text is embedded anew, as
    after lb-embed changes model. Keys no longer present are dropped from the files.
    """
    kept_passages = {} if again or recorded_passages is None else dict(recorded_passages.vectors)
    kept_queries = {} if again or recorded_queries is None else dict(recorded_queries.vectors)
    wanted: list[tuple[dict[str, RecordedVector], str, str]] = []
    for key, text in passages.items():
        if not has_current_vector(kept_passages, key, text):
            wanted.append((kept_passages, key, text))
    for key, text in queries.items():
        if not has_current_vector(kept_queries, key, text):
            wanted.append((kept_queries, key, text))
    for batch in batches([text for _, _, text in wanted]):
        vectors = embed(batch.texts)
        if len(vectors) != len(batch.texts):
            raise ValueError("lb-embed returned a different number of vectors than texts")
        for (destination, key, text), vector in zip(wanted[batch.start : batch.end], vectors, strict=True):
            destination[key] = RecordedVector(text_sha256=text_sha256(text), vector=encode_vector(vector))
    return Recording(
        passages=EmbeddingFile(vectors={key: kept_passages[key] for key in sorted(passages)}),
        queries=EmbeddingFile(vectors={key: kept_queries[key] for key in sorted(queries)}),
        embedded=len(wanted),
    )


def has_current_vector(recorded: Mapping[str, RecordedVector], key: str, text: str) -> bool:
    """Tell whether `key` already has a vector made from exactly `text`."""
    return key in recorded and recorded[key].text_sha256 == text_sha256(text)


@dataclass(frozen=True)
class Batch:
    """A run of consecutive texts small enough for one embedding call."""

    texts: list[str]
    start: int
    end: int


def batches(texts: Sequence[str]) -> list[Batch]:
    """Split texts into consecutive batches within the gateway's limits for one call."""
    result: list[Batch] = []
    start = 0
    tokens = 0
    for index, text in enumerate(texts):
        estimate = math.ceil(len(text) / CHARS_PER_TOKEN)
        full = index - start >= MAX_BATCH_TEXTS or tokens + estimate > MAX_BATCH_TOKENS
        if full and index > start:
            result.append(Batch(list(texts[start:index]), start, index))
            start, tokens = index, 0
        tokens += estimate
    if start < len(texts):
        result.append(Batch(list(texts[start:]), start, len(texts)))
    return result
