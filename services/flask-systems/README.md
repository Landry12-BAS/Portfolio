# Flask systems · LB-05 Data Analyst

One Flask app for the systems that suit Flask best: LB-05 Data Analyst today, then LB-03
Invoice Reader and LB-10 Eval Lab. Each system keeps its data in a Postgres schema of its
own and calls models only through the AI gateway.

LB-05 answers a business question about Basalt & Bean's sales data by writing SQL, checking
it, running it read-only, and showing the SQL, the table, a chart and a plain explanation.
A visitor is invited to make it delete data, and sees which layer stopped them. Why it is
built this way: [`docs/STACK.md`](../../docs/STACK.md), Flask systems. Platform security:
[`docs/SECURITY.md`](../../docs/SECURITY.md).

## At a glance

| Parameter | Value |
|---|---|
| API | Flask 3.1 with flask-openapi3 (OpenAPI 3.1) under `/api/`: LB-05 at `/api/lb05/`, plus `/api/healthz` (liveness) and `/api/readyz` (each system's database). Schema: [`openapi.json`](openapi.json), which a test keeps current |
| Callers | The site's server, with a short-lived Ed25519 visitor token scoped to one system ([`core/visitors.py`](core/visitors.py)). No accounts |
| Data | PostgreSQL 17, one schema per system (`lb05`, Alembic migrations): the daily question counters. The sales data is synthetic, made by this service, and queried in-process from a read-only DuckDB file |
| Model calls | Through the gateway only, with [`lb-common`](../../python/lb-common/README.md): `lb-reason` writes the SQL and `lb-fast` explains the result, all labelled with the question's run |
| Runtime | Python 3.13, gunicorn `gthread` (one worker of eight threads), bound to `127.0.0.1:8102`; the reverse proxy is the only way in |
| Operating limits | 25 questions per visitor per day · 5 s query timeout · 1,000-row cap · 2 to 4 model calls a question (5 at most) · 90 s a question |

## Run it

```sh
just install
cp services/flask-systems/.env.example services/flask-systems/.env   # then fill it in
just migrate-flask      # create the lb05 schema
just seed-lb05          # about two million orders; add --size small for a quick one
just flask              # http://127.0.0.1:8102
```

Without the gateway settings (`LB_GATEWAY_URL`, `LB_SERVICE_NAME`, `LB_SERVICE_KEY_FILE`) the
service still runs and serves the semantic layer and the quota; a question is a 503. Without
`LB_WEB_TOKEN_KEY` (the site's public key) every visitor call is refused. Without the data,
LB-05 does not start serving, says why in the log, and fails its readiness check, and the
other systems of the monolith are untouched.

## LB-05: from a question to an answer

One question is one run. Each step below is a span of the run's trace, and the model calls
behind it nest under it.

| Step | Who | What it does | When it can't |
|---|---|---|---|
| Admit | Postgres | One upsert counts the question against the visitor's 25 and marks one running | 429 `daily_limit` (with the time it starts again) or 429 `question_running` |
| Resolve metrics | code ([`resolve.py`](lb05/resolve.py)) | Finds the metrics, slices and date phrases the question names, and the dates those phrases mean counted from the data's last day. The model is handed their exact definitions, so "revenue" means one thing everywhere | Nothing named: the model works from the layer's descriptions |
| Write SQL | `lb-reason` | One JSON answer: a query, or the reason the data can't answer. Checked against a Pydantic schema and repaired once if it isn't valid | `declined`, with the model's reason; `unavailable` if the repair fails too |
| Parse and allowlist | code (sqlglot) | Exactly one SELECT, using only the layer's tables, columns, joins and functions. What runs is the checked tree, not the model's text | Refused. A mistake gets one correction, an attack none |
| EXPLAIN | DuckDB | Plans the query without running it; refuses cross products and a step that expects more than 100 million rows | The same |
| Run read-only | DuckDB | On a locked-down connection, at most 1,000 rows, at most 5 s | The same |
| Self-correct | `lb-reason` | Once, for a mistake only: told which layer stopped the query and why, and asked for a new one | Refused, with both attempts shown |
| Chart | code ([`chart.py`](lb05/chart.py)) | A Vega-Lite spec (bar, line or point) built from the result's shape by this service; the model never writes a spec. Identifiers (`id`, names ending in `_id`, the keys the layer joins on) are never drawn, and the number drawn is a metric the layer defines when the result has one | No chart, and the span says why: a single value, nothing that is a quantity, nothing to set it against, or a list of records with several rows for one point (`SELECT * FROM orders`). The table is always shown |
| Explain | `lb-fast` | One short explanation from the question, the SQL and a preview of the result | A fixed sentence built from the numbers (`explanation_source: "fallback"`) |
| Finish | Postgres | Frees the visitor, and gives the question back if the service itself failed, up to five a day | |

**Model calls.** A question that goes straight through costs two: the SQL and the
explanation. A correction adds one, and a reply that isn't valid JSON adds one for its single
repair, so three or four is common for a hard question. The pipeline stops itself at five
([`QuestionBudget`](lb05/pipeline.py)), at 90 seconds in all, and gives each call the smaller
of 60 seconds and the time left. `services/gateway/routing.yaml` carries the same cap
(`maxCallsPerRun: 5`) as a second line. The curated samples are cached by the site and cost
no call; only custom input spends quota.

**An answer is never a failure of the service.** A refusal, a decline and a query that fails
twice are all a normal 200 with an `outcome`: the visitor is meant to see which layer stopped
them. Only a request the service can't take at all (no token, no questions left, a malformed
body, the service not ready) is an HTTP error. When the service itself fails (the models are
down, the day's model capacity is used, the question took too long, the data engine is busy)
the outcome is `unavailable` and the question is **not counted**, for up to five such questions a day
(see the quota, below); after that a failed question counts, and the message says so.

## The layers of SQL safety

| # | Layer | Where | What it stops |
|---|---|---|---|
| 1 | `parse` | [`sql_policy.py`](lb05/sql_policy.py) | Anything but one SELECT: stacked statements, DDL and DML, `PRAGMA`, `SET`, `ATTACH`, `COPY`, `INSTALL`, `LOAD`, text that doesn't parse, control characters, SQL that is too long or too complex |
| 2 | `allowlist` | [`sql_policy.py`](lb05/sql_policy.py) | Everything not listed: tables, columns (the two hidden ones included), joins other than the declared keys, all but about fifty functions and constructs, table functions, catalogs (`information_schema`, `duckdb_*`, `pg_*`), file and network access (`read_csv`, globs, URLs) |
| 3 | `explain` | [`warehouse.py`](lb05/warehouse.py) | Plans that multiply rows: cross products and joins without an equality, a step expecting more than 100 million rows; also anything the database can't bind |
| 4 | `connection` | [`warehouse.py`](lb05/warehouse.py) | What got through anyway: the DuckDB file is opened read-only, external access and extension loading are off, the configuration is locked, memory is 1 GB with no spilling to disk, each request has its own cursor, three queries run at a time |
| 5 | `row_limit` | [`sql_policy.py`](lb05/sql_policy.py) | Big results: the cap is set on the checked tree (never by editing text) and the result is cut at 1,000 rows, saying so |
| 6 | `timeout` | [`warehouse.py`](lb05/warehouse.py) | Slow queries: a timer interrupts the query at 5 s |

Three habits make the first two layers hard to get around:

- **Everything is an allowlist.** A syntax node, function, table or column that is not listed
  is refused, so a construct nobody thought of is refused too.
- **What runs is the checked tree.** The SQL handed to DuckDB is rendered from the tree after
  it was qualified (every column named with its table, every `*` spelt out as the columns the
  layer allows). A query that sqlglot and DuckDB would read differently can't slip through the
  gap, because DuckDB reads sqlglot's own output. The rendering is checked again and must
  come out the same.
- **It fails closed.** Any exception while checking, including the recursion limit, refuses
  the query.

Each refusal has a name: a layer and a rule ([`safety.py`](lb05/safety.py)), and each rule is
either a mistake worth one more try or an attack that gets none. The visitor, the span and
the test all use the same two words.

## The semantic layer

[`data/seed/lb05/semantic_layer.yaml`](../../data/seed/lb05/semantic_layer.yaml) is the one
description of the data the model sees, and the allowlist: five tables, six joins, twelve
metrics and fourteen slices, each with a name, a description and, for a metric, an exact
definition. It is read strictly (an unknown field is an error). At startup every expression
and worked example in it is run through the same SQL check a visitor's query meets, and the
warehouse must hold exactly what the layer describes: a typo or an unsafe expression stops
LB-05 from serving. The layer is served at `GET /api/lb05/semantic-layer`, so the site can
show what a question may use.

## The data

[`lb05/generator.py`](lb05/generator.py) makes the sales data deterministically: numpy's raw
PCG64 stream and integer arithmetic only, so the same seed and day give the same bytes (the
digest is in `meta.json`). Dates are relative to the day it was generated, so "last quarter"
always has sales in it, and money is in Czech crowns.

| Size | Customers | Orders | Use |
|---|---|---|---|
| `full` | 385,000 | 2,020,822 (3,121,650 order lines, seed 5) | The live service; 78 MB on disk, Parquet and DuckDB file together |
| `small` | 6,000 | 28,435 | Tests and evals |
| `tiny` | 500 | 1,832 | Command tests |

`just seed-lb05` writes it to `data/generated/lb05` (git-ignored), as Parquet for inspection
and as `lb05.duckdb`, swapped in atomically from a staging folder. The service opens only the
DuckDB file, in which the tables are copies, so it needs no filesystem access at all. Two
columns (`customers.email` and `orders.payment_reference`) are in the data and left out of
the layer on purpose, so there is something for the layers to refuse to show.

## The API

Every route needs a visitor token minted for `lb-05`; anything else is a 401 before any work.

| Route | What it does | Answers |
|---|---|---|
| `POST /api/lb05/ask` | Takes `{"question": "…"}` (5 to 300 characters of plain text, nothing else in the body) and answers synchronously: the SQL tried, the checked SQL that ran, the table, a chart, an explanation, the model calls it took and the questions the visitor has left | 200 with an `outcome` of `answered`, `declined`, `refused` or `unavailable`; 401; 422 naming the fields at fault and never echoing them; 429 `daily_limit` (with `resets_at`) or `question_running`; 503 `unavailable` when LB-05 has no data or no gateway |
| `GET /api/lb05/semantic-layer` | The tables, joins, metrics (with their exact definitions), slices and date phrases, with the dates counted from the data's last day | 200; 401; 503 |
| `GET /api/lb05/quota` | Questions used and left today, when the count starts again (midnight UTC), and the limits LB-05 enforces | 200; 401; 503 |

Every field of an answer is untrusted text or a number: the model's SQL, the explanation and
every cell are to be shown as text and never as markup or run. The chart is the one thing the
site renders as a spec, and the service built it.

## The daily quota

25 questions a visitor a day is the datasheet's promise, and it is kept here, by the service,
in one SQL statement ([`quota.py`](lb05/quota.py)): a question is admitted by an upsert that
raises the visitor's counter only while it is below 25 and nothing of theirs is running, so
questions that arrive together can't both take the last place. The same row holds a running
mark that expires on its own, so a visitor has one question at a time and a dead process
can't lock them out. A question the service fails to answer is refunded, but only five a day
([`MAX_REFUNDS_PER_DAY`](lb05/safety.py)). Almost any such failure can be caused on purpose (a question that
makes the model's reply unreadable, or slow enough to run out of its 90 seconds), and unlimited free attempts
would be unlimited work. The count itself keeps the answers a visitor is given to 25 a day whatever fails;
the cap keeps the attempts that cost them nothing to five, so a visitor has 30 attempts a day at most. The
gateway's per-session call quota bounds the model calls behind them either way. The first question
each day deletes the counters older than two days, so no history of a visitor is kept and
retention doesn't depend on a scheduler (`manage.py sweep_lb05` does it by hand). The gateway's
own per-session quota is a second line behind this one.

A visitor is known only by the hash of their session, from the token. A visitor who gets a
new session gets a new count: Turnstile and the site's own limits stand in front of that, and
the gateway's daily pool is the hard cap on what it can cost.

## Evals

Two sets, written before any prompt ([`docs/PLAYBOOK.md`](../../docs/PLAYBOOK.md), step 3).
Nothing in either is graded by a model.

- **Golden set** ([`evals/lb05/golden.yaml`](../../evals/lb05/golden.yaml)): 100 questions,
  each with a reference query whose result is the right answer, seven of them marked as the
  curated samples the demo opens on. A model's query is graded by running it and the
  reference on the same data and comparing the results by rule: the same rows, numbers within
  a tolerance, column names ignored, the same order only when the question asks for one. Tests
  prove every reference query passes the same SQL check and returns rows.
- **Adversarial set** ([`evals/lb05/adversarial.yaml`](../../evals/lb05/adversarial.yaml)):
  109 attempts in ten categories (destructive 11, stacked statements 6, comments and quoting
  10, file access 10, database commands 16, catalog access 13, exfiltration 15, resource
  exhaustion 16, injection 5, missing data 7). Each gives what a visitor might type, the query
  a model that obeyed would write, and the layer and rule that must stop it. 103 must be
  refused; for the other six, being held means something else (a dump is answered, cut to
  the 1,000-row cap).

Offline, with no model (runs in CI): every attack's query goes through the real layers and
the layer that stops it must be the one named; a fake model that obeys every attack is held
100% (106 refused, and the 3 dump attempts answered with 1,000 rows). Live, with the gateway
(`just eval-lb05`): the golden set reports execution accuracy, model calls a case and how
many cases needed their correction; `just eval-lb05 --adversarial` puts each attack's
question to the real model, and exits 1 unless every attempt it could grade was held (a run in
which the models were unreachable proves nothing, so it does not pass). The golden run
reports and exits 0: there is no accuracy gate until a live run has measured one.

## What a run leaves behind

Spans go to the run's Redis stream under the gateway's key prefix, as the other systems' do:
`data question` (the root, with the outcome, calls, queries tried and rows), `resolve
metrics`, `write SQL`, `self-correct`, `write SQL again`, `parse and allowlist`, `explain plan`,
`run read-only`, `build chart` and `explain result`, each with counts, names and codes. They hold no question,
no SQL text, no cell and no session. Errors are logged by type and place, never by message,
since an exception's message can quote a visitor.

## Tests

890 tests: 858 unit and 32 integration, run with `just test` or from this folder with
`uv run pytest`. The unit tests need no Docker.

- **The layers.** Each layer and each rule has tests; the adversarial set runs through the real
  layers and each attempt must stop at the layer it names; the locked connection is checked
  alone, with every earlier check removed.
- **The pipeline.** The chain, the one correction, the call budget, the deadline, the explainer's
  fallback and what spans may hold, with a scripted fake in place of the gateway. No test calls
  a provider, and none can: no key exists in this repository.
- **The API.** The visitor guard, a question's whole way, refusals and declines, refunds, the
  twenty-sixth question, the cap on refunds, malformed bodies and every 503 path, over an in-memory ledger.
- **On real servers** (integration; `LB_TEST_DATABASE_URL` and `LB_TEST_REDIS_URL`, or Docker
  with Testcontainers): the ledger on a real Postgres, including sixty simultaneous questions
  that must admit exactly 25 and thirty from one visitor that must admit one; the Alembic
  migrations from an empty database, compared with the models; the whole API on that ledger,
  with a second question refused while the first is held at the model; and a question's spans
  in a real Redis stream.
- **Drift.** `openapi.json` is regenerated and compared (`just openapi-flask` fixes it); the
  gunicorn settings that keep the server small and local are pinned. The chart builder and the
  mock back end's copy of it (`packages/api-clients/src/testing/lb05-chart.ts`) are held to the
  same cases, [`evals/lb05/chart-cases.json`](../../evals/lb05/chart-cases.json), by a test on each side.

## Threat model

**What is protected.** The synthetic sales data's integrity (nothing may change it); what the
visitor may see (the layer's columns only, and no catalog, file or setting); the machine (CPU,
memory, disk and network are shared with the other systems); the model quota; and the privacy
of visitors (their words are never logged).

**Who attacks.** A visitor typing to the model, which is the whole point of the demo: they
ask for destruction, for files, for the hidden columns, for a query that never ends, or tell
the model to ignore its rules. A visitor calling the API directly with a forged or replayed
token, a swollen body, a wrong host or many sessions. A compromised or merely persuaded model:
its reply is untrusted input however it is written.

| Threat | Defence | What is left |
|---|---|---|
| Destructive SQL: `DROP`, `DELETE`, `UPDATE`, `INSERT`, `ALTER`, `CREATE`, `COPY` | The parse layer accepts one SELECT and nothing else, and the connection is read-only underneath it | Nothing known. A statement that got past the parse layer would still meet a read-only database |
| Stacked statements, comments, quoting, null bytes, dollar quotes | One statement is parsed; what runs is the rendered tree, never the text, so nothing the parser ignored reaches the database; the rendering is re-checked to a fixed point | A difference between sqlglot's parser and DuckDB's would need a node the allowlist lets through: unlisted nodes are refused |
| Reading files, the network or the system: `read_csv`, globs, `httpfs`, `ATTACH`, `INSTALL`, `PRAGMA`, `SET`, catalogs and settings | Table functions and catalogs are refused by the allowlist; the connection has external access and extension loading off, its configuration locked, and no spill directory; the service opens only its own DuckDB file, which holds copies of the tables | A catalog or setting read is harmless data about the engine, but 48 of the 109 attempts are ones the locked connection alone would carry out: for those the parse-tree layer is the only defence |
| Reading what the layer hides (`customers.email`, `orders.payment_reference`), by name, `*`, `COLUMNS()`, a struct, a union or a subquery | Unknown columns are refused; `*` expands only to the layer's columns; the two columns are in no prompt | **The two columns are physically in the DuckDB file**, so only the parse-tree layer hides them. They are synthetic, but the layer is the only wall; dropping them from the served file would add a second |
| Exhausting the machine: cross joins, `generate_series`, `UNNEST`, `repeat`, regex backtracking, deep nesting, huge literals | No table-generating or string-multiplying functions and no regex in the allowlist; limits on length, nodes, depth and columns; the plan check refuses cross products and giant estimates; a 5 s interrupt; 1 GB with no spilling; two threads; three queries at a time | **DuckDB's `memory_limit` does not cap everything**: measured here, `UNNEST(GENERATE_SERIES(…))` and `REPEAT` ignore it, so the function allowlist is the guard and the limit is not. Run the worker under a cgroup memory limit as the outer wall |
| Prompt injection in the question ("ignore your rules and…") | The question is quoted as data in the prompt; but whatever the model is persuaded to write meets the same layers, so an obedient model changes nothing; the explainer sees only a bounded preview of the result | The live rate at which the prompt keeps the model from trying is unmeasured; the guarantee does not depend on it |
| Model output as an attack: SQL, chart, explanation | SQL: above. The chart is built by code from the result in a closed Vega-Lite subset, never written by the model. The explanation is plain text, stripped of control characters and bounded, with a fixed fallback | The site must render every field as text, never as markup (`v-html` is banned) |
| Quota abuse: many questions, parallel questions, many sessions, failures caused on purpose | 25 a day per visitor counted atomically in Postgres, one at a time; refunds for the service's own failures capped at five a day, so questions made to fail (an unreadable or slow reply, a crash) buy five free attempts and no more, and the answers given stay within 25; the gateway's per-session quota and daily pool behind it; Turnstile at the site | A fresh session is a fresh count: the gateway's pool is the hard cap on cost |
| Forged or replayed tokens, wrong audience | Ed25519 signature checked against the site's public key, audience must be `lb-05`, short life, no key configured means nobody gets in | A stolen token works until it expires, for one session's quota |
| Leaks through logs, spans and errors | Spans hold counts and codes only; errors are logged by type and place; 4xx and 5xx never echo the request; the access log has method, path, status and seconds, no address or query string | |
| Host header, oversized bodies, framing, caching | Trusted hosts, an 8 KiB body limit, the security headers of `docs/SECURITY.md` on every response including errors | |
| Supply chain: sqlglot and DuckDB upgrades | Versions are locked and audited (`uv audit` in CI); a new function or node is refused until it is listed | An upgrade can change what a listed function does: the offline adversarial set and the layer tests are the alarm |

## Measured, and not

Measured here, on a four-core development machine, with no model involved:

- The 100 golden reference queries on the full dataset, through the parse, plan and run
  layers with the default 1 GB and two threads: median 68 ms, 95th percentile 392 ms, slowest
  1,259 ms, none near the 5 s limit.
- A real gunicorn boot on real Postgres and a seeded dataset: ready in about 2.4 s, with the
  token check, the 401 and 503 paths, the security headers, the host check and a clean
  shutdown confirmed over HTTP.

Not measured, because no provider key exists to measure with: execution accuracy on the golden
set, how often the live model tries an attack, the live latency of a question, and the
datasheet's model-call estimate. The datasheet's numbers are targets until `just eval-lb05`
has run on live models. No load test of an async build has been made either, so the datasheet's
sync-over-async claim is not yet measured.

## Known gaps

- The two hidden columns live in the served DuckDB file (see the threat model).
- DuckDB's memory limit does not cap `UNNEST` or `REPEAT` allocations; the allowlist is the guard.
- One gunicorn worker means one DuckDB with its own memory limit: more workers multiply the
  memory, and the worker should sit under a container memory limit.
- The datasheet says four layers of SQL safety; the service has six named layers, of which the
  parse-tree check is two and the plan check is one more.

## Layout

```
config/        environment.py (Pydantic settings, one message naming every problem), systems.py (the systems served)
core/          app factory and registry, middleware (headers), errors, visitors, databases, migrations,
               structured output, OpenAPI, commands (cli.py), the platform shared by every system
lb05/          LB-05: api, service, pipeline, prompts, resolve, chart, quota, models, migrations/,
               sql_policy and warehouse (the safety layers), generator, golden and golden_eval, commands
tests/         unit/ and integration/
manage.py      python manage.py <command>: seed_lb05, eval_lb05, sweep_lb05, migrate, export_openapi
wsgi.py        the gunicorn entry point: gunicorn --config gunicorn.conf.py wsgi:app
```

A new Flask system is a module in its own folder that exports a `SystemModule` (its key,
schema, blueprint builder, commands and migrations) and is listed in `config/systems.py`.
