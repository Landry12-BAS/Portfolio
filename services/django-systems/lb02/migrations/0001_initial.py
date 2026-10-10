"""LB-02's first schema: rooms, offerings, slots, conversations, reservations, confirmations and handoffs.

Written by makemigrations, except the first operation, which makes btree_gist's operators
available (core/extensions.py) before the exclusion constraint on a room and a time range
needs the `=` operator in a GiST index.
"""

import django.contrib.postgres.constraints
import django.contrib.postgres.fields
import django.contrib.postgres.fields.ranges
import django.core.validators
import django.db.models.deletion
import django.db.models.functions.text
import django.db.models.lookups
import django.utils.timezone
from django.db import migrations, models

import lb02.models
from core.extensions import install_btree_gist


class Migration(migrations.Migration):
    initial = True

    dependencies = []

    operations = [
        install_btree_gist(),
        migrations.CreateModel(
            name="Conversation",
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
                        default=lb02.models.new_public_id,
                        editable=False,
                        max_length=24,
                        unique=True,
                    ),
                ),
                ("session_key", models.CharField(db_index=True, max_length=128)),
                (
                    "language",
                    models.CharField(
                        blank=True,
                        max_length=3,
                        validators=[
                            django.core.validators.RegexValidator(
                                "^(?:[a-z]{2,3})?$",
                                "Use a two or three letter language code such as cs.",
                            )
                        ],
                    ),
                ),
                (
                    "step",
                    models.CharField(
                        choices=[
                            ("details", "Collecting details"),
                            ("availability", "Checking availability"),
                            ("hold", "A slot is held"),
                            ("done", "Booked, with its confirmation recorded"),
                            ("handoff", "Handed to a person"),
                        ],
                        default="details",
                        max_length=14,
                    ),
                ),
                ("party_size", models.PositiveSmallIntegerField(blank=True, null=True)),
                ("guest_name", models.CharField(blank=True, max_length=60)),
                ("guest_email", models.EmailField(blank=True, max_length=254)),
                ("search_from", models.DateField(blank=True, null=True)),
                ("search_to", models.DateField(blank=True, null=True)),
                (
                    "search_part_of_day",
                    models.CharField(
                        blank=True,
                        choices=[
                            ("morning", "Morning, before 12:00"),
                            ("afternoon", "Afternoon, 12:00 to 17:00"),
                            ("evening", "Evening, from 17:00"),
                            ("any", "Any time"),
                        ],
                        max_length=10,
                    ),
                ),
                (
                    "offered_slots",
                    django.contrib.postgres.fields.ArrayField(
                        base_field=models.BigIntegerField(),
                        blank=True,
                        default=list,
                        size=6,
                    ),
                ),
                ("message_count", models.PositiveSmallIntegerField(default=0)),
                ("model_calls", models.PositiveSmallIntegerField(default=0)),
                ("injection_strikes", models.PositiveSmallIntegerField(default=0)),
                ("failed_turns", models.PositiveSmallIntegerField(default=0)),
                ("run_id", models.CharField(blank=True, max_length=64)),
                ("created_at", models.DateTimeField(default=django.utils.timezone.now)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "expires_at",
                    models.DateTimeField(db_index=True, default=lb02.models.visitor_data_expiry),
                ),
            ],
            options={
                "ordering": ("-created_at",),
            },
        ),
        migrations.CreateModel(
            name="Offering",
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
                ("position", models.PositiveSmallIntegerField()),
                ("title_en", models.CharField(max_length=80)),
                ("title_cs", models.CharField(max_length=80)),
                ("summary_en", models.CharField(max_length=300)),
                ("summary_cs", models.CharField(max_length=300)),
                ("duration_minutes", models.PositiveSmallIntegerField()),
                ("capacity", models.PositiveSmallIntegerField()),
                (
                    "price_czk",
                    models.PositiveIntegerField(help_text="Per guest, in whole crowns."),
                ),
            ],
            options={
                "ordering": ("position",),
            },
        ),
        migrations.CreateModel(
            name="Resource",
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
                ("name_en", models.CharField(max_length=80)),
                ("name_cs", models.CharField(max_length=80)),
            ],
        ),
        migrations.CreateModel(
            name="Handoff",
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
                    "reason",
                    models.CharField(
                        choices=[
                            ("asked_for_person", "The visitor asked for a person"),
                            (
                                "out_of_scope",
                                "The request isn't a booking the concierge can make",
                            ),
                            (
                                "cannot_help",
                                "The concierge couldn't help, for example with a group above capacity",
                            ),
                            (
                                "message_limit",
                                "The conversation reached its message limit",
                            ),
                            ("budget", "The conversation used its model-call budget"),
                            (
                                "unavailable",
                                "The models or their quota weren't available",
                            ),
                            (
                                "unchecked",
                                "The injection screen couldn't check the visitor's messages",
                            ),
                            (
                                "abuse",
                                "The injection screen flagged the visitor's messages again and again",
                            ),
                        ],
                        max_length=20,
                    ),
                ),
                ("summary", models.TextField(max_length=1000)),
                ("transcript", models.JSONField()),
                ("created_at", models.DateTimeField()),
                (
                    "conversation",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="handoff",
                        to="lb02.conversation",
                    ),
                ),
            ],
        ),
        migrations.AddField(
            model_name="conversation",
            name="offering",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="+",
                to="lb02.offering",
            ),
        ),
        migrations.CreateModel(
            name="Reservation",
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
                    "code",
                    models.CharField(
                        default=lb02.models.new_booking_code,
                        editable=False,
                        max_length=9,
                        unique=True,
                    ),
                ),
                ("during", django.contrib.postgres.fields.ranges.DateTimeRangeField()),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("held", "Held for five minutes"),
                            ("booked", "Booked"),
                            ("released", "Released, or replaced by another hold"),
                            ("expired", "The hold ran out"),
                        ],
                        default="held",
                        max_length=10,
                    ),
                ),
                ("party_size", models.PositiveSmallIntegerField()),
                ("guest_name", models.CharField(max_length=60)),
                ("hold_expires_at", models.DateTimeField()),
                ("idempotency_key", models.CharField(blank=True, max_length=64)),
                ("confirmed_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField()),
                (
                    "conversation",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="reservations",
                        to="lb02.conversation",
                    ),
                ),
                (
                    "resource",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="reservations",
                        to="lb02.resource",
                    ),
                ),
            ],
            options={
                "ordering": ("-created_at",),
            },
        ),
        migrations.CreateModel(
            name="Confirmation",
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
                ("to_address", models.EmailField(max_length=254)),
                ("subject", models.CharField(max_length=200)),
                ("body", models.TextField(max_length=2000)),
                (
                    "language",
                    models.CharField(
                        max_length=3,
                        validators=[
                            django.core.validators.RegexValidator(
                                "^(?:[a-z]{2,3})?$",
                                "Use a two or three letter language code such as cs.",
                            )
                        ],
                    ),
                ),
                (
                    "delivery",
                    models.CharField(
                        choices=[("mock", "Recorded, never sent")],
                        default="mock",
                        max_length=4,
                    ),
                ),
                ("recorded_at", models.DateTimeField()),
                (
                    "reservation",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="confirmation",
                        to="lb02.reservation",
                    ),
                ),
            ],
        ),
        migrations.AddField(
            model_name="offering",
            name="resource",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.PROTECT,
                related_name="offerings",
                to="lb02.resource",
            ),
        ),
        migrations.CreateModel(
            name="Slot",
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
                ("during", django.contrib.postgres.fields.ranges.DateTimeRangeField()),
                (
                    "offering",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="slots",
                        to="lb02.offering",
                    ),
                ),
            ],
            options={
                "ordering": ("during",),
            },
        ),
        migrations.AddField(
            model_name="reservation",
            name="slot",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.PROTECT,
                related_name="reservations",
                to="lb02.slot",
            ),
        ),
        migrations.CreateModel(
            name="Message",
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
                ("position", models.PositiveIntegerField()),
                (
                    "role",
                    models.CharField(
                        choices=[
                            ("visitor", "Visitor"),
                            ("concierge", "Concierge"),
                            ("action", "Action"),
                        ],
                        max_length=10,
                    ),
                ),
                ("text", models.TextField(max_length=2000)),
                ("created_at", models.DateTimeField(default=django.utils.timezone.now)),
                (
                    "conversation",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="messages",
                        to="lb02.conversation",
                    ),
                ),
            ],
            options={
                "ordering": ("position",),
                "constraints": [
                    models.UniqueConstraint(
                        fields=("conversation", "position"),
                        name="lb02_message_position_once",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            django.db.models.lookups.GreaterThanOrEqual(
                                django.db.models.functions.text.Length("text"), 1
                            ),
                            django.db.models.lookups.LessThanOrEqual(
                                django.db.models.functions.text.Length("text"), 2000
                            ),
                        ),
                        name="lb02_message_text_length",
                    ),
                ],
            },
        ),
        migrations.AddConstraint(
            model_name="conversation",
            constraint=models.CheckConstraint(
                condition=models.Q(("message_count__lte", 30)),
                name="lb02_conversation_message_limit",
            ),
        ),
        migrations.AddConstraint(
            model_name="confirmation",
            constraint=models.CheckConstraint(
                condition=models.Q(("delivery", "mock")),
                name="lb02_confirmation_is_a_mock",
            ),
        ),
        migrations.AddConstraint(
            model_name="offering",
            constraint=models.CheckConstraint(
                condition=models.Q(("duration_minutes__gte", 15), ("duration_minutes__lte", 480)),
                name="lb02_offering_duration",
            ),
        ),
        migrations.AddConstraint(
            model_name="offering",
            constraint=models.CheckConstraint(
                condition=models.Q(("capacity__gte", 1), ("capacity__lte", 12)),
                name="lb02_offering_capacity",
            ),
        ),
        migrations.AddConstraint(
            model_name="slot",
            constraint=models.UniqueConstraint(fields=("offering", "during"), name="lb02_slot_once"),
        ),
        migrations.AddConstraint(
            model_name="slot",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("during__isempty", False),
                    ("during__lower_inf", False),
                    ("during__upper_inf", False),
                ),
                name="lb02_slot_range_is_bounded",
            ),
        ),
        migrations.AddConstraint(
            model_name="reservation",
            constraint=django.contrib.postgres.constraints.ExclusionConstraint(
                condition=models.Q(("status__in", ("held", "booked"))),
                expressions=[("resource", "="), ("during", "&&")],
                name="lb02_no_double_booking",
            ),
        ),
        migrations.AddConstraint(
            model_name="reservation",
            constraint=models.UniqueConstraint(
                condition=models.Q(("status", "held")),
                fields=("conversation",),
                name="lb02_one_hold_per_conversation",
            ),
        ),
        migrations.AddConstraint(
            model_name="reservation",
            constraint=models.UniqueConstraint(
                condition=models.Q(("status", "booked")),
                fields=("conversation",),
                name="lb02_one_booking_per_conversation",
            ),
        ),
        migrations.AddConstraint(
            model_name="reservation",
            constraint=models.UniqueConstraint(
                condition=models.Q(("idempotency_key", ""), _negated=True),
                fields=("conversation", "idempotency_key"),
                name="lb02_one_confirm_per_key",
            ),
        ),
        migrations.AddConstraint(
            model_name="reservation",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("during__isempty", False),
                    ("during__lower_inf", False),
                    ("during__upper_inf", False),
                ),
                name="lb02_reservation_range_is_bounded",
            ),
        ),
        migrations.AddConstraint(
            model_name="reservation",
            constraint=models.CheckConstraint(
                condition=models.Q(("party_size__gte", 1), ("party_size__lte", 12)),
                name="lb02_reservation_party_size",
            ),
        ),
        migrations.AddConstraint(
            model_name="reservation",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    models.Q(("status", "booked"), _negated=True),
                    models.Q(
                        ("confirmed_at__isnull", False),
                        models.Q(("idempotency_key", ""), _negated=True),
                    ),
                    _connector="OR",
                ),
                name="lb02_booked_is_confirmed",
            ),
        ),
    ]
