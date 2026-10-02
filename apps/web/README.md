# apps/web: the site

The portfolio's site, in Nuxt: the catalog and the datasheets of the ten systems in English and
Czech, the server that stands between a visitor's browser and the back ends, and the evaluation
boards, the live demos. Stack and reasons: [`docs/STACK.md`](../../docs/STACK.md). Security:
[`docs/SECURITY.md`](../../docs/SECURITY.md) (sections 2 and 3, "What the site's server does" and
its threat model). Rules for the code: [`AGENTS.md`](../../AGENTS.md).

Built so far: the catalog, the datasheets, the server (session, Turnstile, the proxy, the Scope's
route, the recordings), the evaluation-board kit, **LB-01's board**, the reference every other
board follows, **LB-02's board**, the one that streams (a WebSocket) and can be installed as an app, and
**LB-05's board** (the Data Analyst: a question that takes up to 90 seconds in one request, a result table, a chart
drawn in the browser, and the safety demo).

## Run it

All of it through the root `justfile` (see the Commands table in `AGENTS.md`):

| Command | What it does |
|---|---|
| `just dev-mock` | The site on http://localhost:3000 against the mock back end (http://127.0.0.1:8120) with throwaway keys: LB-01 plays like the real one, the other systems answer examples that fit their OpenAPI documents. No back end, model or key needed |
| `just dev` | The site alone. With no `NUXT_*` settings the demos say they are not connected |
| `just build` / `just check-build` | The production build, and the proof that it holds no trace of the test build's Turnstile stand-in |
| `just e2e` | The test build, then the Playwright journeys against it and the mock back end |
| `just samples` | Regenerate the boards' curated samples from the golden sets (LB-01's, LB-02's and LB-05's) and LB-02's installable-app files: icon, manifests, offline pages (`just check` fails while they are stale) |
| `just record-sample <system> <sample>` | Record a sample's run on a live back end (see "Replay and recordings") |

The settings are the `NUXT_*` variables of [`docs/DEPLOY.md`](../../docs/DEPLOY.md), part 10;
`.env.example` lists them. All are optional together and required together: some set and any wrong
and the site refuses to start, naming the variable and never its value.

## How it is organised

```
app/
  pages/systems/[slug]/index.vue   the datasheet            /systems/lb-01
  pages/systems/[slug]/board.vue   the board page           /systems/lb-01/board
  pages/runs/[runId].vue           a run's trace            /runs/<id>
  components/board/                the evaluation-board kit (components)
  board-kit/                       the kit's logic: plain modules, no Nuxt, tested alone
  boards/registry.ts               which systems have a board
  boards/<system>/                 one folder per board (LB-01: Lb01Board.vue, store.ts, ...; LB-05 also chart/)
  stores/                          Pinia: session, scope, replay (kit-wide), reading, catalog
  plugins/00.zod-jitless.ts        Zod without `new Function`, which the CSP forbids
public/                            static files; LB-02's service worker is written by hand, its icon, manifests and offline pages are generated
server/                            Nitro: api-routes.ts is the one list of routes
shared/                            code the app, the server and the tests share: schemas, datasheets, samples
i18n/locales/                      en.ts and cs.ts, and boards/<name>.en.ts / .cs.ts for each module
scripts/                           samples, record-sample, record-fixtures, dev-with-mock, check-production-build
test/  e2e/                        Vitest (unit, components, integration, contract, production-flag) and Playwright
```

The route of a board lives with its datasheet: the datasheet says what a part is, the board is where
you try it. A part with no board says so on its `/board` page, and its datasheet links to the board
only once the board is in `app/boards/registry.ts`.

## The server

`server/api-routes.ts` lists every route, and `nuxt.config.ts` registers exactly that list:

| Route | What it does |
|---|---|
| `GET /api/session` | Creates the anonymous session on first use and says whether this deployment has a back end, whether the Turnstile check has passed today and when the day turns over |
| `POST /api/session/verify` | Checks a Turnstile token with Cloudflare; a pass marks the session verified for the day |
| `/api/lb01/**`, `lb02`, `lb05`, `lb08` | The proxy: only the routes the back ends' OpenAPI documents describe (`packages/api-clients`), with a visitor token the server signs. Anything that changes something needs the check |
| `POST /api/tokens/lb-02` | The five-minute grant for LB-02's WebSocket |
| `GET /api/runs/:runId/spans` | A run's trace from the gateway, for the Scope. Needs no session: the run's ID is the capability |
| `GET /api/recordings/:system[/:sample]` | The recordings of the curated samples |

Every route answers failures in the platform's error shape and never in the words of what failed.

