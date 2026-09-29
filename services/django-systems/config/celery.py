"""The Celery app the Django systems' worker and scheduler run: `celery -A config worker`.

It reads its settings from Django's (the CELERY_ ones in config/settings.py) and finds
each system's tasks.py on its own.
"""

import os

from celery import Celery

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

app = Celery("django_systems")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks()
