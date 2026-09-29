"""URL routes: the JSON API under /api/, and JSON answers for every error."""

from django.urls import path

from config.api import api

urlpatterns = [
    path("api/", api.urls),
]

handler404 = "core.views.not_found"
handler500 = "core.views.server_error"
