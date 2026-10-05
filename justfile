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

# Run the site on http://localhost:3000 against the mock back end (http://127.0.0.1:8120): every demo works with no back end, model or keys.
dev-mock:
    pnpm --filter @lb/web dev:mock

# Run the AI gateway with reload on http://127.0.0.1:8080 (settings in services/gateway/.env).
gateway:
    pnpm --filter @lb/gateway dev

# Make a service key pair or mint a service token for local gateway calls.
gateway-token *args:
    pnpm --silent --filter @lb/gateway token {{args}}

# Lint every TypeScript, Vue and Python package, and check every Python docstring.
lint:
    pnpm lint
    uv run ruff check python scripts services/django-systems services/flask-systems infra
    uv run ruff format --check python scripts services/django-systems services/flask-systems infra
    uv run python scripts/check_docstrings.py

# Format the Python code with Ruff and apply its safe fixes.
format:
    uv run ruff format python scripts services/django-systems services/flask-systems infra
    uv run ruff check --fix python scripts services/django-systems services/flask-systems infra

# The Django and Flask services run mypy from their own folders, where their settings,
# plugins and imports live.
# Type-check every package: vue-tsc and tsc for TypeScript, mypy for Python.
typecheck:
    pnpm typecheck
    uv run mypy python/lb-common scripts infra/docker/python-healthcheck.py infra/caddy/test-upstream.py
    uv run --directory services/django-systems mypy .
    uv run --directory services/flask-systems mypy . ../../infra/docker/flask-seed.py

# Integration tests start Redis and Postgres with Docker, or use LB_TEST_REDIS_URL and
# LB_TEST_DATABASE_URL when they are set.
# Run every unit, integration and contract test suite, TypeScript and Python.
test:
    pnpm test
    uv run pytest
    uv run --directory services/django-systems pytest
    uv run --directory services/flask-systems pytest

# The WebSocket frame limit (8 KB) stops an oversized frame before the application reads it.
# Run the Django systems' API and WebSockets with reload on http://127.0.0.1:8001 (settings in services/django-systems/.env).
django:
    uv run --directory services/django-systems --env-file .env uvicorn config.asgi:application --reload --port 8001 --ws-max-size 8192

# Run the Celery worker with its scheduler (the ticket pipeline, the 24-hour sweeps, the nightly reseed, LB-02's hold sweep and calendar reset).
worker:
    uv run --directory services/django-systems --env-file .env celery -A config worker --beat --loglevel INFO

# Write the Django systems' OpenAPI schema to services/django-systems/openapi.json, for the site's typed client.
openapi:
    uv run --directory services/django-systems --env-file .env python manage.py export_openapi

# Create or update every Django system's schema (settings in services/django-systems/.env).
migrate:
    uv run --directory services/django-systems --env-file .env python manage.py migrate --database lb01
    uv run --directory services/django-systems --env-file .env python manage.py migrate --database lb02
    uv run --directory services/django-systems --env-file .env python manage.py migrate --database lb09

# `--today YYYY-MM-DD` pins the day that order dates and LB-02's calendar are counted from.
# Load the synthetic Basalt & Bean data into every system, replacing what the files no longer hold.
seed *args:
    uv run --directory services/django-systems --env-file .env python manage.py seed_lb01 {{args}}
    uv run --directory services/django-systems --env-file .env python manage.py seed_lb02 {{args}}

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

# Needs the gateway with provider keys, and the calendar seeded (`just seed`). A full run takes at most 247 calls
# (about eight a case); `--samples` or `--case ID` run fewer. It fails unless every case passes (`--min-pass-rate`).
# Run LB-02's golden set through the live concierge and grade it by rules.
eval-lb02 *args:
    uv run --directory services/django-systems --env-file .env python manage.py eval_lb02 {{args}}

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

# `--check` only says whether the committed documents, their manifest and the golden set are current with the generator.
# Draw LB-03's synthetic invoices, receipts and photographs, their manifest and its golden set.
seed-lb03 *args:
    uv run --directory services/flask-systems --env-file .env python manage.py seed_lb03 {{args}}

# Needs the gateway with provider keys, and costs two to five calls a document (about 215 for the set): `--samples` or `--case ID` run fewer, `--pause SECONDS` paces them.
# Put LB-03's golden set to the live pipeline and grade it by rules.
eval-lb03 *args:
    uv run --directory services/flask-systems --env-file .env python manage.py eval_lb03 {{args}}

# Needs no model and spends no call: it reads about forty documents at a few seconds each. `--check` compares with evals/lb03/ocr-baseline.json.
# Measure the OCR on LB-03's synthetic documents with the real caged worker.
ocr-lb03 *args:
    uv run --directory services/flask-systems --env-file .env python manage.py ocr_lb03 {{args}}

