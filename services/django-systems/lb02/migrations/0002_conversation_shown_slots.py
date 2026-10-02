"""Give each conversation a registry of the slots it was shown, so that a slot's number never changes.

Written by makemigrations, plus the backfill: a conversation that already has slots on offer
numbered them 1, 2, 3 by their place in that list, so its registry starts as that list and the
numbers a visitor can already see keep meaning what they meant.
"""

import django.contrib.postgres.fields
from django.db import migrations, models
from django.db.models import F


def number_the_slots_on_offer(apps, schema_editor):
    """Start every conversation's registry with the slots on offer, in the order they were numbered."""
    conversation = apps.get_model("lb02", "Conversation")
    conversation.objects.using(schema_editor.connection.alias).update(shown_slots=F("offered_slots"))


class Migration(migrations.Migration):
    dependencies = [
        ("lb02", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="conversation",
            name="shown_slots",
            field=django.contrib.postgres.fields.ArrayField(
                base_field=models.BigIntegerField(), blank=True, default=list, size=128
            ),
        ),
        migrations.RunPython(number_the_slots_on_offer, migrations.RunPython.noop),
    ]