## The evaluation-board kit

A board is a demo wrapped in the same frame. Everything below is system-neutral.

- **`<BoardShell>`**: the frame. A deep-blue title bar (part number, name, the badge **Live** or
  **Replay**), a main column, a side column and the Scope across the full width below. The deep
  blue marks live demos and nothing else.
- **`<BoardLimitsPanel>`**: what is left of the visitor's day and when it starts again, and in the
  Technical reading the datasheet's own operating limits (the board never states a limit the
  datasheet doesn't).
- **`<BoardScopePanel>`**: the trace of the run as a nested table (step, time with a bar, kind,
  model, tokens), filled in as the run goes on, with the permalink and a copy button for a live run.
  It draws from the Scope store and nothing else. Metadata only, never what was typed or answered.
- **`<BoardTurnstileGate>`**: the check, shown only while it runs or after it failed. The widget
  loads only when a visitor starts a live run, under the one Trusted Types policy `lb-turnstile`.
- **`<BoardNotice>`**: the words for each way a demo can fail (`unavailable`, `verification`,
  `quota`, `rejected`, `notFound`, `conflict`, `upstream`, `timeout`, `network`, `unknown`), taken from
  the locale files by kind and never from a response.
- **`<BoardReplayBanner>`** and **`<BoardSamplePicker>`**: the label a replay always carries, and the
  curated samples as radio buttons that start nothing by themselves.
- **Stores.** `useSessionStore` (state, the check, `ensureVerified()`), `useScopeStore`
  (`follow`, `settle`, `showRecorded`), `useReplayStore` (the list of recordings, `start`). Boards
  have their own (`useLb01Store`).
- **`board-kit/`**: `timeline.ts` (spans to rows), `follow.ts` (the polling pace), `replay.ts` (the
  replay plan and runner), `problem.ts` (the kinds of failure), `quota.ts`, `api.ts` (the typed
  clients and `callApi(request, schema)`: a failure becomes an `ApiProblem`, a success is checked
  with its Zod schema), `turnstile.ts`, `format.ts`.

The **Brief** and **Technical** reading modes are the datasheet's (`<ReadingModeSwitch>`, the reading
store). On a board, Brief keeps the demo, the console and the quota, and leaves out the pipeline list,
the limits table and the trace table.

Live runs **poll** (the ticket and the trace, about once a second). LB-02's conversation is the one
exception: it travels over a WebSocket, though its trace is polled like the others. A trace is
404 for the first moments of a run, so the Scope reads for a grace period before it says there is none.
A conversation writes no root span, so its trace never says it is finished: the board tells the Scope
with `scope.finish()` when the conversation ends.

**When does the back end name the run?** The Scope can only read a trace by its run ID, and a board
learns the ID from the system's own API. LB-01's Django saves a ticket's run ID with the pipeline's
outcome (`lb01/pipeline.py`, `save_result`), so the API says `run_id: ""` until the pipeline has
finished, and the Scope can show the whole trace only then: until it, it says it is waiting
(`scope.wait()`), and the board must not call a step running or done. A back end that names the run
when it starts lets the Scope fill in step by step; LB-01's store follows the run as soon as any
answer carries an ID (`followRun`), so it works with both. The mock back end plays Django as it is
(`runId: 'when-finished'`) and can play the other (`'at-filing'`). Check what your system's API does
before you design its live view.

