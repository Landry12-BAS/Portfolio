"""LB-09's app configuration."""

from django.apps import AppConfig


class Lb09Config(AppConfig):
    """The Meeting Recorder, whose data lives in the lb09 schema."""

    name = "lb09"
    verbose_name = "LB-09 Meeting Recorder"
