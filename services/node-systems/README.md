# Node systems · LB-08 Automation Studio and LB-04 Contract Radar

One Node monolith for the systems that suit Node best: LB-08 Automation Studio and LB-04
Contract Radar today, then LB-06 and LB-07. Each system is a module with its own API prefix,
Postgres schema, queues and tests, so it can be split into a service of its own later. Models
are called only through the AI gateway.

LB-08 turns a description of a business process into a typed workflow graph, checks it,
versions it, and runs it on a queue with retries, approvals, a dead-letter queue and
replay, against sandboxed connectors that never leave the machine.

LB-04 reads a contract (a PDF of up to 30 pages) against the owner's playbook and says what to
look at: every risk it reports quotes the contract, and the quote is checked against the
contract's own text by code, so a clause the model invented never reaches the page. Why it is
built this way: [`docs/STACK.md`](../../docs/STACK.md), Node systems. Platform security:
[`docs/SECURITY.md`](../../docs/SECURITY.md).

## At a glance

| Parameter | Value |
|---|---|
| API | Fastify 5 with the Zod type provider, under `/api/`: LB-08 at `/api/lb08/` and LB-04 at `/api/lb04/`, plus `/api/healthz` (liveness) and `/api/readyz` (each system's schema and Redis). Schema: [`openapi.json`](openapi.json), served at `/api/openapi.json` |
| Callers | The site's server, with an Ed25519 visitor token scoped to one system and valid 5 minutes at most (`@lb/common`'s [visitor check](../../packages/common/src/visitors.ts)) |
| Worker | A separate process (`src/worker.ts`): BullMQ on Redis, one job per workflow step (LB-08) and one per contract under review (LB-04), plus a repeating sweep for each |
| Data | PostgreSQL 17: one schema per system (`lb08`, `lb04`), Drizzle ORM and drizzle-kit migrations |
| Model calls | Through the gateway only. LB-08: alias `lb-tools`, at most 2 a description. LB-04: `lb-guard`, `lb-long`, `lb-reason` and `lb-fast`, 2 to 5 a review and one a redline (at most 8 in all), every call labelled with the one run that contract is |
| Runtime | Node 22.18 or later (CI runs 24) with type stripping: TypeScript runs as written, so only erasable syntax is allowed |
| Shared code | [`@lb/contracts`](../../packages/contracts/README.md) (the schemas), [`@lb/common`](../../packages/common/README.md) (gateway client, tokens, tracer) |

## LB-08: from a description to a replay