# Safe to run at any time, and twice. The service does the same every minute (settings in services/flask-systems/.env).
# Delete LB-03's files and documents that are past their hour, and end the documents a dead worker lost.
sweep-lb03:
    uv run --directory services/flask-systems --env-file .env python manage.py sweep_lb03

# Run the Node systems' API (LB-08) with reload on http://127.0.0.1:8002 (settings in services/node-systems/.env).
node-api:
    pnpm --filter @lb/node-systems dev

# Run the Node systems' BullMQ workers with their sweep (settings in services/node-systems/.env).
node-worker:
    pnpm --filter @lb/node-systems worker

# Create or update every Node system's Postgres schema (settings in services/node-systems/.env).
node-migrate:
    pnpm --filter @lb/node-systems migrate

# Load the Node systems' synthetic data (LB-08's stock list), replacing what the files no longer hold.
node-seed:
    pnpm --filter @lb/node-systems seed

# Write the Node systems' OpenAPI schema to services/node-systems/openapi.json, for the site's typed client.
node-openapi:
    pnpm --filter @lb/node-systems openapi

# Needs the gateway with provider keys, and costs at most two calls a case: `--samples` or `--case ID` run fewer.
# Run LB-08's golden set through the live pipeline and grade it by rules.
eval-lb08 *args:
    pnpm --filter @lb/node-systems eval:lb08 {{args}}

# Needs the gateway with provider keys, and costs at most five calls a contract and one for its redline: four contracts are reviewed, so about 24 calls; `--samples` or `--case ID` run fewer, `--no-redlines` leaves the redlines out.
# Run LB-04's golden set through the live pipeline and grade it by rules.
eval-lb04 *args:
    pnpm --filter @lb/node-systems eval:lb04 {{args}}

# Needs the gateway with provider keys, and costs 9 calls a case on a clean run and 15 at the cap: eight cases, about 72 calls; `--samples` or `--case ID` run fewer.
# Run LB-06's golden set through the whole simulator and the live agents, and grade it by rules.
eval-lb06 *args:
    pnpm --filter @lb/node-systems eval:lb06 {{args}}

# Needs the gateway with provider keys and LB-07's sandbox running (`just lb07-sandbox`); at most seven calls a case, about 77 for the eleven cases; `--samples` or `--case ID` run fewer.
# Run LB-07's golden set through the live agent, the real sandbox browser and the staging shop, and grade it by rules.
eval-lb07 *args:
    pnpm --filter @lb/node-systems eval:lb07 {{args}}

# Needs a Chromium (LB07_BROWSER_PATH, or Playwright's own install) and LB07_SHOP_TOKEN_KEY; settings in services/node-systems/.env.
# Run LB-07's sandbox: the staging shop (loopback) and the browser runner's API in one process, as the container runs it.
lb07-sandbox:
    pnpm --filter @lb/node-systems sandbox

# Needs a Chromium (PLAYWRIGHT_CHROMIUM_EXECUTABLE, or Playwright's own install); no model, no database.
# Run the tests that drive LB-07's runner on a real Chromium over the real staging shop.
test-lb07-browser:
    pnpm --filter @lb/node-systems test:browser

# Needs Docker, jq, age and `just install`; builds the image unless LB_SANDBOX_IMAGE names one; about five minutes.
# Prove LB-07's sandbox container under the Compose policy: golden plans from another container, no route out, memory, restart.
test-lb07-sandbox:
    infra/sandbox/test.sh

# Check every dependency, npm and Python, against known vulnerabilities.
audit:
    pnpm audit --audit-level high
    uv audit --preview-features audit-command

# The journeys run against a test build, which differs from the production build in two ways: it accepts a
# fixed stand-in for a Turnstile token, and it bundles the test recordings (`just check-build` proves the
# production build holds no trace of either). Playwright starts it with the mock back end and throwaway keys.
# Build the site for testing, then run the end-to-end, accessibility and security-header tests.
e2e:
    pnpm --filter @lb/web build:e2e
    pnpm --filter @lb/web e2e

# Regenerate the boards' curated samples from each golden set's `sample: true` cases, and LB-02's installable-app files (`just check` fails while they are stale).
samples:
    pnpm --filter @lb/web samples

# Make the recordings the end-to-end tests replay, by running samples of the boards on the mock (apps/web/e2e/fixtures/recordings).
record-fixtures:
    pnpm --filter @lb/web record:fixtures

# Needs a live back end, the gateway and the site's keys (docs/DEPLOY.md, parts 6 and 10): set LB_API_URL,
# LB_GATEWAY_URL, LB_WEB_SIGNING_KEY_FILE and LB_GATEWAY_SERVICE_KEY_FILE. Spends the sample's model calls once.
# Run a curated sample against a live back end and save the recording the demo replays (apps/web/recordings).
record-sample system sample:
    pnpm --filter @lb/web record-sample {{system}} {{sample}}

