"""LB-01's first schema: policies, customers, orders, tickets, drafts and decisions.

Written by makemigrations, except the first operation, which makes pgvector's types
available (core/extensions.py) before any table needs its `vector` type.
"""

import django.contrib.postgres.indexes
import django.contrib.postgres.search
import django.core.validators
import django.db.models.deletion
import django.db.models.functions.text
import django.db.models.lookups
import pgvector.django.indexes
import pgvector.django.vector
from django.db import migrations, models

import lb01.models
from core.extensions import install_pgvector


class Migration(migrations.Migration):
    initial = True

    dependencies = []

    operations = [
        install_pgvector(),
        migrations.CreateModel(
            name="Customer",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                (
                    "key",
                    models.CharField(
                        max_length=40,
                        unique=True,
                        validators=[
                            django.core.validators.RegexValidator(
                                "^[a-z0-9]+(?:[.-][a-z0-9]+)*$",
                                "Use lowercase letters and digits, joined by dots or hyphens.",
                            )
                        ],
                    ),
                ),
                ("name", models.CharField(max_length=120)),
                ("email", models.EmailField(max_length=254)),
                (
                    "language",
                    models.CharField(choices=[("en", "English"), ("cs", "Czech")], max_length=2),
                ),
            ],
        ),
        migrations.CreateModel(
            name="Policy",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                (
                    "key",
                    models.CharField(
                        max_length=40,
                        unique=True,
                        validators=[
                            django.core.validators.RegexValidator(
                                "^[a-z0-9]+(?:[.-][a-z0-9]+)*$",
                                "Use lowercase letters and digits, joined by dots or hyphens.",
                            )
                        ],
                    ),
                ),
                ("title_en", models.CharField(max_length=80)),
                ("title_cs", models.CharField(max_length=80)),
                ("position", models.PositiveSmallIntegerField()),
            ],
            options={
                "verbose_name_plural": "policies",
                "ordering": ("position",),
            },
        ),
        migrations.CreateModel(
            name="Order",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                (
                    "number",
                    models.CharField(
                        max_length=7,
                        unique=True,
                        validators=[
                            django.core.validators.RegexValidator("^BB-\\d{4}$", "Order numbers look like BB-1042.")
                        ],
                    ),
                ),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("processing", "Processing"),
                            ("roasted", "Roasted, waiting for the carrier"),
                            ("shipped", "Shipped"),
                            ("delivered", "Delivered"),
                            ("lost", "Lost by the carrier"),
                            ("cancelled", "Cancelled"),
                        ],
                        max_length=12,
                    ),
                ),
                (
                    "country",
                    models.CharField(
                        default="CZ",
                        max_length=2,
                        validators=[
                            django.core.validators.RegexValidator(
                                "^[A-Z]{2}$",
                                "Use a two-letter country code such as CZ.",
                            )
                        ],
                    ),
                ),
                ("placed_on", models.DateField()),
                ("roasted_on", models.DateField(blank=True, null=True)),
                ("shipped_on", models.DateField(blank=True, null=True)),
                ("delivered_on", models.DateField(blank=True, null=True)),
                ("carrier", models.CharField(blank=True, max_length=40)),
                ("tracking_number", models.CharField(blank=True, max_length=40)),
                ("items", models.JSONField()),
                ("shipping_czk", models.DecimalField(decimal_places=2, max_digits=9)),
                ("total_czk", models.DecimalField(decimal_places=2, max_digits=9)),
                (
                    "customer",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="orders",
                        to="lb01.customer",
                    ),
                ),
            ],
        ),
        migrations.CreateModel(
            name="Ticket",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                (
                    "public_id",
                    models.CharField(
                        default=lb01.models.new_public_id,
                        editable=False,
                        max_length=24,
                        unique=True,
                    ),
                ),
                ("session_key", models.CharField(db_index=True, max_length=64)),
                (
                    "sample_key",
                    models.CharField(
                        blank=True,
                        max_length=40,
                        validators=[
                            django.core.validators.RegexValidator(
                                "^[a-z0-9]+(?:[.-][a-z0-9]+)*$",
                                "Use lowercase letters and digits, joined by dots or hyphens.",
                            )
                        ],
                    ),
                ),
                (
                    "language",
                    models.CharField(choices=[("en", "English"), ("cs", "Czech")], max_length=2),
                ),
                ("body", models.TextField(max_length=2000)),
                ("redacted_body", models.TextField(blank=True)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("received", "Received"),
                            ("processing", "Processing"),
                            (
                                "awaiting_approval",
                                "Waiting for a person to approve the draft",
                            ),
                            ("escalated", "Escalated to a senior agent"),
                            ("sent", "Reply sent"),
                            ("failed", "The pipeline couldn't finish"),
                        ],
                        default="received",
                        max_length=20,
                    ),
                ),
                (
                    "category",
                    models.CharField(
                        blank=True,
                        choices=[
                            ("damaged", "Damaged, stale or faulty item"),
                            ("late", "Late or lost delivery"),
                            ("wrong_item", "Wrong or missing item"),
                            ("return", "Return or refund"),
                            ("subscription", "Subscription question or change"),
                            ("order_change", "Change or cancel an order"),
                            ("product", "Product question"),
                            ("other", "Something else"),
                        ],
                        max_length=20,
                    ),
                ),
                (
                    "order_number",
                    models.CharField(
                        blank=True,
                        max_length=7,
                        validators=[
                            django.core.validators.RegexValidator("^BB-\\d{4}$", "Order numbers look like BB-1042.")
                        ],
                    ),
                ),
                (
                    "escalation_reason",
                    models.CharField(
                        blank=True,
                        choices=[
                            ("injection", "The injection screen flagged the ticket"),
                            (
                                "unchecked",
                                "The injection screen couldn't check the ticket",
                            ),
                            (
                                "senior_agent",
                                "A senior agent's matter: a legal claim, an allergy, fraud or personal data",
                            ),
                            ("no_policy", "No policy passage covers the question"),
                            ("pipeline_error", "A step failed, so a person takes over"),
                        ],
                        max_length=20,
                    ),
                ),
                ("run_id", models.CharField(blank=True, max_length=64)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "expires_at",
                    models.DateTimeField(db_index=True, default=lb01.models.visitor_data_expiry),
                ),
                (
                    "customer",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="tickets",
                        to="lb01.customer",
                    ),
                ),
            ],
            options={
                "ordering": ("-created_at",),
            },
        ),
        migrations.CreateModel(
            name="Draft",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("sentences", models.JSONField()),
                ("claims_supported", models.BooleanField()),
                ("unsupported", models.JSONField(default=list)),
                ("model", models.CharField(blank=True, max_length=120)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "ticket",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="draft",
                        to="lb01.ticket",
                    ),
                ),
            ],
        ),
        migrations.CreateModel(
            name="Decision",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                (
                    "action",
                    models.CharField(
                        choices=[
                            ("approve", "Approve"),
                            ("edit", "Edit, then send"),
                            ("escalate", "Escalate"),
                        ],
                        max_length=10,
                    ),
                ),
                ("final_text", models.TextField(blank=True, max_length=2000)),
                ("decided_at", models.DateTimeField(auto_now_add=True)),
                (
                    "ticket",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="decision",
                        to="lb01.ticket",
                    ),
                ),
            ],
        ),
        migrations.CreateModel(
            name="PolicyPassage",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                (
                    "key",
                    models.CharField(
                        max_length=80,
                        unique=True,
                        validators=[
                            django.core.validators.RegexValidator(
                                "^[a-z0-9]+(?:[.-][a-z0-9]+)*$",
                                "Use lowercase letters and digits, joined by dots or hyphens.",
                            )
                        ],
                    ),
                ),
                ("position", models.PositiveSmallIntegerField()),
                ("title_en", models.CharField(max_length=120)),
                ("title_cs", models.CharField(max_length=120)),
                ("text_en", models.TextField(max_length=1200)),
                ("text_cs", models.TextField(max_length=1200)),
                (
                    "search",
                    models.GeneratedField(
                        db_persist=True,
                        expression=django.contrib.postgres.search.CombinedSearchVector(
                            django.contrib.postgres.search.SearchVector("title_en", config="english", weight="A"),
                            "||",
                            django.contrib.postgres.search.SearchVector("text_en", config="english", weight="B"),
                            django.contrib.postgres.search.SearchConfig("english"),
                        ),
                        output_field=django.contrib.postgres.search.SearchVectorField(),
                    ),
                ),
                (
                    "embedding",
                    pgvector.django.vector.VectorField(blank=True, dimensions=1024, null=True),
                ),
                (
                    "policy",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="passages",
                        to="lb01.policy",
                    ),
                ),
            ],
            options={
                "ordering": ("policy__position", "position"),
                "indexes": [
                    django.contrib.postgres.indexes.GinIndex(fields=["search"], name="lb01_passage_search"),
                    pgvector.django.indexes.HnswIndex(
                        ef_construction=64,
                        fields=["embedding"],
                        m=16,
                        name="lb01_passage_embedding",
                        opclasses=["vector_cosine_ops"],
                    ),
                ],
            },
        ),
        migrations.AddConstraint(
            model_name="ticket",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    django.db.models.lookups.GreaterThanOrEqual(django.db.models.functions.text.Length("body"), 1),
                    django.db.models.lookups.LessThanOrEqual(django.db.models.functions.text.Length("body"), 2000),
                ),
                name="lb01_ticket_body_length",
            ),
        ),
        migrations.AddConstraint(
            model_name="decision",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    models.Q(("action", "escalate"), ("final_text", "")),
                    models.Q(
                        models.Q(("action", "escalate"), _negated=True),
                        models.Q(("final_text", ""), _negated=True),
                    ),
                    _connector="OR",
                ),
                name="lb01_decision_text_when_sent",
            ),
        ),
    ]
