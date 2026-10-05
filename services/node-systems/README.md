# Node systems · LB-08 Automation Studio, LB-04 Contract Radar, LB-06 Incident Commander and LB-07 QA Engineer

One Node monolith for the systems that suit Node best: LB-08 Automation Studio, LB-04
Contract Radar, LB-06 Incident Commander and LB-07 QA Engineer. Each system is a module with its own API prefix,
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

LB-06 breaks a simulated shop on a visitor's click and has a team of agents find the cause and propose
a fix the visitor approves: the simulator is seeded and event-sourced, the alert and the correlation are
code, the agents read compact summaries and cite evidence the server checks, and nothing changes the
shop without the approval. Its section is near the end of this file.

LB-07 tests a staging shop from a goal in plain words: a model plans the test once in a closed vocabulary,
a sandboxed browser runs it, code makes the findings, the model writes the bug reports' prose, and a
template writes the Playwright test, kept only when it is red with the bugs on and green with them off.
Its section, with its threat model, is the last of this file.

## At a glance

| Parameter | Value |
|---|---|
| API | Fastify 5 with the Zod type provider, under `/api/`: LB-08 at `/api/lb08/`, LB-04 at `/api/lb04/`, LB-06 at `/api/lb06/` (and its WebSocket at `/ws/lb06/`) and LB-07 at `/api/lb07/`, plus `/api/healthz` (liveness) and `/api/readyz` (each system's schema and Redis). Schema: [`openapi.json`](openapi.json), served at `/api/openapi.json` |
| Sandbox | LB-07's own process (`src/sandbox.ts`), in a container of its own: the staging shop and the browser runner, driven by the worker over HTTP |
| Callers | The site's server, with an Ed25519 visitor token scoped to one system and valid 5 minutes at most (`@lb/common`'s [visitor check](../../packages/common/src/visitors.ts)) |
| Worker | A separate process (`src/worker.ts`): BullMQ on Redis, one job per workflow step (LB-08), one per contract under review (LB-04) and one per incident for its whole life (LB-06), plus a repeating sweep for each |
| Data | PostgreSQL 17: one schema per system (`lb08`, `lb04`, `lb06`), Drizzle ORM and drizzle-kit migrations |
| Model calls | Through the gateway only. LB-08: alias `lb-tools`, at most 2 a description. LB-04: `lb-guard`, `lb-long`, `lb-reason` and `lb-fast`, 2 to 5 a review and one a redline (at most 8 in all), every call labelled with the one run that contract is. LB-06: `lb-guard`, `lb-reason` and `lb-tools`, 9 or 10 an incident on a clean run and 15 at the step cap |
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
| `LB08_DATABASE_URL`, `LB04_DATABASE_URL`, `LB06_DATABASE_URL`, `LB07_DATABASE_URL` | In production, a role that owns only the `lb08` (or `lb04`, `lb06`, `lb07`) schema; the shared URL is then not used for that system. Migrations run as this role too |
| `LB07_RUNNER_URL`, `LB07_SHOP_TOKEN_KEY`, `LB07_SHOP_ORIGIN` | LB-07's worker: the sandbox's runner, the key bug tokens are signed with (hex, at least 64 digits; the runner's own key is derived from it), and the shop's origin as a reader of a generated test runs it. Without the first two a worker fails every LB-07 run as `runner_unavailable` |
| `LB_REDIS_URL`, `LB_REDIS_PREFIX` | Redis, and the prefix of every key this service writes (default `lb:`) |
| `LB_WEB_TOKEN_KEY` | The site's Ed25519 public key. Without it the API refuses every visitor |
| `LB_GATEWAY_URL`, `LB_SERVICE_NAME`, `LB_SERVICE_KEY_FILE` | The gateway, and the service's own name and private key (a file nobody else can read). Required by the API and by the worker |
| `LB_SEED_DIR` | Where the seed data lives; the repository's `data/seed` by default |

A variable left empty counts as not set. Settings are checked once at startup, and a
mistake names the variables, never their values.

Redis keys this service writes, for the Redis ACL: `<prefix>bull:lb08-steps:*`,
`<prefix>bull:lb08-dead-letters:*`, `<prefix>bull:lb08-maintenance:*`,
`<prefix>bull:lb04-reviews:*`, `<prefix>bull:lb04-maintenance:*`, `<prefix>bull:lb06-incidents:*`,
`<prefix>bull:lb06-maintenance:*`, the feed of each incident, `<prefix>lb06:feed:<incident id>` (a
stream the worker appends to and the API reads), `<prefix>bull:lb07-runs:*`, `<prefix>bull:lb07-maintenance:*`,
and the run spans the gateway reads, `<prefix>run:<run id>:spans` and `<prefix>spans`. The sandbox process uses
no Redis and no database.

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
src/modules/lb06/    the system: sim/ (the seeded shop: faults, world, logs, deploys), detect/ (the SLO,
                     the correlation, the summary, the tick), agents/ (the orchestrator, the prompts,
                     the tools, the model wrapper, the postmortem), golden/ (the golden set, its grader,
                     the reference agents, the runner), data/ (the samples), db/ (schema, migrations),
                     engine/ (store, service, job, feed, socket, queue, sweep, cache, usage, trace), routes/
src/modules/lb07/    the system: shop/ (the staging shop and its bug token), runner/ (the browser sessions, the
                     plan's check, interception and the browser's network, the runner's API, its key and its
                     client), agent/ (the state machine, the prompts, the model wrapper, the report rules, the test
                     template), data/ and golden/ (the bug catalogue, the golden set, its grader and runner),
                     db/ (schema, migrations), engine/ (store, service, job, queue, sweep, usage, trace), routes/
src/modules/registry.ts   the list of systems the monolith hosts
src/main.ts, src/worker.ts, src/sandbox.ts   the API process, the worker process and LB-07's sandbox process
src/cli/             migrate, seed, openapi, eval-lb08, eval-lb04, eval-lb06, eval-lb07 and the drift check
scripts/             the generator of LB-04's sample contracts, and LB-07's memory measurement
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

## LB-06: from a click to a postmortem

A visitor breaks a simulated shop (six services: web, cart, payment, inventory, database, cache) with
one of four faults, and a team of agents finds the cause and proposes a fix the visitor approves. The
simulator is the product: it is seeded and event-sourced, so an incident replays exactly from its seed
and its log; the alert and the correlation are code; the agents see compact summaries and cite
evidence the server checks; nothing changes the shop without the visitor's click; and the incident
closes only when the SLO has recovered, measured by code.

| Step | What it does | When it can't |
|---|---|---|
| Start | The visitor picks a curated sample (a fault with a fixed seed from the golden set) or a fault of their own with a seed and two optional strings (the bad deploy's version label, a flag's name). The strings go to the injection screen first (`lb-guard`, 1 call); a flagged one is replaced by a label. The incident is stored with the opening of its log: the start, 30 calm minutes, the fault, and the first minute of the fault, in one transaction with the visitor's place for the day and the global count | 429 after the day's incident, 503 when eight incidents run already or the queue refuses (the place is given back) |
| Tick | The worker's job ticks the shop every two seconds of wall time: one simulated minute, its metrics and SLO appended as a `tick` event (Postgres first, then the incident's Redis Stream), so a dashboard draws the shop from the feed alone. The shop is a pure function of the seed, the fault and the remediations applied (`sim/world.ts`): every rebuild gives the same minute | The wall-clock cap (8 minutes) or 180 simulated minutes end the incident as timed out, whatever its state |
| Detect | Code: the share of bad requests at the edge (errors, and requests over 600 ms), its burn rate against a 99.5% SLO, and two window pairs (2 and 6 minutes at 10x, 5 and 15 at 5x); both windows of a pair burning fires the alert. Code also says which service's series left its baseline first, which deploys and flag changes came in the half hour before, and which log signatures the calm baseline never showed (`detect/`) | |
| Investigate | Two minutes after the alert the agents read a snapshot: the commander plans (`lb-reason`, 1 call), each specialist (logs, metrics, deploys; `lb-tools`) gets a turn that may call the read-only tools the server runs (`query_logs`, `query_metrics`, `list_deploys`, at most 12 rows each) and a last turn that must answer, the commander ranks the hypotheses and proposes one typed action from a closed list (1 call). Every answer gets one repair; every evidence id is checked against what the server holds and the rest dropped and counted; a rollback must name a version the history shows and a flag flip a flag the shop has. The clock keeps ticking meanwhile | The step cap (15, enforced by code, never asked of the model) ends the incident as aborted; an answer unusable twice or a gateway out of reach ends it as failed |
| Approve | The proposal waits for the visitor. Approving is a transition checked against the pending proposal's id under the row's lock: the action is applied to the shop at that minute. Rejecting sends the commander back for one more ranking (1 call) with what was tried; three proposals at most | A decision that names anything but the pending proposal is 409 |
| Verify | Code: five healthy minutes in a row (the short window under 1x) close the loop. A remediation that has not brought the SLO back in twelve minutes sends the commander back | The proposals spent end the incident as aborted |
| Postmortem | Code builds the timeline from the log; the model writes prose over it (`lb-reason`, 1 call, 1 repair) that must reference only kinds of event the log holds, or no prose is shown. Then the incident closes and its root span is written | |

