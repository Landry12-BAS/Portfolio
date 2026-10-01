# One command surface for the monorepo. Run `just` to list the recipes.

default:
    @just --list

# Install every workspace dependency: pnpm for TypeScript, uv for Python.
install:
    pnpm install
    uv sync

# Run the site with hot reload on http://localhost:3000.
dev:
    pnpm --filter @lb/web dev

# Build the site for production.
build:
    pnpm --filter @lb/web build

# Run the AI gateway with reload on http://127.0.0.1:8080 (settings in services/gateway/.env).
gateway:
    pnpm --filter @lb/gateway dev

# Make a service key pair or mint a service token for local gateway calls.
gateway-token *args:
    pnpm --silent --filter @lb/gateway token {{args}}

# Lint every TypeScript, Vue and Python package, and check every Python docstring.
lint:
    pnpm lint
    uv run ruff check python scripts services/django-systems services/flask-systems
    uv run ruff format --check python scripts services/django-systems services/flask-systems
    uv run python scripts/check_docstrings.py

# Format the Python code with Ruff and apply its safe fixes.
format:
    uv run ruff format python scripts services/django-systems services/flask-systems
    uv run ruff check --fix python scripts services/django-systems services/flask-systems

# The Django and Flask services run mypy from their own folders, where their settings,
# plugins and imports live.
# Type-check every package: vue-tsc and tsc for TypeScript, mypy for Python.
typecheck:
    pnpm typecheck
    uv run mypy python/lb-common scripts
    uv run --directory services/django-systems mypy .
    uv run --directory services/flask-systems mypy .

# Integration tests start Redis and Postgres with Docker, or use LB_TEST_REDIS_URL and
# LB_TEST_DATABASE_URL when they are set.
# Run every unit, integration and contract test suite, TypeScript and Python.
test:
    pnpm test
    uv run pytest
    uv run --directory services/django-systems pytest
    uv run --directory services/flask-systems pytest

# Run the Django systems' API with reload on http://127.0.0.1:8001 (settings in services/django-systems/.env).
django:
    uv run --directory services/django-systems --env-file .env uvicorn config.asgi:application --reload --port 8001

# Run the Celery worker with its scheduler (the ticket pipeline, the 24-hour sweep, the nightly reseed).
worker:
    uv run --directory services/django-systems --env-file .env celery -A config worker --beat --loglevel INFO

# Write the Django systems' OpenAPI schema to services/django-systems/openapi.json, for the site's typed client.
openapi:
    uv run --directory services/django-systems --env-file .env python manage.py export_openapi

# Create or update every Django system's schema (settings in services/django-systems/.env).
migrate:
    uv run --directory services/django-systems --env-file .env python manage.py migrate --database lb01

# Load the synthetic Basalt & Bean data into every system, replacing what the files no longer hold.
seed *args:
    uv run --directory services/django-systems --env-file .env python manage.py seed_lb01 {{args}}

# Needs the gateway running with a Workers AI key; commit the two files it writes.
# Record the vectors LB-01's search needs, for the passages and golden-set texts that changed.
embed *args:
    uv run --directory services/django-systems --env-file .env python manage.py embed_lb01 {{args}}

# Measure LB-01's search recall on the golden set against its gate (run `just seed` first).
eval-search:
    uv run --directory services/django-systems --env-file .env python manage.py eval_lb01_search

# Needs the gateway with provider keys, and costs about five calls a case: `--samples` or `--case ID` run fewer.
# Run LB-01's golden set through the live pipeline and grade it by rules.
eval-lb01 *args:
    uv run --directory services/django-systems --env-file .env python manage.py eval_lb01 {{args}}

# Run the Flask systems' API with gunicorn and reload on http://127.0.0.1:8102 (settings in services/flask-systems/.env).
flask:
    uv run --directory services/flask-systems --env-file .env gunicorn --config gunicorn.conf.py --reload wsgi:app

# Write the Flask systems' OpenAPI document to services/flask-systems/openapi.json, for the site's typed client.
openapi-flask:
    uv run --directory services/flask-systems --env-file .env python manage.py export_openapi

# Create or update every Flask system's Postgres schema (settings in services/flask-systems/.env).
migrate-flask:
    uv run --directory services/flask-systems --env-file .env python manage.py migrate

# `--size small` makes a quick one, `--today YYYY-MM-DD` pins the last day, and `--data DIR` the folder.
# Generate LB-05's synthetic sales data (about two million orders) as Parquet and a read-only DuckDB file.
seed-lb05 *args:
    uv run --directory services/flask-systems --env-file .env python manage.py seed_lb05 {{args}}

# Needs the gateway with provider keys, and costs two to four calls a question (five at most): `--samples` or `--case ID` run fewer.
# Put LB-05's golden set, or with `--adversarial` its attacks, to the live pipeline and grade it by rules.
eval-lb05 *args:
    uv run --directory services/flask-systems --env-file .env python manage.py eval_lb05 {{args}}

# Check every dependency, npm and Python, against known vulnerabilities.
audit:
    pnpm audit --audit-level high
    uv audit --preview-features audit-command

# Build the site, then run the end-to-end, accessibility and security-header tests.
e2e: build
    pnpm --filter @lb/web e2e

# Fail if any generated file is stale (the CI drift check).
check:
    pnpm check

# Regenerate the icon sprite and registry after editing packages/icons/svg.
icons:
    pnpm --filter @lb/icons build
