"""LB-01's app configuration."""

from django.apps import AppConfig


class Lb01Config(AppConfig):
    """The Support Desk Agent, whose data lives in the lb01 schema."""

    name = "lb01"
    verbose_name = "LB-01 Support Desk Agent"
