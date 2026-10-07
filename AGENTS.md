# AGENTS.md

Guidance for coding agents working in this repository.

## Project

A live AI portfolio: ten AI systems (LB-01 to LB-10) built for one fictional company,
Basalt & Bean Coffee Co., on a shared platform (LB-00). Every system runs live on the
main site and any visitor can try it, inspect its trace, and try to break it.

- Stack and the reasons behind it: [`docs/STACK.md`](docs/STACK.md)
- How each system is built and shipped: [`docs/PLAYBOOK.md`](docs/PLAYBOOK.md)
- Brand: Landry Bodjona, logo mark LB ([`brand/`](brand/README.md)). Part numbers and
  internal names use the LB prefix (`LB-01`, `lb-fast`).

Status: all ten systems are built and on the site. Each is a back end, an evaluation board in English
and Czech at `/systems/lb-NN/board`, a datasheet and tests; each service's README says how it works and
what it measured, and what it did not. Provider keys reach the development environment only as network
secrets its proxy adds (never in the repository, a session or the site's settings), and the curated
samples were run for real through the gateway on a development machine's local stack: most of them have a
recording in `apps/web/recordings`, whose README lists the ones still missing and why. No live eval
score and no live baseline exist yet (LB-09's private mode and LB-01's search recall with recorded vectors
are the measured numbers), and every doc says where a number was measured and on which machine.

| Part | System | Where it lives | What to know before touching it |
|---|---|---|---|
| LB-00 | The platform | `services/gateway` (the AI gateway), `python/lb-common` and `packages/common` (its clients), `packages/contracts` (Zod schemas), `packages/api-clients` (typed clients and the mock back end the site's tests run against), `packages/ui` and `packages/icons`, `apps/web` (the site: its Nitro server, the evaluation-board kit with the Scope and the replay player), `infra/` | [gateway](services/gateway/README.md), [web](apps/web/README.md), [deploy](docs/DEPLOY.md), [security](docs/SECURITY.md) |
| LB-01 | Support Desk Agent | `services/django-systems`, `lb01` | hybrid search, ticket pipeline, Celery worker |
| LB-02 | Booking Concierge | `services/django-systems`, `lb02` | the database forbids double bookings; WebSocket; installable as an app |
| LB-09 | Meeting Recorder | `services/django-systems`, `lb09` | audio decoded in a child process under kernel limits; fast mode through the gateway, private mode with faster-whisper on the box (measured: [README](services/django-systems/README.md)); private transcriptions take turns |
| LB-03 | Invoice Reader | `services/flask-systems`, `lb03` | OCR in a caged subprocess, never in the web process; eleven checks; files expire after an hour |
| LB-05 | Data Analyst | `services/flask-systems`, `lb05` | DuckDB, a semantic layer, six layers of SQL safety |
| LB-10 | Eval Lab | `services/flask-systems`, `lb10`; packs in `evals/packs` | a visitor's edited prompt against production's on ten cases, graded by rules, bootstrap intervals; nightly, judge and CI gate exist but have not run live |
| LB-04 | Contract Radar | `services/node-systems`, `lb04` | PDFs read in a worker thread; every quote checked against the contract's text |
| LB-06 | Incident Commander | `services/node-systems`, `lb06` | a seeded, event-sourced shop simulator; actions only on the visitor's approval; WebSocket |
| LB-07 | QA Engineer | `services/node-systems`, `lb07`, and the `lb07-sandbox` container | the browser runs in its own container (`just test-lb07-sandbox` proves it); the model never writes code that runs |
| LB-08 | Automation Studio | `services/node-systems`, `lb08` | workflow graphs checked by one schema; BullMQ engine with replay |

The shared design lives in the playbook ([`docs/PLAYBOOK.md`](docs/PLAYBOOK.md)) and in the READMEs of
`services/*`, `packages/*` and `apps/web`. The box's memory is counted in waves (a deploy's jobs run in
three waves and only the biggest counts, with the nightly backup under the deploy's lock): `just
infra-check` fails a change that breaks it, and `docs/DEPLOY.md` says why.

What is not done: the samples still without a recording (`just record-sample <system> <sample>`), the
live evals (`just eval-lb0N`, `just wer-lb09` in fast mode) and the nightly, judge and gate of LB-10, which
the free tiers' daily budgets spread over several days; and, needing the owner (the box or an account), the
deploy secrets and the Cloudflare rules (`docs/DEPLOY.md`), and timings and memory on the box's Ampere A1
(everything measured so far was measured on an x86-64 development machine).

Add each new command to the Commands section in the change that introduces it.

## Git rules (owner's instruction, mandatory)

- Every commit is authored and committed as
  `Tchiwa-Kibolou BODJONA <78790172+Landry12-BAS@users.noreply.github.com>`.
- Commits are never authored as an AI assistant, and nothing carries AI attribution:
  no `Co-Authored-By:` trailer naming an assistant and no session-link trailer (a
  `…-Session:` line) in commit messages, and no "Generated with …" or "Generated by …"
  line in pull request descriptions, reviews or comments. If a tool appends such a line
  on its own, remove it afterwards.
- Branch names carry the owner's prefix, never an AI name: `kibo/<topic>`, such as
  `kibo/lb-01-django`. A session that starts on an assistant-named branch moves its
  work to a `kibo/` branch before pushing.
- Use the GitHub noreply address, never a personal email: the owner keeps email
  privacy on, and GitHub can reject pushes that expose a private address.
- Cloud sessions start with the environment's identity and its commit-signing key.
  Before the first commit in a new environment, run:

  ```sh
  git config user.name  "Tchiwa-Kibolou BODJONA"
  git config user.email "78790172+Landry12-BAS@users.noreply.github.com"
  git config commit.gpgsign false   # the environment key is not on the owner's account,
                                    # so signed commits would show as "Unverified"
  git var GIT_AUTHOR_IDENT && git var GIT_COMMITTER_IDENT   # verify both lines
  ```

## Architecture rules

- Every model call goes through the AI gateway (`services/gateway`) using a virtual
  model alias such as `lb-fast` or `lb-tools`. Services never call a provider directly
  and never hold provider keys.
- Treat model output as untrusted input: validate structured output against its
  schema (Zod or Pydantic) and repair or reject, never pass it through unchecked.
- Free-tier limits are design inputs. A feature that adds model calls must state its
  calls per run and fit the budgets in `services/gateway/routing.yaml`.
- Demos open on curated samples whose results are cached. Custom input is the only
  path that spends provider quota.
- Synthetic data only. Visitor uploads expire through storage lifecycle rules.
- Visitor content only goes to providers that don't train on inputs; `routing.yaml`
  marks each provider. The NVIDIA API catalog is for private experiments only: its
  trial terms forbid production use.
- One database, one schema per system. Each runtime owns its migrations: Django
  migrations, Alembic for Flask, Drizzle for Node. Never write across schemas.

## Security rules

- No accounts: never add sign-up, login or logout for visitors. Visitors stay
  anonymous; protection comes from Turnstile, signed sessions and quotas.
- The server opens no inbound ports (Cloudflare Tunnel). Owner tools and SSH are
  reachable only over Tailscale, never on a public hostname.
- Every response carries the headers in `docs/SECURITY.md`: nonce-based CSP with
  Trusted Types, no framing. Never use `v-html`, and never execute model output.
- Secrets live in SOPS-encrypted files or deploy secrets, never in code, logs or
  prompts.

## Code conventions

- Front end: Nuxt with Pinia (owner's decision). Vue single-file components with
  `<script setup lang="ts">`; no TSX or JSX anywhere in the repo.
- TypeScript: strict mode, ESLint (flat config) for lint and format, Zod at every
  boundary.
- Python: 3.13, one uv workspace (root `pyproject.toml`), Ruff for lint and format,
  strict mypy (with django-stubs), Pydantic v2, pytest. Model calls go through
  `lb_common.gateway` inside a `run_scope`, never straight to a provider.
- Humanized code (owner's instruction): plain names, small functions, no clever
  one-liners. Code should read like a clear explanation of what it does.
- Every function, class, method, interface and type alias carries a doc comment that
  says what it does (`/** … */` in TypeScript, a docstring in Python), plus why when
  that isn't obvious. Every file opens with a comment saying what it holds, and every
  Vue component's `<script setup>` opens with one saying what the component is. Lint
  enforces the doc comments (`jsdoc/require-jsdoc`); for Python, Ruff's pydocstyle rules
  cover public names and `scripts/check_docstrings.py` covers everything else.
- Security first: validate every input at the boundary, fail closed, grant the least
  privilege, and never build code, markup, SQL or regexes from strings. Lint runs
  eslint-plugin-security, eslint-plugin-regexp (catastrophic backtracking) and Ruff's
  bandit rules, and CI runs `pnpm audit` and `uv audit`.
- No placeholders or pseudo-code in committed code.
- Every change ships with tests at the right level: unit, integration
  (Testcontainers), or end to end (Playwright). Prompt changes pass the eval gate.

## Languages

- English is the default (`/`) and Czech the second language (`/cs`), decision D6.
  Every visible string lives in `apps/web/i18n/locales/en.ts` and `cs.ts`, or in a module
  they import: the board kit and each system's board keep theirs in
  `i18n/locales/boards/<name>.en.ts` and `.cs.ts`. `cs.ts` must satisfy the English
  shape, so a missing translation fails the type check.
- Datasheet text: English in `apps/web/shared/data/systems.ts` (the source of truth),
  Czech in `systems.cs.ts`. Unit tests check that the two match field by field.
- The language lives in the URL, never in a cookie. Links use `<NuxtLinkLocale>` so a
  visitor stays in their language.
- Czech text is typeset with `vlna` (`shared/typography.ts`): no line may end on a
  single-letter word.

## Design rules

- Light theme by default; a dark theme follows the visitor's system setting, with a
  toggle. Both follow electronic component datasheets: part numbers, spec tables,
  numbered figures, revision history.
- Colors and type come from the tokens in `packages/ui`, and every token has a light
  and a dark value. Archivo (display and text) and Martian Mono (data). No hard-coded
  colors, and no gradients outside the LB mark.
- Signal blue, the logo's ribbon, is the one accent colour. The evaluation board, in
  a deep shade of it, marks live demos and nothing else. A chart that must tell series
  apart uses the eight `--lb-series-*` tokens (the first is signal blue, so a chart of
  one series is blue), for data marks only.
- Icons come only from `@lb/icons`, drawn in the logo's pattern. No emoji, no
  third-party icon sets.
- The LB mark comes only from the files in `brand/`: `lb-mark-light.svg` in the light
  theme, `lb-mark-dark.svg` in the dark theme. Never redraw, recolour or retype it.
- WCAG 2.2 AA in both themes, full keyboard use, `prefers-reduced-motion` respected.

## Commands

Everything runs through the root `justfile`, which wraps the pnpm scripts and uv (Node
22.18 or later, pnpm 10, uv 0.12 with Python 3.13; `.mise.toml` pins the versions CI uses).

| Command | What it does |
|---|---|
| `just install` | Install every workspace dependency (`pnpm install`, then `uv sync`) |
| `just dev` | Run the site with hot reload on http://localhost:3000 |
| `just dev-mock` | Run the site on http://localhost:3000 against the mock back end (http://127.0.0.1:8120), with throwaway keys: every demo works with no back end, model or keys |
| `just build` | Build the site for production (`apps/web/.output`) |
| `just gateway` | Run the AI gateway with reload on http://127.0.0.1:8080 (settings in `services/gateway/.env`, from `.env.example`) |
| `just gateway-token keygen\|mint <service> <key-file>` | Make a service key pair, or mint a service token for local gateway calls |
| `just lint` | ESLint on every TypeScript and Vue package; Ruff and the docstring check on Python |
| `just format` | Format the Python code with Ruff and apply its safe fixes (ESLint formats TypeScript) |
| `just typecheck` | Strict type-check with `vue-tsc` and `tsc` (the site's scripts, tests and journeys included), and mypy for Python |
| `just test` | Every Vitest and pytest suite, unit, integration and the gateway contract tests |
| `just django` | Run the Django systems' API and WebSockets with reload on http://127.0.0.1:8001 (settings in `services/django-systems/.env`, from `.env.example`; frames over 8 KB are refused) |
| `just worker` | Run the Celery worker with its scheduler: the ticket pipeline, the 24-hour sweeps, the nightly reseed, LB-02's minute-by-minute hold sweep and nightly calendar reset, and LB-09's meeting pipeline and five-minute sweep |
| `just openapi` | Regenerate `services/django-systems/openapi.json` after an API change (a test fails while it is stale) |
| `just migrate` | Create or update each Django system's schema, LB-01, LB-02 and LB-09 (settings in `services/django-systems/.env`, from `.env.example`) |
| `just seed [--today YYYY-MM-DD]` | Load the synthetic Basalt & Bean data from `data/seed` into LB-01 and LB-02; `--today` pins the day that relative order dates and LB-02's calendar count from |
| `just embed [--again]` | Record the vectors LB-01's search needs through the gateway (only for text that changed); commit the two files it writes |
| `just eval-search` | Measure LB-01's search recall on the golden set against its gate in `evals/lb01/search-baseline.yaml` |
| `just eval-lb01 [--samples] [--case ID]` | Run LB-01's golden set through the live pipeline and grade it by rules (about five gateway calls a case; run it when prompts or routes change) |
| `just eval-lb02 [--samples] [--case ID] [--min-pass-rate N]` | Run LB-02's golden set through the live concierge and grade it by rules, on the seeded calendar (about eight gateway calls a case, at most 247 for the whole set; it fails unless every case passes, and prints what a booking cost; run it when prompts or routes change) |
| `just flask` | Run the Flask systems' API with gunicorn and reload on http://127.0.0.1:8102 (settings in `services/flask-systems/.env`, from `.env.example`) |
| `just migrate-flask` | Create or update each Flask system's Postgres schema with Alembic (settings in `services/flask-systems/.env`) |
| `just openapi-flask` | Regenerate `services/flask-systems/openapi.json` after an API change (a test fails while it is stale) |
| `just seed-lb05 [--size small] [--today YYYY-MM-DD] [--data DIR]` | Generate LB-05's synthetic sales data (about two million orders) as Parquet and a read-only DuckDB file in `data/generated/lb05`; the same seed and day give the same data |
| `just eval-lb05 [--samples] [--case ID] [--adversarial]` | Put LB-05's golden set (or, with `--adversarial`, its attacks) to the live pipeline and grade it by rules (two to four gateway calls a question; run it when prompts or routes change; the adversarial run exits 1 unless every attempt was held) |
| `just seed-lb03 [--check]` | Draw LB-03's synthetic invoices, receipts and photographs (`data/seed/lb03`, 43 documents), their manifest and the golden set (`evals/lb03/golden.yaml`) from `lb03/synthetic/content.py`; with `--check`, only say what is out of date (PDFs byte for byte, photographs by what they show) |
| `just eval-lb03 [--samples] [--case ID] [--min-pass-rate N] [--pause SECONDS]` | Put LB-03's golden set to the live pipeline and grade it by rules (two to five gateway calls a document, about 215 for the set, paced by `--pause`; run it when prompts or routes change; it exits 1 below the pass rate or when a hostile or give-up case is not held) |
| `just ocr-lb03 [--case ID] [--workers N] [--json FILE] [--write-baseline] [--check]` | Measure the OCR on LB-03's synthetic documents with the real caged worker (no model call, a couple of minutes): word recall and field boxes by kind of document; `--check` fails when a figure falls more than three points below `evals/lb03/ocr-baseline.json` |
| `just sweep-lb03` | Delete LB-03's files and documents that are past their hour, as the service itself does every minute, and end the documents a dead worker lost; safe to run at any time and twice |
| `just export-pack-lb05 [--check]` | Write the eval pack Eval Lab (LB-10) runs LB-05's SQL writer on (`evals/packs/lb05-sql-writer.yaml`): the production prompt and golden set, materialised, which the export refuses to write unless it renders exactly what the pipeline sends; `--check` only says whether the committed pack is current (`just check` runs it) |
| `just export-packs-lb01 [--check]` | Write the eval packs Eval Lab runs LB-01's ticket classifier and reply drafter on (`evals/packs/lb01-classifier.yaml`, `lb01-drafter.yaml`), from the production prompts, the golden set and the seed files; `--check` as above |
| `just export-pack-lb02 [--check]` | Write the eval pack Eval Lab runs LB-02's planner on (`evals/packs/lb02-planner.yaml`): the first turn of every graded golden conversation, with the tools the details step offers; `--check` as above |
| `just export-pack-lb08 [--check]` | Write the eval pack Eval Lab runs LB-08's workflow generator on (`evals/packs/lb08-generator.yaml`), from the production prompt and the golden set's build and resist cases; `--check` as above (`pnpm check` runs it) |
| `just nightly-lb10 [--pack NAME] [--provider ID] [--cases N] [--out DIR]` | Run every eval pack's production prompt on every provider (OpenRouter included, on synthetic cases) through Eval Lab's pipeline and store the results for its API; `--out` writes the results file the gate, the judge and the advisor read (needs the gateway with provider keys; about 150 calls a night, most of them cached) |
| `just judge-lb10 --results FILE [--pack NAME] [--calibration FILE] [--out DIR]` | Grade a results file's answers with the LLM judge (`lb-judge`), after calibrating it on the hand-labelled set in `evals/judge/calibration.yaml`; its scores count only when it matches eight labels in ten with a kappa above chance, and the report says so either way (needs the gateway) |
| `just gate-lb10 [--results FILE] [--provider ID] [--cases N] [--baselines DIR] [--write-baselines] [--strict]` | Compare fresh eval scores (every pack on Groq and Workers AI, 20 cases each, or a stored results file) with the committed baselines in `evals/baselines` and exit 1 when a score falls below its baseline's lower bound; a pack with no baseline is reported, not graded, unless `--strict`; `--write-baselines` records a measured run |
| `just advise-lb10 --results FILE [--threshold N]` | Say which pinned fallback aliases pass the threshold on every pack of a route (`lb-fast`, `lb-tools`, `lb-reason`) from a nightly results file; advice only, it changes nothing in `routing.yaml` |
| `just sweep-lb10` | Delete LB-10's quota counters of days that are over and its runs older than a week; safe to run at any time and twice |
| `just node-api` | Run the Node systems' API (LB-08) with reload on http://127.0.0.1:8002 (settings in `services/node-systems/.env`, from `.env.example`) |
| `just node-worker` | Run the Node systems' BullMQ workers with their sweep: LB-08's step jobs, the 24-hour deletion of expired workflows and the recovery of lost jobs |
| `just node-migrate` | Create or update each Node system's Postgres schema from its Drizzle migrations (one schema per system) |
| `just node-seed` | Load the Node systems' synthetic data (LB-08's stock list) from `data/seed`, replacing what the files no longer hold |
| `just node-openapi` | Regenerate `services/node-systems/openapi.json` after an API change (a test and `just check` fail while it is stale) |
| `just eval-lb08 [--samples] [--case ID] [--pause SECONDS]` | Run LB-08's golden set through the live pipeline and grade it by rules (at most two gateway calls a case, paced by `--pause`; run it when prompts or routes change) |
| `just eval-lb04 [--samples] [--case ID] [--no-redlines] [--pause SECONDS]` | Run LB-04's golden set (six seed contracts, two of them refused before any model) through the live pipeline and grade it by rules: quotes checked against the contract's own text, planted findings found (a recall gate), a hostile contract's instructions never obeyed (at most five gateway calls a contract and one for its redline, about 24 for the set, paced by `--pause`; run it when prompts or routes change; it exits 1 unless every case passes and recall reaches its gate) |
| `just eval-lb06 [--samples] [--case ID] [--pause SECONDS]` | Run LB-06's golden set (eight incidents: each of the four faults, a second seed for two of them, and a hostile text in the parameters of two) through the whole simulator, the detection and the live agents behind the gateway, and grade it by rules: the cause, the first proposal, the evidence cited, the model calls, the recovery, the postmortem, an injection never obeyed (about nine gateway calls a case, 15 at the cap, about 72 for the set, paced by `--pause`, default 8; run it when prompts or routes change; it exits 1 unless every case passes) |
| `just eval-lb07 [--samples] [--case ID] [--pause SECONDS]` | Run LB-07's golden set (eleven goals: each of the six bugs, all of them at once, a clean shop that must stay clean, a link to another host that must be stopped, a hostile goal, and a re-plan after a wrong name) through the live agent, the real sandbox browser and the staging shop, and grade it by rules: the bugs found by their truth, a clean shop with no finding, the verdict of the red-then-green verification, nothing left the shop, at most eight model calls (at most seven gateway calls a case, about 77 for the set, paced by `--pause`, default 8; needs `just lb07-sandbox` running; run it when prompts or routes change; it exits 1 unless every case passes) |
| `just lb07-sandbox` | Run LB-07's sandbox: the staging shop (on the loopback interface only) and the browser runner's API in one process, as its container runs it (needs a Chromium: `LB07_BROWSER_PATH`, or Playwright's own install; and `LB07_SHOP_TOKEN_KEY`, the key the service signs each run's bug token with; settings in `services/node-systems/.env`) |
| `just test-lb07-browser` | Run the tests that drive LB-07's runner on a real Chromium over the real staging shop (point `PLAYWRIGHT_CHROMIUM_EXECUTABLE` at a Chromium where one is preinstalled; no model, no database) |
| `just test-lb07-sandbox` | Prove LB-07's sandbox container (`infra/sandbox/test.sh`): build its image (or test `LB_SANDBOX_IMAGE`), start it with Compose from the real file under every flag of the policy, run golden plans through its runner from a second container, show it reaches no public address or name, no other container and not the host, run the heaviest plan five times inside its memory limit, and watch it restart after its share of runs (Docker, jq, age and `just install`; about five minutes) |
| `just audit` | Check npm and Python dependencies against known vulnerabilities |
| `just e2e` | Build the site's test build (the production build plus a stand-in for Turnstile and the mock recordings), then run the Playwright journeys, axe checks and security-header tests against it and the mock back end |
| `just check-build` | Fail if the production build (`just build` first) holds any trace of the test build's Turnstile stand-in |
| `just samples` | Regenerate the boards' curated samples (`apps/web/shared/data/samples/`) from each golden set's `sample: true` cases (LB-05 also gets its attacks from the adversarial set; LB-04's six come from its sample list, `data/seed/lb04/samples.yaml`, and its golden set; LB-10's prepared edits from `data/seed/lb10/samples.yaml` applied to the packs' production prompts), LB-02's installable-app files (icon, manifests, offline pages in `apps/web/public`) and LB-03's sample files and page pictures (`apps/web/public/lb03`, copied from `data/seed/lb03`) |
| `just record-sample <system> <sample>` | Run a curated sample on a live back end and write the recording its demo replays (`apps/web/recordings`); needs the back end, the gateway and the site's keys (`LB_API_URL`, `LB_GATEWAY_URL`, `LB_WEB_SIGNING_KEY_FILE`, `LB_GATEWAY_SERVICE_KEY_FILE`) and spends the sample's model calls once |
| `just record-fixtures` | Make the recordings the journeys replay, on the mock back end (`apps/web/e2e/fixtures/recordings`, labelled `mock`) |
| `just check` (`pnpm check`) | Fail when a generated file is stale (the OpenAPI clients, the boards' samples, the icon sprite, the visitor-token corpus, the eval packs in `evals/packs`) or `routing.yaml` is invalid (the CI drift check) |
| `just icons` | Regenerate the icon sprite and registry after editing `packages/icons/svg` |
| `just visitor-tokens` | Make the shared corpus of visitor tokens again (`packages/common/test/fixtures/visitor-tokens.json`), after a rule of the token check changes; the tests of `@lb/common`, `lb_common.visitors` and the Django, Flask and Node systems all run it, so every verifier accepts and refuses the same tokens |
| `just stack-secrets [--again]` | Make throwaway secrets for the local stack in `infra/.dev` (git-ignored) |
| `just stack <docker compose command>` | Run the whole platform locally, hardened as on the box: `just stack up -d --wait`, then Caddy answers on http://127.0.0.1:8180; `just stack down -v` removes it (needs Docker) |
| `just stack-smoke` | Check a running local stack from the inside: health, the routes through Caddy (LB-02's WebSocket included), LB-07's sandbox reaching nothing but its own shop, an empty Redis ACL log |
| `just infra-check` | Static checks of `infra/` and the workflows: shellcheck, hadolint, actionlint, image digest pins, the Compose security rules, the Caddyfile, the systemd units |
| `just infra-test` | The infrastructure's tests: secrets, deploy decisions and pinning, then (Docker) Postgres roles, Caddy routing, the Redis ACL proof against the services' own suites, and LB-07's sandbox (`just test-lb07-sandbox`) |
| `just pin-images` | Pin every third-party image to the digest its tag names today; CI fails on an unpinned one |
| `just secrets-init` | Make your age key outside the repository, and list its public half in `.sops.yaml` |
| `just secrets-new <name>` | Create `infra/secrets/<name>.enc.env` from its template: random values made, then your editor opens for the rest |
| `just secrets-edit <name>` | Edit an encrypted secrets file in `$EDITOR`, then check it against its template |
| `just secrets-check` | Compare every encrypted secrets file with its template (variable names only, never values) |
| `just secrets-add-recipient <label> <key>` | Let one more age public key, such as the box's, open every secrets file |
| `just secrets-rekey` | After removing a key from `.sops.yaml`, lock every file to the keys that are left, with a new data key |
| `just secrets-test` | Test the secrets tooling with the real `sops` and `age`, in a throwaway copy with throwaway keys |
| `just secret-token [bytes]` | Print a random hex token, for a password or key you edit in by hand |
| `just tts-lb09 [--meeting KEY] [--check]` | Speak LB-09's scripted meetings (`data/seed/lb09`) with Flite, an offline text-to-speech, into `data/seed/lb09/audio` with a manifest of each turn's timing; `--check` only compares the committed audio with its manifest and the scripts |
| `just eval-lb09 [--samples] [--case ID]` | Run LB-09's golden set through the live labelling and extraction (each scripted meeting as a transcript, timed by the committed audio) and grade it by rules against its gate (two chat calls a case, plus a repair each; run it when prompts or routes change) |
| `just wer-lb09 [--mode fast\|private] [--meeting KEY]` | Transcribe LB-09's committed meetings for real and report the transcriber's word error rate against the scripts (fast mode spends `lb-stt` seconds; private mode needs the faster-whisper weights in `LB09_WHISPER_DIR`) |

End-to-end tests run against the production build. Where a Chromium is preinstalled,
point Playwright at it with `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome`, and make it the
build the lockfile's Playwright expects (1.63 wants `chromium-1243`, such as
`/opt/pw-browsers/chromium-1243/chrome-linux64/chrome`, or leave the variable unset where
`PLAYWRIGHT_BROWSERS_PATH` holds that build): an older build passes every journey but LB-04's
viewer, whose page it cannot draw (Chromium 141 shows the text fallback instead). CI installs
Playwright's own. Integration tests start Redis (gateway, Python, Flask and the Node systems) and
Postgres with pgvector (Django, Flask and the Node systems) with Testcontainers; where Docker
isn't available, or its Ryuk helper can't be pulled (set `TESTCONTAINERS_RYUK_DISABLED=true`), set
`LB_TEST_REDIS_URL=redis://127.0.0.1:6379` and
`LB_TEST_DATABASE_URL=postgres://lb:lb@127.0.0.1:5432/lb` to use local servers instead
(the Postgres user needs the right to create databases; the Flask tests make a database
of their own and drop it). The Python contract tests also
need Node, since they start the real gateway
(`services/gateway/test/support/contract-server.ts`). In a cloud session without a Docker
daemon, `dockerd` can usually be started; if Docker Hub's anonymous pull limit bites,
pull the image through `mirror.gcr.io` (such as `mirror.gcr.io/library/redis:8.10-alpine`)
and tag it with its Docker Hub name.

The infrastructure tests (`just infra-test`) start their own containers with plain
`docker run`, named after the test and its process, and remove them. The Redis ACL proof
also starts a throwaway Postgres for the suites that need one, and takes step names
(`infra/redis/test-acl.sh node django`: gateway, lb-common, django, flask, node, celery) to
run only those suites after its first proof. The secrets tests and
`just infra-check` need `sops`, `age`, `jq`, `shellcheck`, `hadolint` and `actionlint`;
on Linux `infra/scripts/install-tool.sh` installs checksum-verified `sops`, `cosign`,
`hadolint` and `actionlint`.