# Check that the production build holds no trace of the test build's Turnstile stand-in (run `just build` first).
check-build:
    pnpm --filter @lb/web check:build

# Fail if any generated file is stale (the CI drift check).
check:
    pnpm check

# Regenerate the icon sprite and registry after editing packages/icons/svg.
icons:
    pnpm --filter @lb/icons build

# Make the shared corpus of visitor tokens again, after a rule of the token check changes (`just check` fails while it is stale).
# Every verifier's tests run the file: @lb/common's, python/lb-common's, and the Django, Flask and Node systems'.
visitor-tokens:
    pnpm --filter @lb/common visitor-tokens

# The local platform is hardened as on the box and needs Docker: run `just stack-secrets` once,
# then `just stack up -d --wait`, and Caddy answers on http://127.0.0.1:8180.
# Run a docker compose command on the local stack, such as `just stack ps` or `just stack logs gateway`.
stack *args:
    LB_STACK=dev infra/scripts/compose.sh {{args}}

# Make throwaway secrets for the local stack in infra/.dev; `--again` replaces them with new ones.
stack-secrets *args:
    infra/scripts/dev-secrets.sh {{args}}

# Check a running local stack from the inside: health, the routes through Caddy, LB-07's sandbox reaching nothing, an empty Redis ACL log.
stack-smoke:
    LB_STACK=dev infra/scripts/smoke.sh

# Needs shellcheck, jq, Docker, hadolint and actionlint (`infra/scripts/install-tool.sh hadolint actionlint`).
# Check the infrastructure statically: shell, Dockerfiles, workflows, image pins, Compose rules, Caddyfile, units.
infra-check:
    infra/scripts/check.sh

# The last four need Docker, and the Redis ACL proof and the sandbox's run the services' own code, so run `just install` first.
# Run the infrastructure's tests: secrets, deploy decisions, pinning, Postgres roles, Caddy routing, the Redis ACL, LB-07's sandbox.
infra-test:
    infra/scripts/test-secrets.sh
    infra/scripts/test-deploy.sh
    infra/scripts/test-pin-images.sh
    infra/postgres/test-roles.sh
    infra/caddy/test.sh
    infra/redis/test-acl.sh
    infra/sandbox/test.sh

# Pin every third-party image to the digest its tag names today, then review the diff (CI fails on an unpinned one).
pin-images:
    infra/scripts/pin-images.sh

# Make your age key outside the repository, and list its public half in .sops.yaml.
secrets-init:
    infra/scripts/secrets.sh init

# Create infra/secrets/<name>.enc.env from its template: random values are made, then your editor opens for the rest.
secrets-new name:
    infra/scripts/secrets.sh new {{name}}

# Edit an encrypted secrets file in $EDITOR, such as `just secrets-edit gateway`, and check it afterwards.
secrets-edit name:
    infra/scripts/secrets.sh edit {{name}}

# Compare every encrypted secrets file with its template (variable names only, never values).
secrets-check:
    infra/scripts/secrets.sh check

# Let one more age public key, such as the box's, open every secrets file.
secrets-add-recipient label key:
    infra/scripts/secrets.sh add-recipient {{label}} {{key}}

# Lock every secrets file to the keys now listed in .sops.yaml, with a new data key (after removing a key).
secrets-rekey:
    infra/scripts/secrets.sh rekey

# Test the secrets tooling with the real sops and age, in a throwaway copy with throwaway keys.
secrets-test:
    infra/scripts/test-secrets.sh

# Print a random hex token (24 bytes by default), for a password or key you edit in by hand.
secret-token *bytes:
    infra/scripts/secrets.sh token {{bytes}}

# Speak LB-09's scripted meetings (data/seed/lb09) with Flite, an offline text-to-speech, into data/seed/lb09/audio
# with a manifest of each turn's timing; `--check` only checks the committed audio against its manifest (CI runs it).
tts-lb09 *args:
    uv run --directory services/django-systems --env-file .env python manage.py synth_lb09 {{args}}

# Run LB-09's golden set through the live labelling and extraction (each scripted meeting as the transcript a
# transcriber gives, timed by the committed audio's manifest) and grade it by rules against the gate in
# evals/lb09/golden.yaml. Two chat calls a case, plus a repair each; `--samples` or `--case ID` run fewer.
eval-lb09 *args:
    uv run --directory services/django-systems --env-file .env python manage.py eval_lb09 {{args}}

# Transcribe LB-09's committed meetings for real, in fast mode (through the gateway) or `--mode private`
# (faster-whisper on this machine, with LB09_WHISPER_DIR set), and report the word error rate against the scripts.
wer-lb09 *args:
    uv run --directory services/django-systems --env-file .env python manage.py wer_lb09 {{args}}
