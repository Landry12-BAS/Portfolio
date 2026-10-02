# Node systems · LB-08 Automation Studio

One Node monolith for the systems that suit Node best: LB-08 Automation Studio today, then
LB-04, LB-06 and LB-07. Each system is a module with its own API prefix, Postgres schema,
queues and tests, so it can be split into a service of its own later. Models are called only
through the AI gateway.

LB-08 turns a description of a business process into a typed workflow graph, checks it,
versions it, and runs it on a queue with retries, approvals, a dead-letter queue and
replay, against sandboxed connectors that never leave the machine. Why it is built this
way: [`docs/STACK.md`](../../docs/STACK.md), Node systems. Platform security:
[`docs/SECURITY.md`](../../docs/SECURITY.md).

## At a glance

| Parameter | Value |
|---|---|
| API | Fastify 5 with the Zod type provider, under `/api/`: LB-08 at `/api/lb08/`, plus `/api/healthz` (liveness) and `/api/readyz` (each system's schema and Redis). Schema: [`openapi.json`](openapi.json), served at `/api/openapi.json` |
| Callers | The site's server, with an Ed25519 visitor token scoped to one system and valid 5 minutes at most (`@lb/common`'s [visitor check](../../packages/common/src/visitors.ts)) |
| Worker | A separate process (`src/worker.ts`): BullMQ on Redis, one job per workflow step, plus a repeating sweep |
| Data | PostgreSQL 17: one schema per system (`lb08`), Drizzle ORM and drizzle-kit migrations |
| Model calls | Through the gateway only, alias `lb-tools`, at most 2 a description, both labelled with the one run that description is |
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

## Running it locally

```sh
cp services/node-systems/.env.example services/node-systems/.env   # then fill it in
just node-migrate && just node-seed
just node-api       # the API on http://127.0.0.1:8002
just node-worker    # the step jobs and the sweep
```

Describing a workflow needs the gateway (`just gateway`) with provider keys, and the
service key pair from `just gateway-token keygen node-systems <key-file>`, whose public key
goes in the gateway's `LB_SERVICE_KEYS`. Samples, runs, replays and everything else work
without a model. The worker needs no gateway.

| Variable | Meaning |
|---|---|
| `LB_NODE_HOST`, `LB_NODE_PORT`, `LB_NODE_LOG_LEVEL` | Where the API listens (default `0.0.0.0:8002`) and how much it logs |
| `LB_DATABASE_URL` | The shared Postgres. Each system uses a pool whose search path holds only its own schema |
| `LB08_DATABASE_URL` | In production, a role that owns only the `lb08` schema; the shared URL is then not used for LB-08. Migrations run as this role too |
| `LB_REDIS_URL`, `LB_REDIS_PREFIX` | Redis, and the prefix of every key this service writes (default `lb:`) |
| `LB_WEB_TOKEN_KEY` | The site's Ed25519 public key. Without it the API refuses every visitor |
| `LB_GATEWAY_URL`, `LB_SERVICE_NAME`, `LB_SERVICE_KEY_FILE` | The gateway, and the service's own name and private key (a file nobody else can read). Required by the API only |
| `LB_SEED_DIR` | Where the seed data lives; the repository's `data/seed` by default |

A variable left empty counts as not set. Settings are checked once at startup, and a
mistake names the variables, never their values.

Redis keys this service writes, for the Redis ACL: `<prefix>bull:lb08-steps:*`,
`<prefix>bull:lb08-dead-letters:*`, `<prefix>bull:lb08-maintenance:*`, and the run spans the
gateway reads, `<prefix>run:<run id>:spans` and `<prefix>spans`.

## Layout

```
src/core/            what every system shares: app, errors, headers, text guard, env, logging,
                     database runner, OpenAPI registry, visitor-token hook, health
src/modules/lb08/    the system: db/ (schema, migrations), engine/ (runs, steps, queue, sweep),
                     generate/ (prompts, model, pipeline), routes/, data/, golden/
src/modules/registry.ts   the list of systems the monolith hosts
src/main.ts, src/worker.ts   the API process and the worker process
src/cli/             migrate, seed, openapi, eval-lb08 and the drift check
```

A new system joins by adding a module (its schema, routes, queues, `migrate`, `seed` and
`documentRoutes`) to the registry: the API mounts it, the worker runs it, and the migrate,
seed and OpenAPI commands pick it up.

## Tests

`just test` runs them with the rest of the monorepo; from this folder, `pnpm test`:
**404 tests**, 257 unit and 147 integration.

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