| Step | What it does | When it can't |
|---|---|---|
| Describe | `lb-tools` writes a workflow as a JSON object, from a prompt built out of the same catalogue the validator checks ([`generate/prompts.ts`](src/modules/lb08/generate/prompts.ts)). The description sits between `<process>` markers it can't close | The gateway can't be reached: 503, and the visitor's description is given back |
| Validate | `validateWorkflow` decides, in plain code: the schema (known node types, connectors and choices), then the whole graph (one trigger, no loops, no dangling edges, every reference resolves, bounded size). A model is never asked whether its own answer is valid | A refusal is final after one repair: 422 with every problem found |
| Repair | Only when validation refused the first answer: the model sees the problems and tries once more. It is told not to swap an impossible request for something else, so validation, not the model, refuses it | Two refusals end it; nothing is stored |
| Version | A workflow keeps immutable versions (20 workflows a visitor, 30 versions each). An edit saved from the editor is checked as strictly and becomes the next version | A stale edit is refused with 409 |
| Queue | A run is queued and answered at once. Each action step is a BullMQ job with 3 attempts and exponential backoff; free steps (the trigger, conditions) run inside the transaction, approvals wait for a person | A worker that dies is replaced by the queue; a lost job is found by the sweep |
| Act, once | A write goes through the outbox and the sandbox's deliveries table under the key `<root run>:<step>` | See below |
| Dead-letter | A step that used all its attempts is recorded, parked in the `lb08-dead-letters` queue and shown to the visitor | A permanent failure (a product that isn't in the stock list) is not retried and not dead-lettered |
| Replay | One click makes a new run of the same version and payload in the same chain. What the original sent is recognised by its key and not sent again | Only a finished run can be replayed |

A description costs one gateway call, plus one when the first answer needs its repair. A
sample costs none, and neither does running, retrying or replaying a workflow.

## How a run moves

A run's steps start when every edge leading into them has an answer and one is live: an edge
is live when its source succeeded and, for a condition or an approval, chose that branch.
A step whose edges are all dead is skipped, and the skip ripples down its branch. After a
step fails nothing new starts; what is already running finishes, and the run ends as
failed. The rules are pure functions in [`engine/flow.ts`](src/modules/lb08/engine/flow.ts).

Every change happens in a transaction that first locks the run's row, so two steps that
finish at the same moment take turns and the second sees the first's result; a test runs the
race twelve times and fails without the lock. Every change also writes events, numbered
without gaps, and the log is the whole story of the run: the site follows it with a cursor
(`GET /runs/{id}/events?after=N`), and plays it back step by step afterwards.

## The trace of a run

A run's id is also its trace's id at the gateway, so the Scope can draw it. Every attempt at
an action step writes a `system.step` span (`step.<step id>`, with its connector, its attempt
and what became of it), and the run itself writes one `system.run` span, `workflow run`, the
root of the trace. The gateway calls a trace finished once it holds that root, and the
site's Scope stops reading then, so the root is how the site learns a run is over.

The root is written last, once, by the process whose transaction ended the run: a worker
when its step was the last one, the API when the run ends in the request that starts or
replays it (every branch skipped) or in a person's answer to an approval. The transaction
only notes that it ended the run; the span is written after it commits, so a trace never
claims an end the database does not have. The steps, written minutes before, name the root
as their parent, which works because the root's id is made from the run's id
([`engine/trace.ts`](src/modules/lb08/engine/trace.ts)). The root spans the run from the
moment it was made, so the wait for a worker shows in it, and carries counts and labels
only (`outcome`, `steps`, `attempts`, `replay`), never a visitor's words. A replay is a new
run, with a trace and a root of its own.

A trace is telemetry, and a write that fails is logged and dropped. The cost is that a
process killed between the commit and the write leaves a run whose trace never says it is
finished; the site's Scope then calls it stalled after a few seconds, and the run itself,
which the log and the database describe, is unaffected.

## A side effect happens once

A write connector (Slack, email, webhook, task) works like this, in
[`engine/sandbox.ts`](src/modules/lb08/engine/sandbox.ts) and
[`engine/outbox.ts`](src/modules/lb08/engine/outbox.ts):

1. The step's text is rendered once, and the **intent** is written to the `outbox` table
   under the idempotency key, with a hash of what is to be sent.
2. The sandbox's `sandbox_deliveries` table, which stands in for a receiver that honours
   idempotency keys, takes the delivery. Its key is unique, so a second delivery under the
   same key records nothing and answers with the first one's id.
3. The step is acknowledged: the outbox row is marked delivered, `effect.sent` is logged and
   the step succeeds.

A worker killed between 2 and 3 leaves a delivery with no acknowledgement. The retry finds
the outbox row, delivers its stored content under the same key, gets the existing delivery
back, logs `effect.duplicate_suppressed` and finishes the step: one message went out. A key
reused for different content fails the step instead of quietly answering with the first
send. `Hooks.afterEffect` exists so tests can stop a worker exactly there.

## The API

Every route needs a visitor token for `lb-08`, and a visitor reaches only their own
session's data: asking for anyone else's answers exactly like asking for nothing.

| Route | What it does |
|---|---|
| `GET /api/lb08/catalogue` | What a workflow may be made of: events, connectors, their fields, the limits |
| `GET /api/lb08/samples` | The curated samples, each with a ready workflow and a test payload |
| `GET /api/lb08/limits` | The visitor's daily allowances and when they reset |
| `POST /api/lb08/workflows` | Describe a workflow (10 a day) or copy a sample. 201, or 422 with the problems found |
| `GET /api/lb08/workflows`, `GET /api/lb08/workflows/{id}` | List, and read one with its latest graph and every version |
| `PUT /api/lb08/workflows/{id}` | Save an edited graph as the next version. 409 when it started from an old one |
| `DELETE /api/lb08/workflows/{id}` | Delete it with every version, run, log and delivery |
| `POST /api/lb08/workflows/{id}/runs` | Start a run with a test payload (10 a day). 202. `failures` makes action steps fail on purpose |
| `GET /api/lb08/runs`, `GET /api/lb08/runs/{id}` | List, and read one in full: payload, steps, whole log |
| `GET /api/lb08/runs/{id}/events?after=N` | The events after the last one seen, with the run's status |
| `POST /api/lb08/runs/{id}/steps/{node}/decision` | Answer an approval, once |
| `POST /api/lb08/runs/{id}/replay` | Replay a finished run. 202. Counts as a run |
| `GET /api/lb08/sent` | What the sandbox "sent" for the visitor; `?rootRunId=` for one chain |
| `GET /api/lb08/dead-letters`, `POST /api/lb08/dead-letters/{id}/replay` | The steps that ran out of attempts, and the one-click replay (once) |

Errors answer `{"error": {"code", "message"}}` and never echo what was sent; a malformed
request names its fields (`"fields": "body.description"`), never their values, and a
rejected graph lists its problems. A daily limit (429 `daily_limit`) says when the day's
allowance starts again in two ways: `Retry-After` in seconds, and `"resets_at"` as the time
itself, the next midnight in UTC (`2026-10-03T00:00:00.000Z`). `resets_at` is the field in
the platform's error shape (`platformErrorSchema`) that LB-05's limit fills and that the
site's boards read to tell the visitor. Following a run is a poll with a cursor, not a
held-open stream: one short request at a time, and nothing between them.

## Limits

| Limit | Value | Where it lives |
|---|---|---|
| Workflow runs per visitor per day (a replay counts) | 10 | `usage_counters`, taken in the transaction that makes the run |
| Workflow descriptions per visitor per day | 10 | the same counters, taken before the model is called |
| Model calls per description | 2, at most | the pipeline; the gateway caps the run at 3 and the visitor at 30 a day |
| Attempts per step | 3, with exponential backoff | `config.ts`, BullMQ |
| Nodes, edges, fan-out of a graph | 16, 32, 4 | `@lb/contracts`, checked on every graph |
| Failures a visitor may inject into one step | 5 | the start-run request schema |
| Workflows kept, versions of one | 20, 30 | `engine/store.ts`, behind a lock |
| Request body, text | 256 KB; no control characters, no bidirectional overrides | `core/app.ts`, `core/text-guard.ts` |
| How long anything is kept | 24 hours, then the sweep deletes the workflow and all that belongs to it | `engine/sweep.ts` |

## Data and evals

| What | Where | Command |
|---|---|---|
| The synthetic stock list (6 products, one out of stock) | [`data/seed/lb08/stock.yaml`](../../data/seed/lb08/stock.yaml) | `just node-seed` checks it and makes the table match, so running it again puts the shelves back |
| Four curated samples (English and Czech) with a hand-written workflow and payload each | [`data/seed/lb08/samples.yaml`](../../data/seed/lb08/samples.yaml) | `just check` validates every graph and payload |
| Golden set: 39 descriptions (23 to build, 11 impossible or unsafe to refuse, 5 injections), graded by rules | [`evals/lb08/golden.yaml`](../../evals/lb08/golden.yaml) | `just eval-lb08` runs the live pipeline |
| OpenAPI document | [`openapi.json`](openapi.json) | `just node-openapi` regenerates it; a test and `just check` fail while it is stale |
| Migrations | [`src/modules/lb08/db/migrations`](src/modules/lb08/db/migrations) | `pnpm --filter @lb/node-systems exec drizzle-kit generate` after editing `schema.ts`; `just check` fails while they disagree |

The golden set was written before any prompt. Its rules read the graph (node types,
connectors, choices, order, branches, forbidden text) and never a model; each case carries
a hand-written workflow that meets it, so the tests prove the rules can be met, and the
cases that must be refused carry the answer a model that did as asked would write, so they
prove validation refuses it. **No live score is recorded here: no provider key exists where
this was built, so the live eval has never been run.** The first run's result belongs in a
baseline file next to the golden set, as LB-01's search recall is.

## LB-04: from a PDF to a cited review

A visitor reviews one of six curated sample contracts, or sends a PDF (at most 2 MB and 30
pages; 3 contracts and 10 files a day). The review is queued and answered at once; the board
polls its state. Every step is a span of the contract's own trace.

| Step | What it does | When it can't |
|---|---|---|
| Check the file | At the door, before a place is taken: base64, at most 2 MB decoded, `%PDF-` as its first bytes. Nothing about the file's name is trusted: it is a label, cleaned of paths and invisible characters | 415 not a PDF, 413 too large, 422 for a malformed request |
| Open it, in a thread | A worker thread with no environment and no flags, its own heap limits (192 MB old, 32 MB young, 4 MB stack) and a 20-second deadline reads the file with pdf.js. It refuses, before any text is read: more than 30 pages, encryption (a password, or restrictions on an empty one), XFA forms, embedded files and files attached to a page; afterwards, a file with no text layer (a scan: there is no OCR) and more than 160,000 characters | The contract fails with a code that says why (`pdf_encrypted`, `no_text_layer`, ...), its place for the day is given back and its file is deleted at once |
| Split | Into clauses by their printed numbers, by code (`analysis/clauses.ts`). Citations count characters in the page text this step makes, which the browser reads with the same function (`@lb/contracts`' `buildPageText`) | A page with no numbers is one clause |
| Screen | Code finds the passages that talk to a reviewer ("ignore the above", "you are an AI", a system prompt in a contract); the guard model (`lb-guard`, 1 call) reads them, or the opening of the contract when there are none. The model never sees those passages and no finding may rest on one | The guard unreachable: the screen says `unchecked` and the review goes on, held by the verifier whatever the guard says |
| Read | `lb-long` (1 call, 2 with its repair) gets the numbered clauses and the playbook's rules and returns notes: a rule, the clause, a quote. The contract sits in a delimited data slot of a prompt that says it is untrusted data | Two answers that fail the schema end the review as `analysis_invalid` |
| Verify | Every quote is looked for in the contract's text, with spaces, line breaks, hyphens, capitals and accents ignored. A quote that is nowhere is an invented clause: dropped and counted, never shown. Also dropped: a quote under 12 letters or digits, one over 1,200 characters, one inside a passage that talks to a reviewer, a rule the playbook doesn't have, a rule of another topic. Where a quote occurs twice, the occurrence in the clause the model named wins. A missing clause is decided by a search of the whole text for the playbook's phrases, whatever the model said | A model that lies, or is talked into something by the contract, changes nothing the reader sees |
| Rate | `lb-reason` (1 call, 2 with its repair; none when there is nothing to rate) says why each verified finding matters and how serious it is. Severity may move one step from the playbook's own; a summary that denies the finding is replaced by the playbook's | Unusable answers: the playbook's own severities and wording stand in, and the report says it is uncalibrated |
| Report | By code: the findings (at most 24), the radar (a topic's score is its worst verified finding), what the verifier dropped and why, the screen. A report names the playbook's version | |
| Redline | On request, for one finding (3 a contract): `lb-fast` proposes replacement wording (1 call, no repair); the server computes the word-level difference between the contract's words and the proposal. A reply that only repeats the passage is no redline | The model's wording unusable: the playbook's own fallback wording is used. The model unreachable: 503 and the place is given back |

A contract costs the guard (1), the reading (1 or 2) and, when there is something to rate, the
rating (1 or 2): 2 to 5 gateway calls, 3 for a typical one, and 1 more for each redline, at most
8 in all. `routing.yaml` gives `lb-04` 8 calls a run, and a test builds the largest request each
step can make and checks it against the gateway's own token estimate and the real alias limits.
A guard call is one call of the gateway however many requests it makes of its model: it reads
what it is given in overlapping segments, up to 7 for the longest text it is sent.

Everything that cost a call is saved as it is made. A retry after a failure, a worker that died
and a sweep that found the job resume where it stopped and never pay twice. A job is run again
after a gateway error that is worth another try (the wait is the gateway's own Retry-After or
the base wait doubled, whichever is longer), never after a spent quota, and a contract that has
been started more often than the queue and the sweep between them should ever need is ended, not
tried for ever. The worker's last attempt degrades instead of failing when only the rating is
unreachable.

The playbook is data, not prompt: [`data/seed/lb04/playbook.yaml`](../../data/seed/lb04/playbook.yaml)
(21 rules in 9 topics, 15 that flag a passage and 6 that expect a clause, each with what it
accepts, what it flags, how serious it is, the phrases that decide it and fallback wording),
read by a strict reader and put into the prompts by code. The owner edits the file, and a test
fails if a rule is added without its phrases.

## The LB-04 API

All routes are under `/api/lb04/` and need a visitor token for `lb-04`; another visitor's
contract is indistinguishable from one that doesn't exist.

| Route | What it does |
|---|---|
| `GET /limits` | What is left of the visitor's day, the page and size limits, how long a contract is kept, when the day resets |
| `GET /samples` | The six curated sample contracts, with their lengths (two will be refused, to show what the system refuses) |
| `GET /playbook` | The rules, by topic |
| `POST /contracts` | Review a sample (`{from: "sample", sampleId}`) or a PDF as base64 JSON (`{from: "upload", filename, contentBase64}`). 201 queued; 415, 413, 422, 429 (`daily_limit`, `upload_limit`, with `resets_at` and `Retry-After`), 503 |
| `GET /contracts`, `GET /contracts/{id}` | The visitor's contracts, and one with the state of its review: `queued`, `extracting`, `analysing`, `verifying`, `done`, `failed` (with a code) |
| `GET /contracts/{id}/pages` | The text of every page as the server extracted it, which every citation counts in |
| `GET /contracts/{id}/file` | The PDF itself, for the viewer, as base64 |
| `GET /contracts/{id}/report` | The finished review. 409 `not_ready` while it runs and `review_failed` when it failed |
| `POST /contracts/{id}/findings/{findingId}/redline` | A proposed change to one finding. 201 made, 200 already made (nothing spent), 429 when the contract's three are made, 503 |
| `DELETE /contracts/{id}` | Delete it now, with its file, text, report and redlines. The visitor's place for the day is not given back |

Every answer carries the label "Not legal advice".

## LB-04 limits

| Limit | Value | Where it lives |
|---|---|---|
| Contracts reviewed per visitor per day (a sample counts, a failed review is given back, once) | 3 | `usage_counters`, taken by one atomic statement in the transaction that stores the contract |
| Files sent per visitor per day (a refused one still counts) | 10 | the same counters |
| Pages, size, extracted text | 30, 2 MB, 160,000 characters | `@lb/contracts`' `LB04_LIMITS`; the page count is read before any text |
| Model calls per contract, redlines per contract | 5 and 1 each of 3: at most 8 | the pipeline; the gateway caps the run at 8 and the visitor at 24 a day |
| Attempts per review | 3, backoff 2 s doubling or the gateway's Retry-After; at most 6 starts in all | `config.ts`, `engine/job.ts` |
| Extraction thread | 20 s, 192 MB old heap, 32 MB young, 4 MB stack, no environment | `config.ts`, `pdf/extract.ts` |
| Findings in a report, quote length | 24, 1,200 characters | `@lb/contracts` |
| How long anything is kept | 1 hour: the contract, its file, text, report and redlines, deleted by the sweep (every minute) and not found after the hour even before it runs | `engine/sweep.ts`, `expires_at` |
| Request body of the upload | 2.8 MB (the web proxy: 3 MB; Caddy: 3 MB for this route, 1 MB for the rest) | `routes/contracts.ts` |

## LB-04 data and evals

| What | Where | Command |
|---|---|---|
| The playbook | [`data/seed/lb04/playbook.yaml`](../../data/seed/lb04/playbook.yaml) | `just node-seed` and `just check` read it strictly |
| Six synthetic contracts (PDFs) and the list that says what each file must be (size, SHA-256) | [`data/seed/lb04/contracts`](../../data/seed/lb04/contracts), [`samples.yaml`](../../data/seed/lb04/samples.yaml) | `pnpm --filter @lb/node-systems contracts:lb04` makes them (pdf-lib, a development dependency), `just check` fails when they differ from the generator's output |
| Golden set: four contracts to review (planted risks, a clean one, a 30-page one, a hostile one whose clauses address the reviewer) and two files that must be refused (31 pages, a scan), graded by rules | [`evals/lb04/golden.yaml`](../../evals/lb04/golden.yaml) | `just eval-lb04` runs the live pipeline: 5 calls a contract and 1 for its redline, at most about 24 for the set; it exits 1 unless every case passes and recall reaches the gate (80%) |
| OpenAPI document | [`openapi.json`](openapi.json) | `just node-openapi` |
| Migrations | [`src/modules/lb04/db/migrations`](src/modules/lb04/db/migrations) | `pnpm --filter @lb/node-systems exec drizzle-kit generate --config drizzle.lb04.config.ts` after editing `schema.ts`; `just check` fails while they disagree |

The golden set was written before any prompt. Its rules read the report and the contract's own
pages: a quote must be the contract's text at the page and characters it cites (graded by code of
the grader's own, so a fault in the verifier can't also hide from the grade), the planted risks
must be found (recall is gated over the whole set), severities within one step, tolerated
clauses not reported, missing clauses reported, a contract that talks to its reviewer flagged
and its instructions never followed, no clause the contract doesn't hold. The tests run the
golden set through the real extraction and the real engine on a real Postgres with scripted
models that answer as a correct reviewer would, which proves the rules can be met. **No live
score is recorded here: no provider key exists where this was built, so the live eval has never
been run.** A model's real recall and its severities are unmeasured; the first live run's result
belongs in a baseline file next to the golden set.

## Running it locally

```sh
cp services/node-systems/.env.example services/node-systems/.env   # then fill it in
just node-migrate && just node-seed
just node-api       # the API on http://127.0.0.1:8002
just node-worker    # the step jobs, the contract reviews and the sweeps
```

Describing a workflow, reviewing a contract and writing a redline need the gateway (`just
gateway`) with provider keys, and the service key pair from `just gateway-token keygen
node-systems <key-file>`, whose public key goes in the gateway's `LB_SERVICE_KEYS`. Both the
API and the worker start only with the gateway's address and the key, because a review is
made in the worker. Workflow samples, runs, replays and everything else of LB-08 work without a
model; LB-04's limits, samples and playbook do too.

| Variable | Meaning |
|---|---|
| `LB_NODE_HOST`, `LB_NODE_PORT`, `LB_NODE_LOG_LEVEL` | Where the API listens (default `0.0.0.0:8002`) and how much it logs |
| `LB_DATABASE_URL` | The shared Postgres. Each system uses a pool whose search path holds only its own schema |
| `LB08_DATABASE_URL`, `LB04_DATABASE_URL` | In production, a role that owns only the `lb08` (or `lb04`) schema; the shared URL is then not used for that system. Migrations run as this role too |
| `LB_REDIS_URL`, `LB_REDIS_PREFIX` | Redis, and the prefix of every key this service writes (default `lb:`) |
| `LB_WEB_TOKEN_KEY` | The site's Ed25519 public key. Without it the API refuses every visitor |
| `LB_GATEWAY_URL`, `LB_SERVICE_NAME`, `LB_SERVICE_KEY_FILE` | The gateway, and the service's own name and private key (a file nobody else can read). Required by the API and by the worker |
| `LB_SEED_DIR` | Where the seed data lives; the repository's `data/seed` by default |

A variable left empty counts as not set. Settings are checked once at startup, and a
mistake names the variables, never their values.

Redis keys this service writes, for the Redis ACL: `<prefix>bull:lb08-steps:*`,
`<prefix>bull:lb08-dead-letters:*`, `<prefix>bull:lb08-maintenance:*`,
`<prefix>bull:lb04-reviews:*`, `<prefix>bull:lb04-maintenance:*`, and the run spans the
gateway reads, `<prefix>run:<run id>:spans` and `<prefix>spans`.

## Layout

```
src/core/            what every system shares: app, errors, headers, text guard, env, logging,
                     database runner, OpenAPI registry, visitor-token hook, health
src/modules/lb08/    the system: db/ (schema, migrations), engine/ (runs, steps, queue, sweep),
                     generate/ (prompts, model, pipeline), routes/, data/, golden/
src/modules/lb04/    the system: pdf/ (the file's checks and the extraction thread), analysis/
                     (clauses, screen, prompts, verifier, report, redline, pipeline), playbook/,
                     data/, golden/, db/ (schema, migrations), engine/ (contracts, queue, sweep,
                     quotas, trace), routes/
src/modules/registry.ts   the list of systems the monolith hosts
src/main.ts, src/worker.ts   the API process and the worker process
src/cli/             migrate, seed, openapi, eval-lb08, eval-lb04 and the drift check
scripts/             the generator of LB-04's sample contracts
```

A new system joins by adding a module (its schema, routes, queues, `migrate`, `seed` and
`documentRoutes`) to the registry: the API mounts it, the worker runs it, and the migrate,
seed and OpenAPI commands pick it up.

## Tests

`just test` runs them with the rest of the monorepo; from this folder, `pnpm test`:
**1,128 tests**, 802 unit and 326 integration, of which LB-04's are 338 and 166.

- **Unit (257)** need nothing: the flow rules, rendering and the request each connector
  gets, the prompts (every choice in the catalogue is in the prompt, the two words the
  golden set's leak check looks for are kept, the worst-case repair request fits the
  `lb-tools` input limit by the gateway's own estimate), the model wrapper through the real AI
  SDK on a mock model, the pipeline with a scripted model (one call, one repair, never a
  third), the golden set run through the real pipeline, the routing contract against the real
  `routing.yaml` and the datasheet, the HTTP layer, the text guard, the sandbox's import
  tripwire, and the generated files.
- **Integration (147)** need Postgres with pgvector and Redis: Testcontainers starts both,
  or set `LB_TEST_DATABASE_URL` and `LB_TEST_REDIS_URL` (the Postgres user needs the right
  to create databases; each test file makes a database of its own and a key prefix of its
  own). They cover the schema (its own schema only, a role that owns nothing else), the
  engine on a hand-driven queue (branches, approvals, retries, dead letters, replay, the
  race, quotas, the sweep, and the worker killed between the send and the acknowledgement),
  the real BullMQ worker (backoff timing, a killed worker recovered by the queue), the whole
  API through Fastify, the module as the entry points open it, the describe pipeline against
  the real gateway on a fake provider, and the migrate, seed, check and eval commands and the
  API and worker processes themselves, started from environment variables alone (the worker
  finishing a run the API queued, a description going through the real gateway, a clean exit
  on SIGTERM).

LB-04's tests, beside the LB-08 ones:

- **Unit (338):** the shared page text and folding functions; the strict playbook reader; the
  seed contracts and the golden set (read strictly, and every planted passage found in its real
  PDF); the extraction in a real worker thread, including the files it must refuse (encrypted,
  XFA, embedded files, a scan, too many pages, a thread that spins, hogs memory, crashes or
  answers with garbage); the clause splitter; the screen; the verifier; the report; the
  redline; the prompts; the model wrapper; the pipeline with scripted models, and the injection
  tests that show a contract that addresses its reviewer, a guard that is fooled and a model
  that obeys change nothing the reader sees; the budget contract (the largest request each step
  can make, by the gateway's own estimate, against the real `routing.yaml`); the engine's pure
  rules.
- **Integration (166):** the schema and a role that owns only it; the daily allowances (races for
  the last place, refunds that happen once); the engine on a real Postgres with each golden case
  through the real extraction, and each way a review fails, resumes and degrades; the sweep with
  a moving clock (nothing outlives its hour, a worker that died is found); the whole API through
  Fastify; the real BullMQ queue (backoff timing, a killed worker recovered, a late attempt that
  can't undo a result); a review through the real gateway on a fake provider (the requests are
  accepted by the gateway's own checks, a review with its repairs and its three redlines is
  exactly eight calls and a ninth is refused, the trace is one tree the Scope reads as finished);
  the module and the real API and worker processes; and the eval command as a process.

No test spends quota: the model is a script or a fake provider. Where a Docker helper can't
be pulled, set `TESTCONTAINERS_RYUK_DISABLED=true`.

## LB-08 threat model

Short notes, as the playbook asks (step 8).

- **Spoofing.** Visitors have no accounts. The API trusts only tokens the site signed for
  `lb-08`, at most 5 minutes old, and knows the visitor only by their session hash; without
  the site's public key it refuses everyone, and every failure answers the same 401.
- **Tampering: the engine can't be made to run code.** A workflow is data. A condition is a
  field, an operator and an operand; text holds `{{references}}` and nothing else, and a
  value that is inserted is never read again as a placeholder, so a payload can't smuggle
  one in. There is no expression language, no script step, no `eval`. Whatever a model or a
  visitor writes is checked by a closed schema before it is stored, and again before it runs.
- **Tampering: it can't reach the network.** A connector is a function that reads or writes
  a table of LB-08's own schema. A webhook's endpoint and an email's recipient are names from
  closed lists, never a URL or an address (a customer's address must end in the reserved
  `.test` domain), and the files that handle a visitor's workflow import no module that can
  open a connection or start a process, which a test enforces.
- **Tampering: the model's output is untrusted.** The description is data between markers it
  can't close; the answer must pass the workflow schema and the structural rules, after at
  most one repair. A prompt injection can change a workflow's content within the closed
  lists, the visitor sees it, and the sandbox can do nothing harmful with it. The golden
  set's injection cases check that the prompt isn't leaked and the injected step isn't built.
- **Bounds.** At most 16 steps, no loops, a fan-out of 4: a run is at most 16 steps. Runs,
  descriptions, workflows, versions and injected failures are capped per visitor; bodies are
  cut at 256 KB; rendered text is cut to the size the tables and views are built for.
- **Data exposure.** Another visitor's workflow, run, delivery or dead letter is
  indistinguishable from a missing one, and no answer carries the session hash. Logs hold a
  request's method and path and an error's type and stack frames, never a body, a header, a
  query, an address or an error message. Spans hold labels and counts, never a visitor's
  words. Descriptions go to the gateway as visitor data, so only providers that don't
  train on inputs read them. Everything a visitor made is deleted 24 hours after it was made.
- **Denial of service.** The limits above; the gateway caps calls per run (3), per visitor
  (30 a day) and for LB-08 (160 a day). Request text with control characters, a body nested
  deeper than any honest request, or a payload with unknown fields is refused cheaply.
- **Privilege escalation.** Nothing here sends a real message. LB-08's connection searches
  only its own schema and, in production, logs in as a role granted nothing else; a test
  migrates as such a role and shows it can't read another schema or create anything outside
  its own.

Known gaps, stated rather than hidden:

- **Allowances are per session.** A script that mints new sessions gets new allowances;
  what stops it is the site's Turnstile check and the gateway's global daily budget, not
  this service. A description's allowance is taken before the model is called and given back
  if the model can't be reached, so a process killed in between loses one.
- **Free-tier tokens per minute.** A description reserves about 4,100 tokens against a
  model's minute budget until the call settles, so a burst of visitors can meet
  `generation_unavailable` (503) while samples and runs keep working.
- **Recovery takes minutes.** A queue add lost after a commit, or a job lost with Redis, is
  found by the sweep after 2 minutes idle, and the sweep runs every 5. A step is never run
  past three attempts (a worker that keeps dying dead-letters it).
- **The dead-letter copy is best effort.** The database is the record the visitor sees; the
  copy parked in `lb08-dead-letters` is for the owner's queue tools, and a Redis failure at
  that moment loses only the copy.
- **No live eval score and no live prompt tuning.** The prompt was written from the golden
  set and checked against scripts, never against a model.
- **`generateObject` is deprecated in AI SDK 7.** It is used, in no-schema mode, for its
  `repairText` hook; moving to `generateText` with an output setting is a change in
  `generate/model.ts` only.
- **No browser-direct access.** There is no CORS: the site's server calls the API for the
  visitor. A browser-direct stream would need CORS and a different token flow.

## LB-04 threat model

The contract is a stranger's file and what it says is untrusted data. Short notes, as the
playbook asks (step 8).

- **The file.** Checked at the door by its first bytes, its size and its encoding; opened only
  in a worker thread with a copy of the bytes, no environment, no flags, its own heap limits
  and a deadline, whose only way out is a message checked by a schema. Encrypted files, XFA
  forms and embedded files are refused (they are how a PDF carries scripts and payloads), and
  no OCR runs. pdf.js is told to load no fonts, run no scripts and fetch nothing.
- **What the contract says to the model.** It travels in a delimited data slot of a prompt that
  says it is untrusted data. Code finds the passages that address a reviewer and removes them
  from what the model sees; a guard model reads them. The defence does not rest on either: the
  verifier checks every quote against the contract's text, drops a quote that lies inside such a
  passage, and decides a missing clause by its own search, so a model that follows an
  instruction changes nothing the reader sees. Tests with a hostile contract and a model that
  obeys it prove it.
- **What the model says.** Nothing it writes is shown unless the verifier kept it: the quote
  shown is the contract's own text at the cited place, the title and the summary of a finding
  are the playbook's, the radar is computed, a severity may move one step, and a summary that
  denies the finding is replaced. The model's JSON is checked by a schema with one repair.
- **Bounds.** 30 pages, 2 MB, 160,000 characters, 24 findings, 1,200 characters a quote; 3 contracts
  and 10 files a visitor a day; 3 redlines a contract; calls capped per run (8), per visitor (24
  a day) and per system (160 a day) by the gateway.
- **Data exposure.** A contract is kept for an hour, in Postgres, in the `lb04` schema, under a
  role that can reach nothing else; every row that belongs to it cascades with it; the nightly
  backup leaves its rows out. A failed review deletes the file and the text at once. Another
  visitor's contract is a 404. Spans and logs hold counts and labels, never a quote, a clause or
  a file name (a test checks the trace of a hostile contract). The text goes to the gateway as
  visitor data, so only providers that don't train on inputs read it.
- **Privilege.** The worker thread has no environment and cannot reach the database; the
  service's key is a file in memory that the entrypoint writes and deletes from the
  environment.

Known gaps, stated rather than hidden:

- **The memory limit of the extraction thread is per thread and only advisory under
  `--max-old-space-size`.** A V8 flag in `NODE_OPTIONS` outranks a thread's own limit, so a
  deploy that sets it has weakened the thread's ceiling; the deadline still ends the thread (a
  test shows it), and the container's own limit (768 MiB for the worker) is the last wall. The
  memory proof runs in a process with no flag.
- **A hostile file can use its whole budget.** Two threads at their limits are about 760 MiB
  with the process; a worker killed for it is replaced and its job given to the next, a contract
  is started at most 6 times before it is ended as failed, and a poison file costs the visitor
  one of their three places.
- **No malware scanning and no OCR.** A scan is refused. A PDF that is valid and malicious in a
  way pdf.js's text extraction doesn't touch is stored as bytes for an hour and shown to its own
  visitor in their own browser's viewer (the board's viewer renders it with pdf.js from the
  site's own origin).
- **Allowances are per session.** As for LB-08: a script that mints sessions gets allowances,
  and what stops it is the site's Turnstile check and the gateway's global budget. A contract's
  place is taken in the transaction that stores it and given back when the file is refused or
  the model can't be reached.
- **A guard call can make seven requests of its model.** Its model has 30 requests a minute on
  the free tier, so several reviews at once can meet its limit: the screen then says
  `unchecked`, the verifier holds, and nothing fails.
- **The neuron pool.** A 30-page contract is about 50,000 input tokens on Workers AI (the only
  provider a visitor's upload may reach), about 1,900 of its 10,000 daily Neurons: five custom
  contracts a day spend the pool and the route answers 503 `analysis_unavailable`, while the
  samples (which may use the 1M-token model first) go on working.
- **A redline costs a call and two requests may cost two.** Two simultaneous requests for the
  same finding both call the model, and one of the two redlines is kept; both places are
  taken for the moment and one is given back, so the cost is a call, never a place.
- **No live eval score and no live prompt tuning.** The prompts were written from the golden
  set and checked against scripts, never against a model.
