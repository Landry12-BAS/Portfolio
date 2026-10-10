"""Tests for lb01.embeddings: vectors are stored exactly, matched to their text, and recorded only when missing."""

import base64
import binascii
import math
import re
import struct
from pathlib import Path

import pytest

from core.data_files import DataFileError
from lb01.embeddings import (
    MAX_BATCH_TEXTS,
    EmbeddingFile,
    RecordedVector,
    batches,
    decode_vector,
    encode_vector,
    passage_text,
    read_embedding_file,
    record,
    text_sha256,
    write_embedding_file,
)
from lb01.models import EMBEDDING_DIMENSIONS
from tests.support import one_hot


class FakeEmbedder:
    """Stands in for lb-embed: gives each text its own one-hot vector and remembers every batch."""

    def __init__(self, short_by: int = 0) -> None:
        """Start with no batches; `short_by` makes each answer that many vectors short."""
        self.batches: list[list[str]] = []
        self.short_by = short_by

    def embed(self, texts: list[str]) -> list[list[float]]:
        """Embed one batch."""
        self.batches.append(texts)
        count = sum(len(batch) for batch in self.batches)
        vectors = [one_hot((count - len(texts) + offset) % EMBEDDING_DIMENSIONS) for offset in range(len(texts))]
        return vectors[: len(vectors) - self.short_by]


def recorded(vectors: dict[str, str]) -> EmbeddingFile:
    """Make a file of recorded vectors, one per key, each made from the text given."""
    return EmbeddingFile(
        vectors={
            key: RecordedVector(text_sha256=text_sha256(text), vector=encode_vector(one_hot(number)))
            for number, (key, text) in enumerate(vectors.items())
        }
    )


def test_a_vector_survives_storage_exactly() -> None:
    """Float32 values come back bit for bit."""
    vector = [index / 1024 for index in range(EMBEDDING_DIMENSIONS)]

    assert decode_vector(encode_vector(vector)) == vector


def test_storage_refuses_a_malformed_vector() -> None:
    """Wrong lengths, non-finite values and broken base64 are all refused."""
    nan_vector = [math.nan] + [0.0] * (EMBEDDING_DIMENSIONS - 1)

    with pytest.raises(ValueError, match="finite"):
        encode_vector([0.0] * 3)
    with pytest.raises(ValueError, match="finite"):
        encode_vector(nan_vector)
    with pytest.raises(ValueError, match="bytes"):
        decode_vector(base64.b64encode(b"\0" * 8).decode("ascii"))
    with pytest.raises(ValueError, match="finite"):
        decode_vector(base64.b64encode(struct.pack(f"<{EMBEDDING_DIMENSIONS}f", *nan_vector)).decode("ascii"))
    with pytest.raises(binascii.Error):
        decode_vector("not base64!")


def test_a_passage_is_embedded_by_its_english_title_and_text() -> None:
    """The embedded text is the title, a line break, and the text."""
    assert passage_text("Torn bags", "We send a replacement.") == "Torn bags\nWe send a replacement."


def test_a_recorded_vector_matches_only_the_text_it_was_made_from() -> None:
    """An edited text, or an unknown key, has no vector."""
    file = recorded({"damaged.torn-bags": "Torn bags"})

    assert file.vector_for("damaged.torn-bags", "Torn bags") == one_hot(0)
    assert file.vector_for("damaged.torn-bags", "Torn bags!") is None
    assert file.vector_for("coffee.storage", "Torn bags") is None


def test_files_round_trip_with_sorted_keys(tmp_path: Path) -> None:
    """What is written reads back the same, with keys in order, so recordings diff cleanly."""
    path = tmp_path / "embeddings.json"
    file = recorded({"b.two": "two", "a.one": "one"})

    write_embedding_file(path, file)

    assert read_embedding_file(path) == file
    text = path.read_text(encoding="utf-8")
    assert text.index('"a.one"') < text.index('"b.two"')


def test_a_missing_file_means_nothing_is_recorded_yet(tmp_path: Path) -> None:
    """Before the first recording there is no file, and that isn't an error."""
    assert read_embedding_file(tmp_path / "embeddings.json") is None


def test_a_corrupt_file_is_refused_by_name(tmp_path: Path) -> None:
    """A file with a malformed vector stops the reader, naming the file."""
    path = tmp_path / "embeddings.json"
    path.write_text('{"vectors": {"a.one": {"text_sha256": "' + "0" * 64 + '", "vector": "AAAA"}}}', encoding="utf-8")

    with pytest.raises(DataFileError, match=re.escape("embeddings.json doesn't follow its schema")):
        read_embedding_file(path)


def test_recording_embeds_each_text_once() -> None:
    """The first recording embeds everything in one batch; the next embeds nothing."""
    embedder = FakeEmbedder()
    passages = {"p.a": "A", "p.b": "B"}
    queries = {"q.one": "one"}

    first = record(passages, queries, None, None, embedder.embed)
    second = record(passages, queries, first.passages, first.queries, embedder.embed)

    assert first.embedded == 3
    assert embedder.batches == [["A", "B", "one"]]
    assert second.embedded == 0
    assert (second.passages, second.queries) == (first.passages, first.queries)


def test_recording_embeds_only_changed_text_and_drops_removed_keys() -> None:
    """An edited text is embedded again, an unchanged one keeps its vector, and a removed one leaves the file."""
    embedder = FakeEmbedder()
    first = record({"p.a": "A", "p.b": "B", "p.c": "C"}, {}, None, None, embedder.embed)

    second = record({"p.a": "A", "p.b": "B changed"}, {}, first.passages, None, embedder.embed)

    assert second.embedded == 1
    assert embedder.batches[-1] == ["B changed"]
    assert list(second.passages.vectors) == ["p.a", "p.b"]
    assert second.passages.vectors["p.a"] == first.passages.vectors["p.a"]


def test_recording_again_embeds_everything() -> None:
    """After lb-embed changes model, every vector is made anew."""
    embedder = FakeEmbedder()
    first = record({"p.a": "A"}, {"q.one": "one"}, None, None, embedder.embed)

    again = record({"p.a": "A"}, {"q.one": "one"}, first.passages, first.queries, embedder.embed, again=True)

    assert again.embedded == 2


def test_recording_refuses_an_answer_with_too_few_vectors() -> None:
    """A batch answered with fewer vectors than texts is an error, never a silent gap."""
    with pytest.raises(ValueError, match="different number of vectors"):
        record({"p.a": "A", "p.b": "B"}, {}, None, None, FakeEmbedder(short_by=1).embed)


def test_batches_stay_within_the_gateways_limits() -> None:
    """Batches hold at most 128 texts and about 7,000 estimated tokens, and cover every text in order."""
    long_texts = ["x" * 3_500] * 10
    short_texts = ["short"] * 300

    long_batches = batches(long_texts)
    short_batches = batches(short_texts)

    assert [len(batch.texts) for batch in long_batches] == [7, 3]
    assert [len(batch.texts) for batch in short_batches] == [MAX_BATCH_TEXTS, MAX_BATCH_TEXTS, 44]
    assert [(batch.start, batch.end) for batch in short_batches] == [(0, 128), (128, 256), (256, 300)]
