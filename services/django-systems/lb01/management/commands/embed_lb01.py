"""`manage.py embed_lb01` (`just embed`): record the vectors LB-01's search needs, through the gateway.

Embeds every policy passage and golden-set text that has no vector for its current
wording, in as few gateway calls as its limits allow, and writes
data/seed/lb01/embeddings.json and evals/lb01/query-embeddings.json. Commit both:
`just seed` loads the passage vectors, and the search eval reads the others. It needs
the gateway running with a Workers AI key, and LB_GATEWAY_URL, LB_SERVICE_NAME and
LB_SERVICE_KEY_FILE set.
"""

from argparse import ArgumentParser

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from openai import OpenAIError

from core.data_files import DataFileError, read_data_file
from lb01.embeddings import passage_text, read_embedding_file, record, write_embedding_file
from lb01.golden import read_golden_set
from lb01.search_eval import texts_to_record
from lb01.seed import PolicyFile
from lb_common.gateway import Gateway
from lb_common.run import Run, new_run_id, run_scope


class GatewayEmbedder:
    """Embeds texts through the gateway, connecting only once there is something to embed."""

    def __init__(self) -> None:
        """Start unconnected, and count the calls made."""
        self.gateway: Gateway | None = None
        self.calls = 0

    def embed(self, texts: list[str]) -> list[list[float]]:
        """Embed one batch of texts as its own synthetic run of LB-01: the texts are the site's own data."""
        if self.gateway is None:
            self.gateway = Gateway.from_env()
        with run_scope(Run(system="lb-01", run_id=new_run_id(), data_class="synthetic")):
            vectors = self.gateway.embed(texts)
        self.calls += 1
        return vectors

    def close(self) -> None:
        """Close the gateway connection, if one was opened."""
        if self.gateway is not None:
            self.gateway.close()


class Command(BaseCommand):
    """Records the passage and golden-set vectors that are missing or stale."""

    help = "Embed LB-01's policy passages and golden-set texts through the gateway, recording only what changed."

    def add_arguments(self, parser: ArgumentParser) -> None:
        """Take a flag to embed everything again."""
        parser.add_argument(
            "--again",
            action="store_true",
            help="Embed every text again, as after lb-embed changes model.",
        )

    def handle(self, *args: object, **options: object) -> None:
        """Embed what changed, then write both files and say what was done."""
        passages_path = settings.SEED_DIR / "lb01" / "embeddings.json"
        queries_path = settings.EVALS_DIR / "lb01" / "query-embeddings.json"
        try:
            policies = read_data_file(settings.SEED_DIR / "lb01" / "policies.yaml", PolicyFile)
            golden = read_golden_set()
            recorded_passages = read_embedding_file(passages_path)
            recorded_queries = read_embedding_file(queries_path)
        except DataFileError as error:
            raise CommandError(str(error)) from None
        passages = {
            passage.key: passage_text(passage.title.en, passage.text.en)
            for policy in policies.policies
            for passage in policy.passages
        }
        embedder = GatewayEmbedder()
        try:
            recording = record(
                passages,
                texts_to_record(golden),
                recorded_passages,
                recorded_queries,
                embedder.embed,
                again=options["again"] is True,
            )
        except (ValueError, OSError, OpenAIError) as error:
            raise CommandError(f"Embedding failed: {error}") from None
        finally:
            embedder.close()
        write_embedding_file(passages_path, recording.passages)
        write_embedding_file(queries_path, recording.queries)
        if recording.embedded == 0:
            self.stdout.write("Every vector is current; nothing was embedded.")
        else:
            self.stdout.write(f"Embedded {recording.embedded} texts in {embedder.calls} gateway calls.")
        self.stdout.write(
            self.style.SUCCESS(
                f"Wrote {passages_path} ({len(recording.passages.vectors)} passages) and "
                f"{queries_path} ({len(recording.queries.vectors)} golden-set texts)."
            )
        )
