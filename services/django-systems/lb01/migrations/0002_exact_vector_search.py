"""Drop the HNSW index on the passages' vectors, so vector search always scans every passage exactly.

Written by makemigrations. An approximate index hands Postgres a fixed number of candidates
before the row versions that changes left behind are dropped, so after a reseed or `just embed`
it could lose passages that are there; a corpus of a few dozen passages needs no index.
"""

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("lb01", "0001_initial"),
    ]

    operations = [
        migrations.RemoveIndex(
            model_name="policypassage",
            name="lb01_passage_embedding",
        ),
    ]