A clean incident costs 9 calls (10 with the screen), up to 15 with repairs and a
second ranking, and never more than 15 (the datasheet says 9 to 15). The agents' work for a scenario is cached by the scenario's
key and the prompts' version (`engine/cache.ts`): a curated sample's second run replays its plan, tool
calls, reports, ranking and postmortem at no model call, so the samples spend quota once. **No live
score is recorded here: no provider key exists where this was built, so the live eval has never been
run, and the datasheet's 9 to 15 stays an estimate.**

### What a running incident costs

A tick rebuilds the whole world from the seed: measured at about 15 to 20 ms for 240 minutes on this
machine (`test/unit/lb06-sim.test.ts` holds it under 500 ms), once every two seconds, so one incident is
under 1% of a core and the eight the service runs at once under 10%. The job holds the incident's log
in Postgres and a few kilobytes in memory; a tick event is about 500 bytes, a whole log under 100 KB.
A hub in the API reads one incident's stream for every socket of that incident, on one Redis
connection each.

### The LB-06 API

All routes are under `/api/lb06/` and need a visitor token for `lb-06`; another visitor's incident is
indistinguishable from one that doesn't exist.

| Route | What it does |
|---|---|
| `GET /limits` | The visitor's day (one incident), the step cap, the concurrent cap and how many run now, the wall-clock cap, when the day resets |
| `GET /catalogue` | The four faults with their sample, the samples (fault, seed, golden case), the baseline minutes and the tick pace |
| `POST /incidents` | Start one: `{from: "sample", sampleId}` or `{from: "custom", fault, seed?, params?: {version?, flag?}}`. 201 the incident at its first minute; 404, 422, 429 (`daily_limit`, with `resets_at` and `Retry-After`), 503 (`too_many_incidents`, `queue_unavailable`, `agents_unavailable`) |
| `GET /incidents`, `GET /incidents/{id}` | The visitor's incidents, and one with its state, its minute, its SLO as code measures it, the pending proposal, the remediations, the counts |
| `GET /incidents/{id}/events?after=N` | The events after N, 200 a page: the polling fallback of the socket. A tick carries the minute's metrics and SLO |
| `POST /incidents/{id}/proposals/{proposalId}/decision` | `{decision: "approve" | "reject"}`. 409 `proposal_settled` when the id is not the pending one |
| `POST /incidents/{id}/abort` | End it now. 409 when it has ended |
| `GET /incidents/{id}/postmortem` | The timeline and the prose. 409 `not_ready` until closed |

