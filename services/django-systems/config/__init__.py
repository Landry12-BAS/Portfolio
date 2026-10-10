"""The Django project that hosts the Django systems (LB-01, then LB-02 and LB-09).

The Celery app loads with it, so tasks queued from a request reach the right broker.
"""

from config.celery import app as celery_app

__all__ = ("celery_app",)
