"""The ASGI entry point the application server loads: `config.asgi:application`.

HTTP requests go to Django. WebSocket connections go to the systems' consumers
(config/routing.py), where each consumer checks the visitor's token itself, as the
first thing it reads (lb02/consumers.py).
"""

import os

from channels.routing import ProtocolTypeRouter
from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")


def build_application() -> ProtocolTypeRouter:
    """Set Django up, then route each kind of connection to its handler.

    The consumers import Django's models, so they can only be imported once Django has
    set itself up, which getting its ASGI application does.
    """
    http_application = get_asgi_application()
    from channels.routing import URLRouter

    from config.routing import websocket_urlpatterns

    return ProtocolTypeRouter({"http": http_application, "websocket": URLRouter(websocket_urlpatterns)})


application = build_application()