**A system that answers in one long request** (LB-05's Flask, synchronous on purpose) names its run only
in the answer, so there is nothing to follow while it works. The board says so instead of pretending:
a clock counting the seconds used of the seconds a question is given, a way to stop waiting (the
service keeps going and the question still counts), a deadline a little past the site's own, and the
steps and the Scope filled in from the finished trace when the answer arrives. A replay of such a
system is one recorded exchange: the board plays the recorded trace first and shows the answer at the
end (`scope.replayed` and `scope.phase === 'finished'`).

## Adding a board

Take LB-01's folder as the template. For a system `LB-0N`:

1. **Datasheet.** It must already exist in `shared/data/systems.ts` and `systems.cs.ts`; the board
   takes the part number, the name, the limits and the signal chain from it with `findSystemIn`.
2. **The folder** `app/boards/lb-0n/`:
   - `Lb0nBoard.vue`, a component with two props, `permalinkFor: (runId) => string` and an optional
     `now`, that renders `<BoardShell :part :name :state>` with the default slot (the demo), `#aside`
     (limits, counters) and `#scope` (`<BoardScopePanel :brief :permalink>`). Its `<script setup>`
     opens with a comment that says what it is, like every file.
   - `schemas.ts`: a Zod schema for every answer the board reads, bounded, with the `Assert<...>`
     type checks against the generated OpenAPI types (see LB-01's) so the back end changing a field
     fails the type check, not the page.
   - `store.ts`: a Pinia setup store. Copy LB-01's `send()` for the one subtle part: when the server
     answers `verification_required` (a new day began), forget the verification, run the check and
     try once more.
   - `components/` and plain logic modules (LB-01's `pipeline.ts`), small, each with its tests.
3. **Register it** in `app/boards/registry.ts`: one line. The datasheet then links to
   `/systems/lb-0n/board`.
4. **Words.** `i18n/locales/boards/lb-0n.en.ts` and `lb-0n.cs.ts`, imported by `en.ts` and `cs.ts`
   (as `lb0n`). The Czech module `satisfies` the English one, so a missing translation fails the type
   check; Czech is typeset with `vlna` once, for the whole language, in `cs.ts`.
5. **Calls.** Through `apiClients()` and `callApi(request, schema)`, never a bare `fetch`; the site's
   own routes through `getJson` and `postJson`. Before a run that spends quota, `await
   session.ensureVerified()`. Follow a live run with `scope.follow(runId, { notFoundGraceMs })` as soon
   as an answer names the run (`scope.wait()` until then) and tell the Scope the run is over with
   `scope.settle()`. Never take the run ID from the answer to filing alone: see the paragraph above.
6. **Samples.** If the system has curated samples from a golden set, extend `scripts/samples.ts` to
   generate them (`pnpm check` fails when the file is stale) and type the locale titles by the sample's
   ID, as LB-01's are.
7. **Replay.** Samples with a recording replay it through `useReplayStore().start(recording,
   applyExchange)`, where `applyExchange` applies each recorded answer as the API's own. A sample with
   none says so and offers the live run, which spends quota and so needs the check.
8. **A recorder.** Add `scripts/record/lb0n.ts` (what a sample's run does and which answers to keep) and
   list it in `RUNNERS` in `scripts/record/record.ts`. Then `just record-sample lb-0n <sample>` on the
   live back end writes the recording; commit it with the system.
9. **Tests.** The store against `FakeSite` (`test/support/fake-site.ts`: add the system's routes), the
   components with `mountWithSite`, and a Playwright spec like `e2e/lb01.spec.ts` and
   `e2e/board-a11y.spec.ts` (replay, a live run, each failure, both languages, the keyboard, axe in
   both themes). The mock back end (`packages/api-clients/src/testing`) must play the system's flow;
   `scripts/record-fixtures.ts` makes the recordings the journeys replay.
10. **Streaming systems** (LB-02's WebSocket): get the grant from `POST /api/tokens/lb-02` and open the
    connection to the API's origin. The token goes in the first frame only, every frame is checked with
    its schema and a malformed one closes the connection (`app/boards/lb-02/socket.ts`, `wire.ts`).
    The page may connect to the API's origin on that board's routes only. The origin comes from the
    runtime settings, which `nuxt.config.ts` cannot read, so `server/lib/lb02-csp.ts` adds it to
    `connect-src` for the board's route rules when the server starts. Route rules replace an array
    rather than merging it, so a rule that changes a directive writes the whole directive out.
11. **Installable boards** (LB-02): a board's head links go through `boardLinks(slug, code)` in the
    registry (the language's manifest), the files are generated by `scripts/generate-lb02.ts` (`pnpm
    check` fails when they are stale) and the service worker (`public/lb02-sw.js`) is a plain script
    that keeps the board's page and its static files and nothing else; its rules and the policy it needs
    are in [`docs/SECURITY.md`](../../docs/SECURITY.md), section 2. Test that it never keeps an API or
    WebSocket address (`e2e/lb02/app.ts`).
12. **A calendar every visitor shares** (LB-02) makes the end-to-end tests run one after another on a
    calendar nobody has touched: the mock's `/__mock/lb02/*` controls (`reset`, `limits`,
    `other-visitor`, `advance`, `sweep`, `drop`) set the scene, and no other spec uses LB-02's mock.
    `pnpm --filter @lb/web record:fixtures lb-02` makes only LB-02's recordings.
13. **Heavy code.** Load it with `import()` when it is first used, and leave it out of the page's
    `prefetch` hints: Nuxt would otherwise have every visitor of the board fetch it while idle. LB-05's
    chart (Vega, about 270 kB gzipped) is excluded by the `build:manifest` hook in `nuxt.config.ts`;
    `e2e/lb05.spec.ts` checks that no big script loads before a chart is drawn.
14. **Model output and database cells are untrusted.** Show every cell and every query as text (LB-05's SQL
    is split into spans, never parsed as markup), check anything a board is asked to draw against a
    strict schema before it reaches a drawing library (`app/boards/lb-05/chart/spec.ts`), and prove the
    drawing needs no `eval`: the test build's policy has no `unsafe-eval`, and a headless test runs the
    drawing under `node --disallow-code-generation-from-strings`.
15. **Code the recorder shares with the app.** `scripts/record/*.ts` run under plain Node, which cannot
    resolve the `#shared` alias; `package.json` maps `#shared/*` to `./shared/*.ts` so a board's schemas
    can be read by the recorder. A call that may take longer than 30 seconds passes its own timeout to
    `Backend.call`. Do not import another folder by a relative `.ts` path from app code: the server build
    would leave that import unresolved.

## Replay and recordings

A recording (`recordingSchema` in `packages/contracts`) is the requests a board made while it ran a
sample, the answers it got and the run's spans. The board hands the answers back one after another and
reveals the spans as they ended, over a few seconds (or at once, for a visitor who prefers reduced
motion), always under the **Replay** badge, and never touches the back end.

`just record-sample <system> <sample>` makes one on a live back end: it runs the sample as a synthetic
visitor, keeps each answer that shows a new state, reads the whole trace from the gateway and writes
`recordings/<system>/<sample>.json`. The recorder does not choose the label: a back end that answers
as the test mock gets `origin: mock` and is written under `e2e/fixtures/recordings`; any other gets
`live`. The site shows a `live` recording to anyone, and a `mock` one only in the end-to-end build.

**There are no live recordings yet.** One needs a live back end with a model behind it, and none was
available when this was built; the recorder has been run against the mock only. Until a sample has
one, its board says "No recording yet" and offers the live run. See `recordings/README.md`.

## Tests

- **unit**: plain modules, stores, locale files, the server's building blocks (Node).
- **components**: Vue components in a DOM (happy-dom) with the real messages; includes the whole
  LB-01 and LB-05 boards in both languages against `FakeSite` (`delayNext` holds a call back, `failNext`
  makes one fail).
- **integration**: the site's server over HTTP against the mock back end, route by route; the recorder
  and the `record-sample` command.
- **contract**: the site's server against the real gateway and a real Redis (Testcontainers, or
  `LB_TEST_REDIS_URL`).
- **production-flag**: the few tests that must see the build flag as a production build does.
- **e2e**: Playwright in a real browser against the test build and the mock (`just e2e`). Every test also
  fails on a Content-Security-Policy or Trusted Types violation, a page error or a console error.

`pnpm typecheck` also runs `tsc -p tsconfig.tools.json`, a strict check of the scripts, the tests and the
journeys, which `nuxt typecheck` does not read. Where a Chromium is preinstalled, point Playwright at it
with `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome`.

### Against the real services

The mock plays what the OpenAPI documents allow; the real service does what its code does, and the two
differ. LB-01's API names a ticket's run only when the pipeline has finished, which its document allows
and the first mock did not do, so every live run failed on the real service until a run against it found
that. Before a board is called done, run it once against the real service with fake models. It is not a
command yet, because it needs a Postgres with pgvector and a Redis. For a Django system (LB-01):

1. A scratch database, then `manage.py migrate --database lb01` and `seed_lb01`, with the variables in
   `services/django-systems/.env.example` and `LB_WEB_TOKEN_KEY` set to the public half of a throwaway
   site key.
2. The gateway (`node src/main.ts` in `services/gateway`) on the same Redis and key prefix, with the
   `web` service key's public half in `LB_SERVICE_KEYS`. It will not start without a provider
   configured; a placeholder key satisfies that, and no model is called, since nothing asks for one.
3. Django under uvicorn, and a worker that does what `lb01.tasks.run_ticket` does (`claim_ticket`, then
   `TicketPipeline(...).run`) with `tests/support.py`'s `FakeGateway` and `FakeChat` for the models and a
   `RedisSpanWriter` for the spans, so the real tracer writes real spans.
4. The test build of the site (`pnpm --filter @lb/web build:e2e`) with `NUXT_LB_API_URL` and
   `NUXT_LB_GATEWAY_URL` pointing at them, and a browser. Watch what the board shows every second, not
   only at the end, and file the day's twenty-one tickets.

For a streaming system, such as LB-02, add three things. Run Django under uvicorn with the real
Channels routing and Redis channel layer and fake models (`consumers.shared_concierge` can be replaced
by a `Concierge` built from the test fakes), and serve the gateway's trace route from the spans the
tracer wrote. Leave a conversation open without typing for ten seconds: a connection that only dies when
nothing happens is not found by a test that talks. And cut the socket from the browser's side
(Playwright's `page.routeWebSocket`, which can also log the frames' types) in the middle of a turn, since
a mock closes connections politely and a network does not. The first run of LB-02 found the first
(the real service closed an idle socket every five seconds: the locked redis-py 8 reads with a
five-second socket timeout, the same length as channels-redis 4.3's blocking read) and the last (a
dropped turn leaves the visitor's message in the transcript with no answer, which the board now says).

For a Flask system (LB-05) the recipe is the same shape with different parts, and it found real
differences between the mock and the service in its first run:

1. A scratch Postgres database, `manage.py migrate`, and `manage.py seed_lb05 --size small --today <day>`
   into a scratch folder (`LB05_WAREHOUSE_DIR`), with `LB_WEB_TOKEN_KEY` set to the public half of a
   throwaway site key.
2. The gateway as in step 2 above, on the same Redis and key prefix as the service (`LB_REDIS_PREFIX`).
3. The Flask app under gunicorn, but built by a small module of your own instead of `wsgi.py`: a
   `Platform` with the real engines and a `RedisSpanWriter` tracer and a fake in place of `GatewayChat`.
   The fake answers a question with the golden set's reference query, an attack with the adversarial
   set's query, and the explainer with a sentence; it reads from a file how long to take and whether to
   fail, so a run can be slow or `unavailable` without a restart.
4. The test build of the site pointed at them, and a browser: every curated question and every attack,
   a wait of 4, 18 and 100 seconds, a second question while one runs, the day's 25 questions, the
   service failing, and a bad explanation.

What it found: the real service writes a `DATE_TRUNC` result as a timestamp (`2025-01-01T00:00:00`), a
date-only value from a `DATE` column, a chart for `SELECT *` that plots an ID, and a count it takes when a
question is admitted (so a stopped or timed-out question must be counted again by reading the quota). It
found nothing wrong with the mock's flow of outcomes, and the attacks were stopped at the layers and for
the rules `evals/lb05/adversarial.yaml` names.

## Decisions worth knowing

- **The test build** is the production build with two differences, both decided at build time by the flag
  `__LB_TEST_BUILD__`: it accepts a fixed stand-in for a Turnstile token, and it shows `mock`
  recordings. Production replaces the flag with `false`, so neither is in its bundle; CI checks it
  (`scripts/check-production-build.ts`), and runs the check the other way round on the test build
  (`--expect-test-code`) to prove it can see the code. A check that finds no build to look at fails with
  status 2, never passes. The test build goes to `.output-e2e`, and only a build writes there: the dev
  server is a test build too (`just dev-mock`) and would otherwise empty it.
- **Zod runs jitless** in the browser (`app/plugins/00.zod-jitless.ts`): its probe for `eval` is caught
  but reported by the browser as a Trusted Types violation, on the first schema of every page.
- **Pages set no cookie**; the session cookie exists only after a call to `/api/*`, which a board makes
  when it opens.
- **What was run against the real thing, and what was not.** The board ran against the real Django
  API, the real gateway's trace route and the real tracer's spans, with the Django tests' fake models
  in place of the models; the production build ran with the real Turnstile widget and Cloudflare's
  published test keys. LB-02's board ran against the real Django and Channels service, the real Redis
  channel layer, Postgres with its booking constraint and the real tracer, with fake models, and was cut
  off mid-turn from the browser's side. LB-05's board ran against the real Flask service (real Postgres
  ledger, DuckDB warehouse of the small size, SQL checks and pipeline, gateway and spans) with a fake in
  place of the models, on a dataset of about 28,000 orders, not the full two million. Not run: a real
  model, a real Turnstile site key and challenge, Vercel, an installation of the app on a phone, the full
  dataset, and the recorder against a live back end. What that leaves open is in
  [`docs/DEPLOY.md`](../../docs/DEPLOY.md), part 12.
- **LB-05's chart.** The back end writes a Vega-Lite spec; the board checks it against a strict subset
  (`chart/spec.ts`: a bar, line or point mark, inline data, no `url`, no expression) and only then hands
  it to Vega with `vega-interpreter`, so nothing is compiled from a string and the page's policy keeps
  `unsafe-eval` out. It is drawn on a canvas with no tooltip, in the design tokens' colours read at draw
  time (eight series tokens, validated for colour-blind separation in both themes; three light slots
  are under 3:1 on the sheet, which the legend and the data table make up for), in the page's language
  (number and month names from `Intl`), with a time axis counted in UTC so a day reads the same in
  every time zone. Every chart has a text alternative and a table of its points.
