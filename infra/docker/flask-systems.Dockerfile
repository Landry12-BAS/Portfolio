# The Flask systems image (services/flask-systems): the API (gunicorn) for LB-03 and LB-05,
# the database migration and the one-shot job that generates LB-05's data
# (infra/docker-compose.yml). One image, three commands. Build context: the repository root.
#
# The build stage installs the production dependencies from uv.lock into a virtualenv; the
# runtime stage copies that virtualenv and the code into a slim Python image and runs as an
# unprivileged user. The image keeps the repository's layout (services/flask-systems, data/seed
# and evals under /app), because the settings find the semantic layer, LB-03's chart of
# accounts and its golden set relative to it. Only what the two systems read at run time is
# copied: LB-05's seed folder, and from LB-03's the chart of accounts, the manifest and the
# golden set (the samples a duplicate is compared with), not the 4 MB of documents, pictures
# and fonts that the generator and the evals use. The OCR needs no system library: RapidOCR's
# models, pdfium, OpenCV and ONNX Runtime all come inside their wheels.
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
RUN uv sync --frozen --no-editable --no-install-workspace --package flask-systems
# Layer 2: the shared library and the service, installed into the same environment.
COPY python python
COPY services/flask-systems services/flask-systems
# Bytecode is compiled now, because the runtime filesystem is read-only; "unchecked-hash"
# keeps it valid whatever the file timestamps become after the stage copy.
RUN uv sync --frozen --no-editable --package flask-systems \
 && python -m compileall -q --invalidation-mode unchecked-hash services/flask-systems

FROM python:3.13.15-slim-trixie@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b AS runtime
LABEL org.opencontainers.image.title="lb-flask-systems" \
      org.opencontainers.image.description="The Flask systems (LB-03 Invoice Reader, LB-05 Data Analyst): API, migration and data generation." \
      org.opencontainers.image.source="https://github.com/Landry12-BAS/Portfolio"
# Debian's security fixes that this base image does not have yet: pcre2 and OpenSSL were fixed
# after python:3.13.15-slim-trixie was last built (CVE-2026-103111, CVE-2026-84782), and the
# scan in images.yml stops a release that ships a HIGH finding with a fix. Only these four
# packages are upgraded, to the versions Debian 13 has at build time: pinning them would break
# the build at the next fix. Take this step out once `just pin-images` moves the base to a
# build that has them, when it would upgrade nothing.
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends --only-upgrade libpcre2-8-0 libssl3t64 openssl openssl-provider-legacy \
 && rm -rf /var/lib/apt/lists/*
# An unprivileged user with no home and no shell. The numeric id is what docker-compose.yml
# gives the tmpfs mounts, so the two must agree. /warehouse is where LB-05's dataset lives:
# the seed job writes it there and the API reads it, each as a mount of one named volume.
# The folder is made here, owned by this user, because a new named volume takes its owner
# from the image's folder at the mount point.
RUN groupadd --system --gid 10001 lb \
 && useradd --system --uid 10001 --gid lb --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin lb \
 && python -m pip uninstall --yes pip >/dev/null 2>&1 \
 && rm -f /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.13 \
 && mkdir /warehouse \
 && chown 10001:10001 /warehouse
COPY --from=build /app/.venv /app/.venv
COPY --from=build /repo/services/flask-systems /app/services/flask-systems
COPY data/seed/lb05 /app/data/seed/lb05
COPY data/seed/lb03/chart_of_accounts.yaml data/seed/lb03/manifest.json /app/data/seed/lb03/
COPY evals/lb03/golden.yaml /app/evals/lb03/golden.yaml
# LB-10 serves the eval packs and the baselines; its nightly commands run elsewhere.
COPY evals/packs /app/evals/packs
COPY evals/baselines /app/evals/baselines
# The data job sits next to manage.py, so it imports the service the way manage.py does.
COPY --chmod=0444 infra/docker/flask-seed.py /app/services/flask-systems/seed_warehouse.py
COPY --chmod=0555 infra/docker/python-entrypoint.sh /usr/local/bin/lb-entrypoint
COPY --chmod=0555 infra/docker/python-healthcheck.py /usr/local/bin/lb-healthcheck
ENV PATH="/app/.venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/tmp
WORKDIR /app/services/flask-systems
USER 10001:10001
EXPOSE 8102
ENTRYPOINT ["/usr/local/bin/lb-entrypoint"]
# The API. The migration and the data job override this command (docker-compose.yml).
# gunicorn.conf.py holds the rest: one worker of eight threads, because DuckDB's memory
# limit is per process and the box has two cores to share. GUNICORN_BIND is set to the
# container's address in docker-compose.yml, since the file's default is the loopback.
CMD ["gunicorn", "--config", "gunicorn.conf.py", "wsgi:app"]
