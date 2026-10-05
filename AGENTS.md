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

Status: Phase 1 in build. Built so far: the workspace root, `packages/icons`,
`packages/ui` (the design system as a Nuxt layer), `apps/web` (the site in English and
Czech: catalog, datasheets, themes, security headers; its Nitro server between the browser
and the back ends, with the anonymous session, Turnstile and a proxy that forwards only the
routes the back ends document; the evaluation-board kit with the Scope and the replay player;
LB-01's board at `/systems/lb-01/board`, LB-08's at `/systems/lb-08/board` and LB-04's at
`/systems/lb-04/board`; see its [README](apps/web/README.md)),
`packages/api-clients` (typed clients generated from the back ends' OpenAPI documents, and
the mock back end the site's tests run against), `services/gateway` (the LB-00 AI
gateway: routing, fallback, budgets, quotas, service tokens, run spans, reranking and the
prompt-injection guard; see its [README](services/gateway/README.md)),
`python/lb-common` (the Python gateway client, service tokens, run context and tracer;
see its [README](python/lb-common/README.md)) and `infra/` (the deployable platform:
signed multi-arch images, the hardened Compose stack with the Django, Flask and Node
systems (LB-01, LB-02, LB-03, LB-04, LB-05, LB-08), Postgres roles, the Redis ACL, the Caddy edge, SOPS
secrets and the deploy workflow; see [`docs/DEPLOY.md`](docs/DEPLOY.md)).
In build: `services/django-systems`, the
Django project for LB-01, LB-02 and LB-09, with LB-01's schema, synthetic data
(`data/seed/lb01`), golden set (`evals/lb01`), hybrid search, ticket pipeline, visitor
API and Celery worker so far, and LB-02's back end: the Booking Concierge's schema with
the database-enforced no-double-booking constraint, its synthetic calendar
(`data/seed/lb02`), golden set (`evals/lb02`), state-gated tool calling, WebSocket
(Django Channels) and live calendar, visitor API, and golden-set eval (see its
[README](services/django-systems/README.md)); LB-02's demo is on the site at
`/systems/lb-02/board` (a phone-frame chat beside the live calendar, installable as an
app; see the web README); next come the recorded sample runs of LB-01 and LB-02
(`just record-sample`, which needs the live back end with a model behind it). Also in build:
`services/flask-systems`, the Flask monolith, with LB-05 Data Analyst's back end so far:
synthetic Parquet and DuckDB data, the semantic layer, six layers of SQL safety, the
question pipeline, the visitor API with its 25-a-day quota, and the golden, adversarial
and live eval sets (see its [README](services/flask-systems/README.md)). LB-05's demo is
on the site at `/systems/lb-05/board`: a question in plain words, the long wait counted honestly, the
answer with its SQL, table, chart and chain of steps, the safety demo that names the layer which
stopped each attack, and the semantic layer browser, in English and Czech (see the
[web README](apps/web/README.md)); next come LB-05's recorded sample runs (`just record-sample lb-05
<sample>`, which needs the live back end with a model behind it). The same monolith holds LB-03
Invoice Reader's back end: the file read in a locked-down OCR subprocess (never in the web
process), a pipeline on one asyncio loop with at most five model calls a document, eleven
checks (the arithmetic in `Decimal`) that return a failing document with its failing checks and
never fix it silently, duplicates by vendor, number and content hash, a balanced journal entry from a
chart-of-accounts file, CSV and JSON export, files that expire after an hour behind a disk or S3
store, the prompt-injection defence, a 10-a-day visitor API, and a seeded set of 43 synthetic
documents with its golden set and an offline strict reader (see the same README). LB-03's demo is on
the site at `/systems/lb-03/board`: the page of the document with each field's box lit and its
confidence said in words and drawn with its own line, a table of fields that can be corrected so
every check runs again, the checklist, the duplicate verdict, the journal entry, the exports, an
upload behind Turnstile and six curated samples, in English and Czech (see the web README); next
come LB-03's recorded sample runs (`just record-sample lb-03 <sample>`, which needs the live back
end with a model behind it). The Node side: `packages/contracts`
(the Zod schemas the site and the services share), `packages/common` (the TypeScript twin of
`lb-common`; see its [README](packages/common/README.md)) and `services/node-systems`, the
Node monolith for LB-04, LB-06, LB-07 and LB-08, with LB-08's back end built: workflow
graphs checked by one schema, a BullMQ engine with retries, a dead-letter queue, replay and
exactly-once side effects, and the visitor API (see its
[README](services/node-systems/README.md)); LB-08's board is on the site (a lazily loaded Vue
Flow canvas and a keyboard outline over one validated state, the run with its retries, dead
letters and replay, and what the sandbox sent); next come its recorded sample runs
(`just record-sample lb-08 <sample>`, which needs the live back end). LB-04 Contract Radar's
back end is in the same monolith: a PDF's text and where every word sits, read in a worker
thread with a deadline and a memory limit; an injection screen; a cited analysis whose every
quote the server checks against the contract's text (a quote that is not there is dropped, and
counted); the playbook kept as data; proposed wordings with a server-computed diff; a BullMQ
pipeline of two to five model calls (and one more for each of up to three redlines); and the
visitor API with its three-contracts-a-day quota and one-hour retention (see the same README).
LB-04's board is on the site at `/systems/lb-04/board`: a risk radar drawn as an accessible SVG
with its table, the findings with their quotes as text, a PDF viewer that loads pdf.js on demand
under a policy of its own and highlights exactly the characters a citation names, and redlines
as insertions and deletions, in English and Czech (see the web README); next come its recorded
sample runs (`just record-sample lb-04 <sample>`, which needs the live back end with a model
behind it). LB-06 Incident Commander is in the same monolith too: a seeded, event-sourced shop
simulator (six services, four faults, the same seed always the same incident), detection and
correlation written as code (the SLO burn rate, the new log signatures, the deploys before the
first divergence), a commander and three specialist agents orchestrated in code with a hard cap
of 15 model calls, proposals from a closed list of actions that only the visitor's approval can
apply, the incident's log as a Postgres table and a Redis stream, a WebSocket feed, and the
visitor API with its one-incident-a-day quota (an incident the agents could not run is given
back) (see the same README). LB-06's board is on the site at `/systems/lb-06/board`: six charts
that turn when the fault strikes, each with a text alternative and a table, the agents' steps and
the commander's hypotheses, the card that waits for the visitor's approval, the service level
objective, the timeline and the postmortem, a replay of a recorded incident, the visitor's own
incident with its text screened, a polling fallback for a network that blocks WebSockets, in
English and Czech (see the web README); next come its recorded sample runs (`just record-sample
lb-06 <sample>`, which needs the live back end with a model behind it). LB-07's board is on the
site at `/systems/lb-07/board`: the six bugs as switches and a goal of the visitor's own checked
before it is sent, eight curated runs, the run followed by polling while it waits for the one
browser ("2 runs are ahead of yours") and while it runs, the steps grouped by plan and re-plan,
the findings code made, the bug reports labelled as a model's, the red-then-green verdict with its
three passes, the generated Playwright test in a code view with its copy and download, the
screenshots through a picture route of the site's own (the policy unchanged) and the visitor's
runs of the hour, in English and Czech (see the web README); next come its recorded sample runs
(`just record-sample lb-07 <sample>`, which needs the live back end with a model behind it).
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
| `just worker` | Run the Celery worker with its scheduler: the ticket pipeline, the 24-hour sweeps, the nightly reseed, and LB-02's minute-by-minute hold sweep and nightly calendar reset |
| `just openapi` | Regenerate `services/django-systems/openapi.json` after an API change (a test fails while it is stale) |
| `just migrate` | Create or update each Django system's schema (settings in `services/django-systems/.env`, from `.env.example`) |
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
| `just audit` | Check npm and Python dependencies against known vulnerabilities |
| `just e2e` | Build the site's test build (the production build plus a stand-in for Turnstile and the mock recordings), then run the Playwright journeys, axe checks and security-header tests against it and the mock back end |
| `just check-build` | Fail if the production build (`just build` first) holds any trace of the test build's Turnstile stand-in |
| `just samples` | Regenerate the boards' curated samples (`apps/web/shared/data/samples/`) from each golden set's `sample: true` cases (LB-05 also gets its attacks from the adversarial set; LB-04's six come from its sample list, `data/seed/lb04/samples.yaml`, and its golden set), LB-02's installable-app files (icon, manifests, offline pages in `apps/web/public`) and LB-03's sample files and page pictures (`apps/web/public/lb03`, copied from `data/seed/lb03`) |
| `just record-sample <system> <sample>` | Run a curated sample on a live back end and write the recording its demo replays (`apps/web/recordings`); needs the back end, the gateway and the site's keys (`LB_API_URL`, `LB_GATEWAY_URL`, `LB_WEB_SIGNING_KEY_FILE`, `LB_GATEWAY_SERVICE_KEY_FILE`) and spends the sample's model calls once |
| `just record-fixtures` | Make the recordings the journeys replay, on the mock back end (`apps/web/e2e/fixtures/recordings`, labelled `mock`) |
| `just check` (`pnpm check`) | Fail when a generated file is stale (the OpenAPI clients, the boards' samples, the icon sprite, the visitor-token corpus) or `routing.yaml` is invalid (the CI drift check) |
| `just icons` | Regenerate the icon sprite and registry after editing `packages/icons/svg` |
| `just visitor-tokens` | Make the shared corpus of visitor tokens again (`packages/common/test/fixtures/visitor-tokens.json`), after a rule of the token check changes; the tests of `@lb/common`, `lb_common.visitors` and the Django, Flask and Node systems all run it, so every verifier accepts and refuses the same tokens |
| `just stack-secrets [--again]` | Make throwaway secrets for the local stack in `infra/.dev` (git-ignored) |
| `just stack <docker compose command>` | Run the whole platform locally, hardened as on the box: `just stack up -d --wait`, then Caddy answers on http://127.0.0.1:8180; `just stack down -v` removes it (needs Docker) |
| `just stack-smoke` | Check a running local stack from the inside: health, the routes through Caddy (LB-02's WebSocket included), an empty Redis ACL log |
| `just infra-check` | Static checks of `infra/` and the workflows: shellcheck, hadolint, actionlint, image digest pins, the Compose security rules, the Caddyfile, the systemd units |
| `just infra-test` | The infrastructure's tests: secrets, deploy decisions and pinning, then (Docker) Postgres roles, Caddy routing and the Redis ACL proof against the services' own suites |
| `just pin-images` | Pin every third-party image to the digest its tag names today; CI fails on an unpinned one |
| `just secrets-init` | Make your age key outside the repository, and list its public half in `.sops.yaml` |
| `just secrets-new <name>` | Create `infra/secrets/<name>.enc.env` from its template: random values made, then your editor opens for the rest |
| `just secrets-edit <name>` | Edit an encrypted secrets file in `$EDITOR`, then check it against its template |
| `just secrets-check` | Compare every encrypted secrets file with its template (variable names only, never values) |
| `just secrets-add-recipient <label> <key>` | Let one more age public key, such as the box's, open every secrets file |
| `just secrets-rekey` | After removing a key from `.sops.yaml`, lock every file to the keys that are left, with a new data key |
| `just secrets-test` | Test the secrets tooling with the real `sops` and `age`, in a throwaway copy with throwaway keys |
| `just secret-token [bytes]` | Print a random hex token, for a password or key you edit in by hand |

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
