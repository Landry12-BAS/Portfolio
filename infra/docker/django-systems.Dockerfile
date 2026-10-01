# The Django systems image (services/django-systems): the API (uvicorn), the Celery worker
# with its scheduler, and the release step that migrates and seeds. One image, three
# commands (infra/docker-compose.yml). Build context: the repository root.
#
# The build stage installs the production dependencies from uv.lock into a virtualenv; the
# runtime stage copies that virtualenv and the code into a slim Python image and runs as an
# unprivileged user. The image keeps the repository's layout (services/django-systems and
# data/seed under /app), because the settings find the synthetic seed data relative to it.
# Base images are pinned by digest: `just pin-images` refreshes them.

FROM python:3.13.15-slim-trixie@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b AS build
# The uv release the repository pins (.mise.toml), as an image so no installer script runs.
COPY --from=ghcr.io/astral-sh/uv:0.12.19@sha256:04d046b13e60d6bcec73cbc5e1cad25d680dea90c8573340950a0ac2d1aef424 /uv /usr/local/bin/uv
ENV UV_PROJECT_ENVIRONMENT=/app/.venv \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_NO_DEV=1
WORKDIR /repo
# Layer 1: the lockfile and every workspace member's manifest, so the dependency layer is
# reused until a dependency changes. uv checks that each member named in the root
# pyproject.toml exists, which is why every member's manifest comes along.
COPY --parents pyproject.toml uv.lock python/*/pyproject.toml services/*/pyproject.toml ./
RUN uv sync --frozen --no-editable --no-install-workspace --package django-systems
# Layer 2: the shared library and the service, installed into the same environment.
COPY python python
COPY services/django-systems services/django-systems
# Bytecode is compiled now, because the runtime filesystem is read-only; "unchecked-hash"
# keeps it valid whatever the file timestamps become after the stage copy.
RUN uv sync --frozen --no-editable --package django-systems \
 && python -m compileall -q --invalidation-mode unchecked-hash services/django-systems

FROM python:3.13.15-slim-trixie@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b AS runtime
LABEL org.opencontainers.image.title="lb-django-systems" \
      org.opencontainers.image.description="The Django systems (LB-01, then LB-02 and LB-09): API, Celery worker and release step." \
      org.opencontainers.image.source="https://github.com/Landry12-BAS/Portfolio"
# An unprivileged user with no home and no shell. The numeric id is what docker-compose.yml
# gives the tmpfs mounts, so the two must agree.
RUN groupadd --system --gid 10001 lb \
 && useradd --system --uid 10001 --gid lb --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin lb \
 && python -m pip uninstall --yes pip >/dev/null 2>&1 \
 && rm -f /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.13
COPY --from=build /app/.venv /app/.venv
COPY --from=build /repo/services/django-systems /app/services/django-systems
COPY data/seed /app/data/seed
COPY --chmod=0555 infra/docker/django-entrypoint.sh /usr/local/bin/lb-entrypoint
COPY --chmod=0555 infra/docker/django-healthcheck.py /usr/local/bin/lb-healthcheck
ENV PATH="/app/.venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/tmp
WORKDIR /app/services/django-systems
USER 10001:10001
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/lb-entrypoint"]
# The API. The worker and the release step override this command (docker-compose.yml).
# No Server header: nothing outside needs to learn what is serving. One process, because
# the box has two cores and a dozen services to share them.
CMD ["uvicorn", "config.asgi:application", "--host", "0.0.0.0", "--port", "8000", "--no-server-header", "--timeout-keep-alive", "65", "--timeout-graceful-shutdown", "10"]