### The LB-06 WebSocket

`/ws/lb06/`, one JSON object a text frame, as LB-02's. The first frame, within ten seconds, is
`{"type": "hello", "token": "<visitor token for lb-06>", "incident": "<id>", "after": N}`: the token
travels in the frame and never in the address. The server answers `ready` (the incident, and the
events after N), then `event` for every event the worker appends, read from the incident's stream by
a hub shared by every socket of that incident. A second hello gets `error already_said_hello`; a
visitor with four connections open gets `error too_many_connections` and 1013. The server pings every
30 seconds and closes after 15 minutes of silence (4408), a frame over 4 KB (1009), a binary frame
(1003), a frame that is not a hello (4400), a bad token (4401), somebody else's incident (4404). A page
whose socket drops reconnects with the last number it holds and polls the events route meanwhile.

### LB-06 limits

| Limit | Value | Where it lives |
|---|---|---|
| Incidents per visitor per day (an incident the agents could not run, `failed`, is given back, once; one ended early or at the step cap stays spent) | 1 | `usage_counters`, one atomic statement in the transaction that stores the incident |
| Incidents running at once, across visitors | 8 | the same transaction; also the worker's concurrency |
| Model calls per incident | 15, the orchestrator's cap; the gateway caps the run at 15 and the visitor at 15 a day | `agents/orchestrator.ts`, `routing.yaml` |
| Proposals per incident | 3 | `engine/job.ts`, `engine/service.ts` |
| Wall-clock life, simulated minutes | 8 min, 180 | `config.ts`, checked on every tick |
| Visitor text | two strings of 40 characters, `[\w .,:;!?'"()/-]` only (no `<` or `>`, so the data slot's markers can't be closed) | `@lb/contracts`' `LB06_PARAM_PATTERN` |
| Tool rows, hypotheses, evidence per hypothesis, events | 12, 5, 6, 600 | `@lb/contracts`' `LB06_LIMITS` |
| Socket frame, hello, idle, connections a visitor, a process | 4 KB, 10 s, 15 min, 4, 256 | `engine/socket.ts`, `core/app.ts` |
| How long anything is kept | 24 hours, then the sweep deletes the incident with its log | `engine/sweep.ts` |

### LB-06 data and evals

| What | Where | Command |
|---|---|---|
| Golden set: eight incidents, two a fault, two hostile, graded by rules (cause, first proposal, evidence, calls, recovery, postmortem, injection) | [`evals/lb06/golden.yaml`](../../evals/lb06/golden.yaml) | `just eval-lb06` runs the live agents; the reader checks the set against the simulator (`just check`) |
| The curated samples: the golden cases marked `sample: true`, one a fault | the same file | `GET /api/lb06/catalogue` |
| OpenAPI document | [`openapi.json`](openapi.json) | `just node-openapi` |
| Migrations | [`src/modules/lb06/db/migrations`](src/modules/lb06/db/migrations) | `pnpm --filter @lb/node-systems exec drizzle-kit generate --config drizzle.lb06.config.ts` after editing `schema.ts` |

The golden set was written before any prompt. The reference agents (`golden/reference.ts`) answer every
prompt correctly from its data slots, and the offline test (`test/unit/lb06-golden-run.test.ts`) runs
the whole set through the whole simulator, the detection, the orchestrator and the postmortem with
them: every case passes every rule in 9 calls, so the rules can be met. Tests also show the hostile
strings reach the agents only inside a data slot of a user message, invented evidence is dropped and
counted, a tempting first proposal fails its rule while the run still recovers on the second round,
and an obeyed injection fails its rule.

### LB-06 tests

