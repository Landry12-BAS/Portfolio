"""The WebSocket routes of the Django systems: one consumer for each system that talks live.

Today that is LB-02's booking concierge. The path has no visitor information in it on
purpose: addresses end up in access logs, so the visitor's token travels in the first
message instead (lb02/consumers.py).
"""

from django.urls import URLPattern, path

from lb02.consumers import ConciergeConsumer

websocket_urlpatterns: list[URLPattern] = [
    path("ws/lb02/", ConciergeConsumer.as_asgi()),
]
