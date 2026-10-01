"""LB-02's app configuration."""

from django.apps import AppConfig


class Lb02Config(AppConfig):
    """The Booking Concierge, whose data lives in the lb02 schema."""

    name = "lb02"
    verbose_name = "LB-02 Booking Concierge"
