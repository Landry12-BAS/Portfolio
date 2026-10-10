"""Integration tests for `embed_lb01` and `eval_lb01_search`, on copies of the data they write."""

import re
from datetime import date
from io import StringIO
from pathlib import Path
from shutil import copytree

import pytest
from django.core.management import CommandError, call_command
from pytest_django.fixtures import Settings

from lb01.embeddings import read_embedding_file
from lb01.models import EMBEDDING_DIMENSIONS
from lb01.seed import seed
from tests.support import one_hot

pytestmark = [pytest.mark.integration, pytest.mark.django_db(databases=["lb01"])]


class FakeGateway:
    """Stands in for lb_common.gateway.Gateway: embeds with one-hot vectors, and counts connections and calls."""

    connections = 0

    def __init__(self) -> None:
        """Start a connection with no calls."""
        self.calls: list[list[str]] = []
        self.closed = False

    @classmethod
    def from_env(cls) -> "FakeGateway":
        """Connect, as Gateway.from_env does, remembering the instance for the test to inspect."""
        cls.connections += 1
        cls.latest = cls()
        return cls.latest

    def embed(self, texts: list[str]) -> list[list[float]]:
        """Give each text a distinct one-hot vector."""
        self.calls.append(texts)
        return [one_hot(index % EMBEDDING_DIMENSIONS) for index in range(len(texts))]

    def close(self) -> None:
        """Close the connection."""
        self.closed = True

    latest: "FakeGateway"


@pytest.fixture
def data_copy(tmp_path: Path, settings: Settings) -> Path:
    """Point SEED_DIR and EVALS_DIR at copies of the data, so the commands may write their files."""
    copytree(settings.SEED_DIR / "lb01", tmp_path / "seed" / "lb01")
    copytree(settings.EVALS_DIR / "lb01", tmp_path / "evals" / "lb01")
    settings.SEED_DIR = tmp_path / "seed"
    settings.EVALS_DIR = tmp_path / "evals"
    return tmp_path


@pytest.fixture
def data_without_vectors(data_copy: Path) -> Path:
    """Return the data copy as it was before `just embed` first ran, without recorded passage or golden-set vectors."""
    (data_copy / "seed" / "lb01" / "embeddings.json").unlink(missing_ok=True)
    (data_copy / "evals" / "lb01" / "query-embeddings.json").unlink(missing_ok=True)
    return data_copy


@pytest.fixture
def fake_gateway(monkeypatch: pytest.MonkeyPatch) -> type[FakeGateway]:
    """Make embed_lb01 connect to the fake gateway."""
    FakeGateway.connections = 0
    monkeypatch.setattr("lb01.management.commands.embed_lb01.Gateway", FakeGateway)
    return FakeGateway


def run_command(name: str, *args: str) -> str:
    """Run a management command and return what it printed."""
    output = StringIO()
    call_command(name, *args, stdout=output)
    return output.getvalue()


def test_embed_records_every_vector_then_nothing_more(
    data_without_vectors: Path, fake_gateway: type[FakeGateway]
) -> None:
    """The first run embeds every text and writes both files; the second connects to nothing."""
    first = run_command("embed_lb01")

    passages = read_embedding_file(data_without_vectors / "seed" / "lb01" / "embeddings.json")
    queries = read_embedding_file(data_without_vectors / "evals" / "lb01" / "query-embeddings.json")
    assert passages is not None
    assert queries is not None
    embedded = len(passages.vectors) + len(queries.vectors)
    assert f"Embedded {embedded} texts" in first
    assert fake_gateway.latest.closed

    second = run_command("embed_lb01")

    assert "nothing was embedded" in second
    assert fake_gateway.connections == 1


@pytest.mark.usefixtures("data_without_vectors")
def test_embed_says_what_is_missing_without_the_gateway_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    """With texts to embed and no gateway settings, the command stops and names the variables."""
    for name in ("LB_GATEWAY_URL", "LB_SERVICE_NAME", "LB_SERVICE_KEY_FILE"):
        monkeypatch.delenv(name, raising=False)

    with pytest.raises(CommandError, match="Set LB_GATEWAY_URL"):
        run_command("embed_lb01")


def test_eval_prints_recall_against_the_gate_and_every_miss() -> None:
    """The report shows each search's recall next to its gate, then what each search misses."""
    seed(Path(__file__).resolve().parents[4] / "data" / "seed" / "lb01", date(2026, 10, 1))

    report = run_command("eval_lb01_search")

    assert "query  keyword  1.000 / 1.000   gate 1.000 / 1.000" in report
    assert "Missed at 4 by ticket keyword:" in report
    assert "stale-decaf: expected damaged.stale-coffee; found nothing" in report


@pytest.mark.usefixtures("fake_gateway")
def test_eval_measures_hybrid_search_once_vectors_are_recorded(data_without_vectors: Path) -> None:
    """After `just embed` and `just seed`, the report adds hybrid search, next to its gate."""
    run_command("embed_lb01")
    seed(data_without_vectors / "seed" / "lb01", date(2026, 10, 1))

    report = run_command("eval_lb01_search")

    assert re.search(r"ticket hybrid +\d\.\d{3} / \d\.\d{3} +gate \d\.\d{3} / \d\.\d{3}", report)