- **Unit:** the simulator (determinism minute for minute, bounds, cost, no alert on a calm shop, the alert
  within five minutes of every fault, the cure recovers and the temptation does not, the correlation,
  the leak's timeline, the summary and the evidence index), the golden set's reader and grader, the
  golden run with the reference agents, the orchestrator with scripted models (one repair, the step cap,
  a proposal checked against the history and the flags, tool calls run by the server and bounded,
  discarded evidence counted, a postmortem with bad references left out), and the routing contract (the
  caps, the aliases, the trace reader, the largest ranking prompt within the alias's input limit, the
  datasheet's numbers).
- **Integration:** a whole incident on a real Postgres with a fast clock, the approval that a replay or
  a forged id cannot repeat, the rejection and the second ranking, a remediation that does not recover
  and the second proposal, the allowances and the global cap, the cache that spares a second run its
  calls, the wall-clock cap, the step cap, unusable agents, the abort, the injection screen, the sweep;
  the API through Fastify (every route, every refusal, another visitor's 404); the socket on a real
  port over the real Redis feed (hello, ready, live events in order, a late page, every refusal, the
  caps); the schema (its own schema only, a role that owns nothing else, the checks, the cascade).

### LB-06 threat model

- **Spoofing.** As LB-08's: tokens the site signed for `lb-06`, 5 minutes at most, the visitor known by
  their session hash. The socket takes the token in its first frame and closes on any failure with
  the same code. A decision is a server-side transition checked against the pending proposal's id
  under the row's lock, so a replayed or forged approval matches nothing and does nothing.
- **Tampering: the visitor's words.** Two strings of 40 characters from a pattern with no `<` or `>`,
  read by the injection screen (flagged ones replaced), then placed in a delimited data slot the
  prompts say is data; the reference tests show they never reach a system prompt. Whatever the model
  makes of them, it can only cite evidence the server holds and propose an action from a closed list,
  whose parameters are checked against the deploy history and the flags, and nothing is applied
  without the visitor's click. The golden set's hostile cases grade that the action the injection asks
  for is never proposed.
- **Tampering: the model's output.** Every answer is checked by a strict schema with one repair; a
  hypothesis's evidence is verified; a postmortem that references events the log lacks is not shown.
  The agents never see raw logs or raw series: the tools return bounded rows and the summaries are
  built by code.
- **Bounds.** The step cap is the orchestrator's; the tools' rows, the hypotheses, the evidence, the
  events and the simulated minutes are capped; the wall clock ends an incident at 8 minutes; eight
  incidents run at once across every visitor; a visitor holds four sockets; a tick rebuild is
  milliseconds.
- **Data exposure.** Another visitor's incident is a 404 over HTTP and a 4404 over the socket. Spans
  carry agents, steps, tools and counts, never the visitor's strings (a test checks the trace of a
  hostile incident). Logs hold ids and error names. Everything is deleted after 24 hours; the feed's
  stream expires with it. A custom incident's calls travel as visitor data.
- **Denial of service.** The daily incident, the global cap, the wall-clock cap, the socket caps, the
  gateway's caps per run, per visitor and per system (230 a day).
- **Privilege escalation.** LB-06's connection searches only its own schema and, in production, logs in
  as a role granted nothing else (a test migrates as such a role). The tools read a world built in
  memory from the seed and can change nothing.

Known gaps, stated rather than hidden:

- **Allowances are per session.** As for the other systems: a script that mints sessions gets
  incidents, and the global cap and the gateway's budgets are what stop it.
- **A job that dies mid-investigation loses the count of the calls it spent.** The budget resumes from
  the row's count, which is written when the proposal is made; a crash between two agent calls can
  cost up to a few calls more than the cap counts, within the gateway's own cap of 15.
- **The concurrent cap has a race of one.** The count is read in the transaction that stores the
  incident, under the visitor's own counter row, so two visitors starting at the same instant can make
  nine incidents where eight are allowed.
- **The cache keys on the scenario, not on the minute.** The investigation's snapshot is taken two
  minutes after the alert, which is the same minute every run of a scenario, so the cached work is
  the work a live run would do; a change in `investigationDelayMinutes` must bump `PROMPT_VERSION`.
- **No live eval score and no live prompt tuning.** The prompts were written from the golden set and
  checked against the reference agents, never against a model.
- **No browser-direct HTTP.** As LB-08: the site's server calls the API for the visitor; only the
  socket is browser-direct, at the site's origin, as LB-02's.

## LB-07 QA Engineer

A visitor switches on bugs in a synthetic staging shop and gives a goal in plain words ("buy two bags with
WELCOME10 and check the total"), or picks a curated sample. A model plans the whole test once, in a closed
vocabulary of six actions; a browser in a sandbox runs it step by step; code, never a model, makes the findings
(an expectation that failed, a console error, a failed request, an axe violation, a navigation the sandbox
stopped); the model only puts the findings into bug reports' words; and a template writes the Playwright test
from the validated plan, which is kept only when it fails with the bugs on and passes with them off. The model
never sees a cookie, a URL or a line of code, and nothing it writes is ever run.

| Step | What runs it | Model calls | When it can't |
|---|---|---|---|
| Start | `POST /runs`: a sample, or a goal of at most 300 plain characters and a set of the six bugs. One transaction, behind a lock every start takes, counts the runs queued or running (four at most), takes the visitor's place for the day and stores the run; then the job is queued (BullMQ, one at a time: one browser, one run) | 0 | 404 `unknown_sample`, 422, 429 `daily_limit` (with `resets_at` and `Retry-After`), 503 `busy` (no place taken) or `queue_unavailable` (the place given back) |
| Screen the goal | A visitor's own goal only: the injection guard (`lb-guard`). A sample's goal is the owner's | 1 | A flagged goal ends the run as `goal_refused` before any other model sees it, and the place stays spent (so the guard cannot be probed for free). A guard out of reach leaves the goal `unchecked` and the run goes on: the vocabulary and the sandbox hold whatever it says |
| Plan | `lb-tools`: the goal between `<goal>` markers in a user message, the shop's guide and the vocabulary in the system prompt; the answer is one sentence of reading and 1 to 16 steps that start with a `goto`, checked by a strict schema (`@lb/contracts`' `lb07PlanAnswerSchema`, and the first-step rule in `agent/machine.ts`) | 1, 2 with its one repair | Unusable twice: `plan_invalid` (the place given back). Gateway out of reach: tried again after a wait; quota spent: `planning_unavailable` (given back) |
| Run | The runner: a fresh browser context with the run's signed bug token in its cookie jar; each step is one Playwright call by role and name, label or text, never a selector (10 s each); after each page opened and at the end, axe. Up to three screenshots of the steps that made a finding, one at the end, and the page's trimmed accessibility tree | 0 | A step that would leave the shop is refused before the browser moves and recorded; the plan ends there and proves nothing (`not_verified`) |
| Re-plan | Only when a step failed (not found, ambiguous, timed out): `lb-tools` with the page's accessibility tree, at most 6,000 characters, as data between `<page>` markers; its answer replaces the failed step and the rest | 1 each, at most 2, no repair | An unusable or empty answer stops the plan there: no verdict |
| Cross-check | The final plan again, bugs on, in "the second engine": Chromium wearing Firefox's user agent, since only Chromium is installed (the `checkout-engine` bug reads the user agent) | 0 | Skipped when the plan did not run to its end |
| Bug reports | `lb-tools` with the steps and the bug findings as data (`<steps>`, `<findings>`); a report is kept only if every finding it names is a bug finding of this run, and once | 1, 2 with its repair; 0 with nothing to report | Unusable twice: no reports, the findings stand on their own |
| Verify | The final plan on the clean shop (no token), axe on. The verdict is code's: `kept` (red with the bugs on, in either engine, and green without), `passing` (no bug on and green), `discarded_not_red`, `discarded_not_green`, `not_verified` | 0 | Skipped when the plan did not run to its end |
| Generate the test | A template over the final plan (`agent/testgen.ts`): every string a JSON literal, the line separators JSON keeps raw written as escapes; the service shows it and never runs or loads it | 0 | Longer than 20,000 characters: refused, never cut |

A run costs 1 to 7 model calls: the guard (custom goals only), the plan (1 or 2), up to two re-plans, the reports
(0 to 2). `routing.yaml` caps LB-07 at 8 a run, 16 a visitor a day and 200 a day. The three minutes of the wall
clock count from the agent's start, model calls included; each pass's browser session is closed by the runner at
what is left of them. Everything that cost a call (the guard's verdict, the plan, the reports) is saved as it is
made, so a retry never pays twice; a browser pass that was cut short is run again from the plan.

### The shop and its six bugs

The staging shop (`src/modules/lb07/shop`) is a small `node:http` server: six synthetic coffees, one coupon, a
cart in a cookie, a checkout and an about page that talks to automated testers on purpose (a note, a picture whose
text alternative gives an order, a heading that imitates the end of a data block). Pages are rendered by a tagged
template that escapes every value. Bugs are switched on only by a token the service signs (HMAC-SHA-256 over the
run, its bugs and an expiry of 15 minutes), which the runner puts in the browser's cookie jar (`HttpOnly`) before
the first page opens: no step can read, set or carry a cookie, so the agent cannot flip a bug, and a token that is
missing, altered or expired means a clean shop.

| Bug | What it does | Where a correct run finds it |
|---|---|---|
| `coupon-twice` | WELCOME10 is taken off twice | an expectation on the total, on `/cart` |
| `checkout-engine` | the checkout answers 500 to a browser that is not Chromium | a failed request on `/checkout`, in the second engine |
| `missing-alt` | the coffees' pictures lose their text alternative | axe's `image-alt` |
| `cart-off-by-one` | the cart counts one item too many | an expectation on the count |
| `broken-image` | the front page's picture points at a missing file | a failed request for `/images/hero-missing.svg` |
| `script-error` | the checkout runs a script that throws a TypeError | a console error on `/checkout` |

The catalogue with each bug's truth is [`data/seed/lb07/bugs.yaml`](../../data/seed/lb07/bugs.yaml). Every answer
of the shop carries its own Content-Security-Policy (the shop's origin only; no script at all but the
`script-error` bug's own, allowed by its hash on the one page that has it; the stylesheet by its hash; no plugin,
no base, forms to the shop, no framing), `nosniff`, `X-Frame-Options: DENY`, no referrer and no CORS header; its
redirects go only to its own paths.

### The sandbox

One process (`src/sandbox.ts`, `just lb07-sandbox`) holds the shop, on the loopback interface only, and the
runner's API, on the container's own address, which the worker calls to open a session, run a step, read the
page's snapshot or a screenshot, run axe and close the session. It runs one Chromium for its life and gives every
pass of a run a fresh context (cookies, storage, cache), with one page: any window a page opens is closed at once.
A context keeps the shop's policy, takes no download and runs no service worker. One session at a time, even when
two ask at once. A session its worker never closes (a worker that died) is closed at its wall clock and forgotten
30 seconds later. After 20 sessions (`LB07_RUNS_PER_LIFE`; a run opens one to three, one for each pass) the
process exits once its last session is closed or forgotten, never while a run is in the browser, and Compose
starts a fresh one; a test starts the real process and watches it do so. A browser that crashes in the middle of a
run is reported as such, and the worker tries the run again with a fresh one.

Chromium is started with `--no-sandbox` (Playwright adds it too unless asked not to): its own sandbox needs user
namespaces, which a container without capabilities and with `no-new-privileges` does not grant. That is acceptable
because the container is the sandbox, and because what reaches the renderer is the shop's own pages: a page the
model cannot write, whose only script is the bug's own, under the shop's policy. The rest of what Chromium is
started with: no shared memory (`--disable-dev-shm-usage`), no GPU, no extensions, one renderer with a 128 MB
heap, the third layer's switches below, an environment of five variables (the path, a home and its two XDG folders, the temporary folder: no setting of the runner reaches it),
and a home, a profile and a crash-report folder of its own in the temporary folder. Traced with strace over a whole
run, nothing in the process tree writes outside `/tmp`; as the user `nobody`, with no new privileges and no
capabilities, on a read-only root with a tmpfs at `/tmp` (a private mount namespace standing in for the
container), two runs of the heaviest golden case kept their tests. The container itself is `lb07-sandbox` in
`infra/docker-compose.yml`, built from `infra/docker/lb07-sandbox.Dockerfile`, with its rules and the proof that
they hold (`just test-lb07-sandbox`) in [`docs/DEPLOY.md`](../../docs/DEPLOY.md), [`docs/SECURITY.md`](../../docs/SECURITY.md)
and `infra/sandbox/test.sh`.

### What "one container per run" became, and why

The datasheet first promised one container per run. Starting a container for each run needs the Docker socket
(or an API with the same power) inside the service, and whoever holds that socket holds the host, so this
platform never exposes it to any service. What LB-07 has instead, layer by layer: one dedicated sandbox container
with the platform's hardening (a non-root user, a read-only root, no capabilities, no new privileges, memory, CPU
and process limits) on an internal network that reaches nothing but the worker, which serves no port (`lb07-sandbox` in
`infra/docker-compose.yml`); a
fresh throwaway browser context for every pass of every run, closed at a hard wall clock; the runner process
restarted after 20 sessions, so nothing a run leaves in the browser outlives a handful of runs; and the browser's
network held by the three layers below, each of which holds on its own. The datasheet now says so, in both
languages.

### The LB-07 API

All routes are under `/api/lb07/` and need a visitor token for `lb-07`; another visitor's run, report, test or
evidence is indistinguishable from one that does not exist (the same 404 and the same body, on every route and for
every spelling of the id), and so is a run past its hour.

| Route | What it does |
|---|---|
| `GET /bugs` | The six bugs, each with where a correct run finds it |
| `GET /limits` | What is left of the visitor's day, the goal's length, the run time, how long a run is kept, the queue's size, when the day resets |
| `GET /samples` | The curated samples: the golden cases marked `sample: true` |
| `POST /runs` | Start a run: `{from: "sample", sampleId}` or `{from: "custom", goal, bugs}`. 201 queued; 404, 422, 429, 503 (`busy`, `queue_unavailable`, `planning_unavailable`) |
| `GET /runs`, `GET /runs/{id}` | The visitor's runs of the hour (ten at most), and one with its state, its place in the queue, its steps as they happen, its calls and findings |
| `GET /runs/{id}/report` | The findings, the bug reports, the verification. 409 `not_ready` while it runs, `run_failed` when it failed |
| `GET /runs/{id}/test` | The generated test, as text, with its verdict and a file name made from the goal |
| `GET /runs/{id}/evidence/{evidenceId}` | A screenshot (PNG as base64) or the trimmed accessibility snapshot |
| `DELETE /runs/{id}` | Delete it now, with everything that belongs to it. The day's place is not given back |

A failed run says why with a code the board words itself: `planning_unavailable`, `plan_invalid`,
`runner_unavailable`, `run_timeout`, `goal_refused`, `internal`. The contract also lists `plan_refused`, which
nothing produces today: a plan outside the vocabulary is `plan_invalid` after its repair, and a step outside the
shop is a blocked step of a run that proves nothing.

### LB-07 limits

| Limit | Value | Where it lives |
|---|---|---|
| Runs per visitor per day (a sample counts; a run the system could not run, `planning_unavailable`, `runner_unavailable`, `plan_invalid` or `internal`, is given back once; a refused goal or a run that used its time stays spent) | 2 | `usage_counters`, one atomic statement in the transaction that stores the run |
| Runs queued or running, across visitors | 4, then 503 `busy` with no place taken | `engine/store.ts`, under an advisory lock every start takes |
| Time a run may wait in the queue | 15 minutes, then it is ended as `runner_unavailable` and its place given back | `config.ts`, `engine/sweep.ts` |
| Runs in the browser at once | 1 | the worker's concurrency and the runner's single session |
| Goal, bugs | 300 plain characters; each of the six at most once | `@lb/contracts`' `lb07GoalSchema`, `lb07BugListSchema` |
| Plan, re-plans | 16 steps, starting with a `goto`; 2 re-plans | `@lb/contracts`, `agent/machine.ts` |
| A step's strings | a path of lowercase letters, digits, `/` and `-` (81 characters); names, labels and texts of 120 plain characters; fill values of 200 | `@lb/contracts`' `lb07StepSchema` |
| Model calls per run | 7 at most; the gateway caps 8 a run, 16 a visitor a day and 200 a day | `agent/machine.ts`, `routing.yaml` |
| Wall clock, one step | 3 minutes for the whole run, 10 seconds a step | `LB07_LIMITS`, the runner's session timer, `runner/executor.ts` |
| Attempts | 2 (backoff 5 s doubling, or the gateway's Retry-After), at most 4 starts in all; a run silent for 7 minutes is queued again | `config.ts`, `engine/job.ts`, `engine/sweep.ts` |
| Findings, evidence, snapshot, screenshot | 40 findings; up to four screenshots and one snapshot a run; 6,000 characters; 400 KB, or none | `LB07_LIMITS`, `agent/machine.ts` |
| Generated test | 20,000 characters | `agent/testgen.ts` |
| Runner: request body, answer read by the worker | 8 KB; 1 MiB | `runner/server.ts`, `runner/client.ts` |
| Runner: sessions per process, a forgotten session | 20; closed at its wall clock and forgotten 30 s later | `src/sandbox.ts`, `runner/session.ts` |
| How long anything is kept | 1 hour: the run, its steps, findings, screenshots, snapshot, report and test, deleted by the sweep (every minute) and not found after the hour even before it runs | `engine/sweep.ts`, `expires_at` |

### LB-07 data, golden set and commands

| What | Where | Command |
|---|---|---|
| The bug catalogue (the six bugs and each one's truth) | [`data/seed/lb07/bugs.yaml`](../../data/seed/lb07/bugs.yaml) | `just node-seed` and `just check` read it strictly |
| Golden set: eleven goals (each bug, every bug at once, a clean shop that must stay clean, a link out of the shop that must be stopped, a hostile goal, a re-plan after a wrong name), each with a reference plan in the vocabulary; eight are the curated samples | [`evals/lb07/golden.yaml`](../../evals/lb07/golden.yaml) | `just eval-lb07` runs the live agent through the real sandbox (`just lb07-sandbox` running): at most seven calls a case, about 77 for the set. Samples run as the board runs them (no guard); the other cases run as a visitor's own goals, through the guard |
| The sandbox, as its container runs it | `src/sandbox.ts` | `just lb07-sandbox` |
| The browser tests (no model, no database) | `test/browser/` | `just test-lb07-browser` |
| What a run costs in memory | `scripts/lb07-memory.ts` | `node scripts/lb07-memory.ts [--case ID] [--runs N] [--cgroup DIR]` |
| Migrations | [`src/modules/lb07/db/migrations`](src/modules/lb07/db/migrations) | `pnpm --filter @lb/node-systems exec drizzle-kit generate --config drizzle.lb07.config.ts` |

The golden set was written before any prompt. The offline test (`test/browser/lb07-golden.test.ts`) runs every
case through the whole agent, the real runner on a real Chromium and the real shop, with a scripted model that
answers as a correct planner would, and every case passes every rule (the bugs found by their truth, a clean shop
with no finding, the verdict, nothing out of the shop, the calls). **No live score is recorded here: no provider
key exists where this was built, so the live eval has never been run.**

### LB-07: what a run costs in memory

Measured on 5 October 2026 with `scripts/lb07-memory.ts` on an x86-64 machine with 4 cores and 16 GB, not on
the box's ARM cores (Ampere A1): Node 22.22, Chrome for Testing 153 (Playwright 1.63's `chromium-1243`). The
script starts the sandbox process as its container runs it, runs the heaviest golden case (`everything-on`: 15
steps, all six bugs, three passes) five times in a row through the runner's API with the real agent and a
scripted model, and samples the whole process tree (Node, Chromium's browser, renderer, GPU, utility and zygote
processes: nine at the peak) every 100 ms. Three measures: RSS summed process by process (what `ps` shows; a page
shared by several processes counts once for each, so it overstates), PSS summed (each shared page divided among
its sharers, so the sum counts it once: what the tree really occupies), and the charge of a memory cgroup the
sandbox ran in (what a container's limit counts; on this busy machine Chromium's binary and libraries were already
in the cache under other processes, so the charge leaves them out, and is the floor of what a fresh container pays).

The five runs measured in the cgroup:

| Moment | RSS, summed | PSS, summed | cgroup charge (anonymous) |
|---|---|---|---|
| Started, before any run (Node alone, no browser yet) | 179 MiB | 140 MiB | 126 MiB (122) |
| Peak of a run | 1,131 to 1,156 MiB | 537 to 561 MiB | 348 to 366 MiB |
| After a run (the browser kept, no context) | 746 to 777 MiB | 293 to 406 MiB | 206 to 236 MiB (194 to 223) |

A run of the heaviest case takes about 25 seconds. After a run, the charge grew from 206 MiB to 236 MiB over the
first three runs and then stayed there (235.8 MiB after the fifth); the peak moved from 357 MiB to 366 MiB. That is
no leak worth a restart of its own, and the restart after 20 sessions bounds whatever is left. Over six measuring
sessions (the one above, one as the user `nobody` on a read-only root, one under strace), the started process was
179 to 183 MiB RSS and a run's peak 1,108 to 1,159 MiB RSS; PSS moves with what else on the machine maps the same
files (a run's peak 443 to 575 MiB), so it is a range, not a constant. For the container: a fresh one should expect
about 550 to 600 MiB at the peak of a run, which a limit of 768 MiB covers with room for the growth before a
restart; ARM64 builds of Chromium and Node are of the same order, but that is unmeasured.

The container does not run Chrome for Testing but Chrome Headless Shell (a build with no interface code, pinned in
`infra/docker/lb07-sandbox.Dockerfile`), and it was measured in the container itself, under its Compose limit: 96 to
127 MiB when idle, and a peak of 263 to 271 MiB over five runs in a row of the same heaviest case under the 384 MiB
limit (327 to 332 MiB with no limit), with 83 tasks. So `lb07-sandbox` has `mem_limit: 384m`, and the 768 MiB above
is what `just lb07-sandbox` needs on a development machine with the full Chrome for Testing. How the 384 MiB fits the
box's budget is in [`docs/DEPLOY.md`](../../docs/DEPLOY.md), "The memory budget".

### LB-07 tests

- **Unit (301):** the shop (pages, cart, each bug, the token, its policy and headers, no open redirect, no field
  that flips a bug), the plan's check against every spelling of another place, the vocabulary against what a
  hostile model could answer (unknown actions, selectors, URLs, prototype keys, broken numbers, control characters,
  ten megabytes, a hundred thousand levels), the prompts' data blocks (no marker survives in a goal, a page, a step
  or a finding, full-width or not), the generated test read back by the TypeScript compiler for every fuzzed string,
  the runner's key and the worker's bounded reads, the machine with scripted runners and models (the guard, the
  plain reading, re-plans, budgets, the wall clock), the report rules, the golden set and its runner, the routing
  contract and the datasheet, and a scan (98 of the 301) that no LB-07 file evaluates a string, starts a process or
  imports a path made at run time.
- **Integration (32):** the engine on a real Postgres with a queue driven by hand (a run from start to report,
  retries, failures and what each gives back, the sweep, the trace), races (twenty starts from twenty visitors and
  from one, ten refunds at once), the queue wait, a flagged goal, nothing left of an expired run, no visitor's or
  page's words in the logs, the API through Fastify (every route and refusal, another visitor's 404 on every route
  and id spelling, the model's sentence as plain text), the real BullMQ queue and the schema.
- **Browser (50, `just test-lb07-browser`):** every golden plan on a real Chromium over the real shop; the whole
  agent on every golden case; hostile pages against a canary on another address (every way out a page has, the
  runner's own API included); each layer alone; a model that obeys the about page; the runner's life (two opens at
  once, a forgotten session, the exit after its share, a crashed browser, the real process exiting with its home
  left empty).

### LB-07 threat model

The visitor's goal, every page the browser opens and everything the model says are untrusted. Short notes, as the
playbook asks (step 8).

- **Spoofing.** As LB-08's: tokens the site signed for `lb-07`, five minutes at most, the visitor known by their
  session hash. The runner's API answers its health to anyone and nothing else without the worker's key (derived
  with HKDF from the bug-token key the two already share, so it needs no setting of its own and is not that key); a
  call without it is refused before its body is read. The shop believes only a bug token signed with its key.
- **Tampering: the model's output.** A plan is data in a closed vocabulary, checked by strict schemas with one
  repair (a re-plan gets none): six actions, a role from a closed list, plain strings with bounds, no selector, no
  script, no URL; a hostile answer of any size or depth is refused cheaply, before a browser session opens. The one
  sentence of reading is made plain before anyone sees it. Bug reports must rest on bug findings of the run. The
  verdict and the findings are code's.
- **Tampering: the visitor's goal and the pages.** A custom goal is screened by the guard first and refused when
  flagged; the goal and the page reach the model only inside data blocks (`<goal>`, `<page>`, `<steps>`,
  `<findings>`) that no string in them can close, however it is spelled (markers are removed after NFKC, angle
  brackets are removed from the page and escaped in the findings' JSON). The about page talks to the agent on
  purpose, and a test with a model that obeys it shows the address it names is no step the vocabulary has, the link
  it names is refused before the browser moves, and the run proves nothing.
- **Tampering: the generated test.** Written by a template from the validated plan, every string a JSON literal
  with the line separators escaped (before this review a goal holding U+2028 put a line of code after its
  comment); the TypeScript compiler reads every fuzzed plan back as one test whose statements are the plan's. The
  service never writes it to a file, imports it or runs it, and a scan of the module's sources fails if anything
  could.
- **Information disclosure.** Another visitor's run is a 404 everywhere. Spans carry counts and labels, never the
  goal, a page's words or an address; logs carry ids and error names. A blocked navigation names the refused place
  by its scheme and host only, never its path or query. The bug token never reaches the model or a page's script
  (`HttpOnly`). Everything is deleted after an hour, screenshots included. A custom goal travels as visitor data, so
  only providers that do not train on inputs read it.
- **Denial of service.** Two runs a visitor a day; four queued or running across visitors, counted under a lock;
  fifteen minutes in the queue at most; one run in the browser; a three-minute wall clock and ten seconds a step; a
  page's windows closed, its snapshot, screenshots and the runner's answers bounded; a session nobody closes
  forgotten; a crashed browser replaced; the runner restarted after 20 sessions; the gateway's caps per run, per
  visitor and for the system.
- **Elevation of privilege: the browser's network.** Three layers inside the browser, each tested on its own
  against pages that try every way out (`test/browser/lb07-layers.test.ts`), with the shop's policy and the
  container's network around them:
  1. *The plan's check* (`runner/guard.ts`): a `goto` is a lowercase path of the shop, and a link's `href` is
     checked before the click; both are decided by the origin after the URL standard's own parsing, so `//evil`,
     backslashes, userinfo and fragment tricks, other ports, `localhost`, `[::1]`, `[::ffff:127.0.0.1]`, `0.0.0.0`,
     decimal, octal and hex addresses of other hosts, the metadata address and names, `file:`, `data:`,
     `javascript:`, `blob:`, `view-source:` and `chrome:` are refused before the browser is asked, and spellings of
     the shop's own address (`127.1`, `2130706433`) are the shop.
  2. *Interception* (`runner/network.ts`): every HTTP request of every page, frame, worker and window goes on only
     to the shop's origin, and every WebSocket is refused. By Playwright's documented design it does not see the
     second hop of a redirect, nor anything that is not HTTP (WebRTC's UDP): a test shows the redirect hop getting
     through it alone. That is what the third layer is for.
  3. *The browser's own network*: Chromium sends everything but the shop's host and port to a proxy that is a dead
     end in the runner's process (`<-loopback>` first, so the loopback interface is no exception), resolves no host
     name but the shop's, and lets WebRTC use no UDP it does not proxy, which is none. A redirect hop, a socket and
     a STUN packet all stop there; its refusals are recorded too.
  4. *The shop's own policy*, at the page's level: a script that got into a page could load and connect to nothing
     outside the shop. (Before this review the context bypassed the page's policy, so a policy would have meant
     nothing.)
  5. *The container's network* (the infrastructure's, not part of this module): an internal network that reaches
     only the worker.

  DNS rebinding has nothing to work with: the one allowed origin is an address, a host name is never allowed and
  never resolved by the browser, and the check compares origins, not answers. A refused request is recorded as a
  blocked navigation; a run whose plan was stopped proves nothing.
- **Elevation of privilege: the runner.** A page cannot reach the runner's API (all three layers refuse its
  address, and a test shows it hears nothing), and could not drive it without the key. The browser's environment
  holds five variables and nothing of the runner's settings.

Known gaps, stated rather than hidden:

- **Chromium's own sandbox is off.** A renderer exploit would run as the runner's user in the sandbox container: it
  could read the runner's environment through `/proc` (the bug-token key, which opens the shop's bugs and the
  runner's API and nothing else), drive the runner, and reach what the container's network reaches. The
  container's own limits are the wall, and they are the infrastructure's (not tested here).
- **Interception alone has blind spots** (a redirect's second hop, UDP): the browser's own network holds them, and
  a test shows it does; that the browser makes no DNS query at all rests on Chromium's resolver rules, which the
  tests show indirectly (a navigation by name reaches nothing).
- **The guard can be wrong.** A false positive refuses an honest goal and keeps the place; a false negative lets an
  injection reach the planner, where the vocabulary and the sandbox hold.
- **Allowances are per session**, as for the other systems; and one visitor may hold two of the four places in the
  queue.
- **The second engine is simulated**: Chromium with Firefox's user agent, since only Chromium is installed.
- **The runner counts sessions, not runs** (`LB07_RUNS_PER_LIFE`, and the contract's `runsPerRunnerLife`, are
  sessions: a run opens one to three).
- **The memory figures are x86's**; the box's ARM cores are unmeasured.
- **No live eval score and no live prompt tuning.** The prompts were written from the golden set and checked
  against scripted models, never against a model.
