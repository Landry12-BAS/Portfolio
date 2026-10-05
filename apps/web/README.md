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
drawn in the browser, and the safety demo), **LB-08's board** (the Workflow Automator: a graph on a canvas and as an
outline, and a run with its retries and dead letters) and **LB-03's board** (the Invoice Reader: a file uploaded,
the page of the document with the place of every field drawn over it, a table of fields that can be corrected,
and the checks, the journal entry and the exports), **LB-04's board** (the Contract Radar: a PDF read in the browser
beside a risk radar, findings with their quotes, and redlines), **LB-06's board** (the Incident Commander: a shop
simulated minute by minute, dashboards that turn when a fault strikes, a team of agents at work, and a fix that
waits for the visitor's click) and **LB-07's board** (the QA Engineer: a test run followed while it waits for the
one sandboxed browser and while it runs step by step, the findings code made, the bug reports a model wrote, the
red-then-green verdict, the generated Playwright test in a code view, and the screenshots the browser kept).

## Run it

All of it through the root `justfile` (see the Commands table in `AGENTS.md`):

| Command | What it does |
|---|---|
| `just dev-mock` | The site on http://localhost:3000 against the mock back end (http://127.0.0.1:8120) with throwaway keys: LB-01 plays like the real one, the other systems answer examples that fit their OpenAPI documents. No back end, model or key needed |
| `just dev` | The site alone. With no `NUXT_*` settings the demos say they are not connected |
| `just build` / `just check-build` | The production build, and the proof that it holds no trace of the test build's Turnstile stand-in |
| `just e2e` | The test build, then the Playwright journeys against it and the mock back end |
| `just samples` | Regenerate the boards' curated samples from the golden sets (LB-01's, LB-02's, LB-05's, LB-08's, LB-03's and LB-07's), LB-02's installable-app files (icon, manifests, offline pages) and LB-03's sample files and page pictures (`just check` fails while they are stale) |
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
  boards/<system>/                 one folder per board (LB-01: Lb01Board.vue, store.ts, ...; LB-05 also chart/; LB-04 also pdf/; LB-06 also socket.ts)
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
| `/api/lb01/**`, `lb02`, `lb03`, `lb04`, `lb05`, `lb06`, `lb07`, `lb08` | The proxy: only the routes the back ends' OpenAPI documents describe (`packages/api-clients`), with a visitor token the server signs. Anything that changes something needs the check |
| `GET /api/lb07/runs/:runId/evidence/:evidenceId/image` | One of a run's screenshots as a picture: the evidence read through the same call the proxy makes, checked to be a PNG of at most 400 kB, and answered `image/png`, `nosniff`, `no-store` (LB-07) |
| `POST /api/tokens/lb-02`, `POST /api/tokens/lb-06` | The five-minute grants for LB-02's and LB-06's WebSockets |
| `GET /api/runs/:runId/spans` | A run's trace from the gateway, for the Scope. Needs no session: the run's ID is the capability |
| `GET /api/recordings/:system[/:sample]` | The recordings of the curated samples |

Every route answers failures in the platform's error shape and never in the words of what failed.

**A file in, and files out (LB-03).** The Invoice Reader is the one system a visitor sends a file to, and
the one whose routes answer with files (a page's picture, a CSV or JSON export). Going in, the proxy
reads a `multipart/form-data` body of up to 4 MiB of file and a 16 KiB envelope (`shared/lb03-limits.ts`)
and passes the bytes on without decoding them: the site never reads an untrusted document, and the
service reads it in a cage. The service takes 10 MB; a Vercel function takes a request body of 4.5 MB, so
the hosted site takes less than the service, and the board checks the same limit before it sends. Coming
out, a route whose OpenAPI document lists media types may answer with a file of exactly those types and
no other (anything else is a 502), and only a plain file name is passed on (`attachment; filename="invoice.json"`).
A picture and an export are plain links, `<img src>` and `<a download href>`, to the site's own path: the
page's policy needs only `img-src 'self'`, no script handles the bytes, and the visitor's session cookie
goes with the request as it does with every other call. The pictures and exports are `no-store`, and a
visitor with no session of their own gets a 404 for a document that is not theirs, not a 403.

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
A conversation is one run of up to 30 messages, so it writes its root span when it ends, which is when it
is handed to a person, and not before: until then its trace does not say it is finished, and a booked
conversation that is still open (the visitor may write again) never does. Its turns name that root as their
parent in advance, so the Scope shows them at the top while the conversation goes on and under the root once
it arrives. The board does not wait for it: it tells the Scope with `scope.finish()` as soon as it sees the
conversation closed.

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
     (limits, counters) and `#scope` (`<BoardScopePanel :brief :permalink>`). A board whose work
     needs more room than the main column (LB-08's canvas beside its form) puts it in `#wide`, which
     has the board's whole width under both columns. Its `<script setup>` opens with a comment that
     says what it is, like every file.
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
   A system whose runs write no root span (a conversation writes none, so the gateway never calls its
   trace `finished`) tells the Scope with `scope.closeWhenQuiet()` once its own log says the run is
   over, and the Scope then closes the trace at the first read that brings nothing new. Prefer a
   system that writes a root span when its run ends, as LB-08's workflow runs do: `scope.settle()`
   then waits for it, where `closeWhenQuiet()` could close the trace in the moment between the run
   ending and its root being written.
6. **Samples.** If the system has curated samples from a golden set, extend `scripts/samples.ts` to
   generate them (`pnpm check` fails when the file is stale) and type the locale titles by the sample's
   ID, as LB-01's are.
7. **Replay.** Samples with a recording replay it through `useReplayStore().start(recording,
   applyExchange)`, where `applyExchange` applies each recorded answer as the API's own. A sample with
   none says so and offers the live run, which spends quota and so needs the check.
8. **A recorder.** Add `scripts/record/lb0n.ts` (what a sample's run does and which answers to keep) and
   list it in `RUNNERS` in `scripts/record/record.ts`. Then `just record-sample lb-0n <sample>` on the
   live back end writes the recording; commit it with the system. A runner that makes a call with a
   query uses `backend.call(system, method, path, body, query)`, and keeps the path without it (a
   recording's paths have no query string). A runner that sends a file (LB-03's) uses `backend.upload(system,
   path, { name, type, bytes })`, which writes the multipart form as the board does and records the request as
   the file's name, since a recording cannot hold its bytes. A runner whose system writes no root span, or only sometimes
   (LB-02's conversation writes one only when it is handed over), returns `traceEnds: 'quiet'`, so the trace
   is read until it stops growing instead of until it is `finished`.
9. **Tests.** The store against `FakeSite` (`test/support/fake-site.ts`: add the system's routes), the
   components with `mountWithSite`, and a Playwright spec like `e2e/lb01.spec.ts` and
   `e2e/board-a11y.spec.ts` (replay, a live run, each failure, both languages, the keyboard, axe in
   both themes). The mock back end (`packages/api-clients/src/testing`) must play the system's flow;
   `scripts/record-fixtures.ts` makes the recordings the journeys replay (`pnpm --filter @lb/web
   record:fixtures lb-0n` makes one system's alone, and a system whose mock moves with time, such as
   LB-08's retries, is listed in `TIMED` there so the recorder's waiting moves the mock's clock). A
   board that loads a large library on demand (LB-08's Vue Flow canvas) stands in for it in component
   tests, which run in happy-dom, and leaves it to Playwright.
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
  makes one fail), and LB-04's against `Lb04Site`, whose back end is the mock's LB-04 (the real PDF
  extraction and review pipeline in a worker thread, with the golden set's reference reviewer for a model;
  the first open of each sample is done before the fake timers start, because a worker thread does not
  obey them), and LB-06's against `FakeLb06Site`, whose back end is the mock's LB-06 (the real simulator, the
  real detection and the reference agents for a model) with a fake WebSocket bound to the mock's hub, and LB-07's
  against `FakeLb07Site`, whose back end is the mock's LB-07 (a whole run worked out when it starts and shown as
  far as the clock has got, with the service's own finding ledger, verdict and test generator).
- **integration**: the site's server over HTTP against the mock back end, route by route; the recorder
  and the `record-sample` command.
- **contract**: the site's server against the real gateway and a real Redis (Testcontainers, or
  `LB_TEST_REDIS_URL`).
- **production-flag**: the few tests that must see the build flag as a production build does.
- **e2e**: Playwright in a real browser against the test build and the mock (`just e2e`). Every test also
  fails on a Content-Security-Policy or Trusted Types violation, a page error or a console error. The
  boards whose back end holds one state for everyone (LB-02's calendar, LB-07's one browser and its queue)
  keep their journeys and their accessibility checks in one file that runs one test after another, each
  from a mock reset by its control.

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

For a Node system (LB-08) the same steps are shorter: a scratch database and a Redis key prefix of
your own, `node src/cli/migrate.ts` and `seed.ts` in `services/node-systems`, then its API
(`src/main.ts`) and its worker (`src/worker.ts`) as two processes, behind the real gateway
(`buildGateway` from `services/gateway`, in your own process) in front of a scripted provider. Take the
routing table from `services/node-systems/test/support/routing.lb08.yaml`, which already lets the
site's server read the system's traces (`traceReaders: web: systems: [lb-08]`); a table without that
block makes every read of the Scope a 502. Then drive the board in a browser: every state of a run, a step made to fail three
times, the dead letter and its replay, the approval, a described process and a refused one, and the
eleventh run, which two tabs of one visitor can reach.

For LB-03 (a Flask system with a caged OCR, an upload and files out) the service runs as production runs it
(`gunicorn --config gunicorn.conf.py wsgi:app`, so the cage, pdfium and RapidOCR are real) on a scratch Postgres
database, a Redis key prefix and a folder of its own, and the models are not faked inside it but behind the real
gateway (`buildGateway`, in your own process) on a copy of the real `services/gateway/routing.yaml` whose three
providers' addresses are pointed at a scripted provider. The script answers the injection classifier by what the text
says, and each extraction with what a perfect model says for the golden document it recognises in the prompt (the
printed truth in `evals/lb03/golden.yaml`); it reads from a control port how long to take and whether to fail. The
test build of the site goes on top, and a browser: every sample, files of the visitor's own, each refusal (a pixel
bomb, a script in a PDF, a truncated file, an SVG, an empty one, a file the site's limit stops), three tabs of one
visitor (the third document is refused), the day's ten, the models failing, slow or answering nonsense, the gateway
unreachable, a document of three pages, a correction with its downloads, the shelf and its deletes, the trace's own
page, and the worker killed in the middle of a document.

What it found, none of which a test with fake readers could: every document, PDFs too, went to the vision alias,
because the OCR worker drew a picture for each file and the pipeline picks the alias by whether a picture exists; a
document stopped after the OCR had no page count, so the page of a stopped document, which a replay shows, could not be
shown live; and a worker that gunicorn respawned swept nothing until the first upload, so the documents a killed worker
had been reading stayed "being read" and files past their hour stayed on disk. All three are fixed, with tests that
fail without the fix. It found nothing wrong with the mock's flow of states.
LB-04 is a Node system too, and its recipe is the same with one more part, a provider that answers as
the golden set's reference reviewer. Run the real API and worker as two processes on a scratch database
and a Redis key prefix, the real gateway in your own process on the routing table of
`services/node-systems/test/support/routing.lb04.yaml` (with its timeouts raised if a model is to take
seconds, and with `web` among the service keys, since the site's server reads the Scope's traces as
`web`), and in front of the gateway a small HTTP server that speaks OpenAI's chat format. It tells which
model is asking by the first words of the system prompt (`You review a contract`, `You write the
findings`, `You propose replacement wording`), tells the sample from the planted passages in the
reading prompt, and answers with `referenceAnswers` from `golden/reference.ts`, so the service reviews
real PDFs through the real gateway and its real checks. It can be made slow or down by environment
variable. Put the test build of the site in front (`NUXT_LB_API_URL` and `NUXT_LB_GATEWAY_URL` pointing at
them, the site key's public half in the service's `LB_WEB_TOKEN_KEY`), and run the journeys against it:
Playwright reuses a server it finds on `E2E_PORT`, so `e2e/lb04.spec.ts` runs on the real service with one
worker (the provider remembers which sample it is reading). The recorder (`just record-sample lb-04
<sample> --out <a scratch folder>`) runs against it too. A recording made so is labelled `live` and was
made with a fake model, so it is never kept.

LB-06 is the same recipe again, with the provider answering as `ReferenceAgents` (`golden/reference.ts`), which
reads only the data slots of a prompt, so it needs to know nothing about the incident: the first words of the
system prompt say which agent is asking, and a plan starts a new set of reference agents. The guard
(`lb-guard`) is a model that answers with a number, and it must report a small prompt, since the gateway refuses
a classifier's answer that fills its window. The routing table is `routing.lb06.yaml`. An incident takes about
twenty seconds from the first click to the postmortem on the real clock (a minute of the shop every two seconds).
What running the board there found, none of which a test against the mock could:

- an incident that **reuses an earlier run's answers** (every visitor after the first, since the samples are
  cached) writes no span while it goes, and its root span a moment after it ends, so the Scope gave up looking
  after eight seconds and said there was no trace. The board now looks again when the incident ends;
- the same incident replays its steps stamped **1 and with no model call** (the contract's smallest step), so the
  board counted a call it never made. Each step now carries the calls spent when it was taken, zero until a model
  call has been made;
- a **failed incident cost the visitor's day**: with the models out of reach, the one incident a visitor gets a
  day was spent on an incident that never ran. The service now gives it back, once (and so does the mock), and the
  board says so and counts it again;
- the visitor's **own incident** really is screened: the guard flags an instruction in a flag's name, replaces it
  with a label and the agents read the label.

The journeys of `e2e/lb06.spec.ts` ran against it (two workers), and the recorder
(`just record-sample lb-06 <sample> --out <a scratch folder>`) wrote a recording the board replays to the
end. One thing to know when running the whole file there: every journey leaves an incident open, and the
service runs at most eight at once, so after about eight the service answers 503 (`too_many_incidents`) until
the oldest have ended (eight minutes at most). That is the service doing what it should.

LB-07 adds the one process that drives a browser: run the real sandbox (`node src/sandbox.ts` in
`services/node-systems`, with `LB07_SHOP_TOKEN_KEY`, `LB07_BROWSER_PATH` pointing at a Chromium, and its two
ports, the shop's and the runner's, moved to free ones), and give the API and the worker `LB07_RUNNER_URL`, the
same token key and `LB07_SHOP_ORIGIN`. The routing table is `routing.lb07.yaml`, with its timeouts raised. The
provider tells the planner, the re-planner and the writer of the bug reports apart by the first words of the
system prompt, finds the goal between the `<goal>` markers, plans a golden case's goal with the case's reference
plan and its scripted re-plans (and any other goal by rules, as the mock does), writes one report for each
finding it is shown, and answers the guard by whether the goal gives orders. A run takes from a few seconds to
about twenty on the real browser. What running the board there showed:

- the curated runs, the visitor's own goal, the re-plan (a goal that is the golden set's re-plan case, word for
  word), the hostile goal (the plan stayed in the shop), the link out of the shop (a step and a finding "stopped
  at the sandbox", the test not verified), the day's two runs, five visitors at once (four runs taken, "3 runs are
  ahead of yours" for the fourth, the fifth refused as busy), a run deleted, a reload that opens the run again,
  Czech on a phone, and the model down (the run failed, given back, the Scope showing the two failed attempts)
  all behaved as on the mock; the screenshots are the real browser's (1024 pixels wide, about 55 kB) and came
  through the picture route as checked PNGs;
- the page's tree comes from the service as **one long line**: its trimming takes a line break for a control
  character, so the tree's lines and indentation are lost. On the board that line widened the whole page to
  thousands of pixels (the mock showed it first, since it trims with the service's own function); every panel
  now keeps to the board's width and the tree wraps. The trimming itself is the service's to fix;
- a goal that gives the agent orders is screened (the Scope shows the guard's call) and the run goes on with the
  goal as data; the service says nothing to the visitor about the screen, so the board cannot either.

Twenty-two of the journeys of `e2e/lb07.spec.ts`, those that need none of the mock's controls but its reset, ran
against it with a stand-in for the reset; the re-plan and keyboard journeys need the mock's re-planned sample,
and the queue, busy and failure journeys its controls. The recorder (`just record-sample lb-07 <sample> --out
<a scratch folder>`) ran against it too, for two samples (a real run starts `queued`, where the mock's starts
planning when the browser is free); its output, labelled `live` though a fake model made it, was thrown away.

## Decisions worth knowing

- **The test build** is the production build with two differences, both decided at build time by the flag
  `__LB_TEST_BUILD__`: it accepts a fixed stand-in for a Turnstile token, and it shows `mock`
  recordings. Production replaces the flag with `false`, so neither is in its bundle; CI checks it
  (`scripts/check-production-build.ts`), and runs the check the other way round on the test build
  (`--expect-test-code`) to prove it can see the code. A check that finds no build to look at fails with
  status 2, never passes. The test build goes to `.output-e2e`, and only a build writes there: the dev
  server is a test build too (`just dev-mock`) and would otherwise empty it. CI cannot see a build made on
  Vercel, so the build refuses to be the test build there: with `VERCEL` set, `LB_TEST_BUILD=1` stops the
  build, and a server built as a test build refuses to start (`shared/build-mode.ts`; tested in
  `test/unit/build-mode.test.ts`, `nuxt-config.test.ts` and `site-config.test.ts`).
- **One address.** With `NUXT_LB_SITE_ORIGIN` set, the server's first middleware (`server/lib/site-middleware.ts`,
  run by `server/middleware/lb-site.ts` and by the test server alike) sends a request for any other host on to
  the same path on that origin with a `308`, before a cookie is read or a page rendered: `www.` and the
  `*.vercel.app` addresses would otherwise each be a site with a session and a quota of their own. It repeats the
  raw request target (h3's `event.path` has its escapes decoded, and `%0d%0a` in it once made a `Location` that
  Node refused), never caches the redirect, and attaches the API's services to `/api` itself as well as `/api/...`
  (the bare `/api` answered 503 for as long as the test server attached them to every path and the real one did
  not). `e2e/hosts.spec.ts` checks both against the real build.
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
- **LB-08's board** ran against the real Node service: its API and its BullMQ worker as processes on a
  scratch Postgres database and a Redis prefix, the real gateway on a scripted provider, the real
  tracer's spans and the test build of the site. Not run there: a real model (every description was
  answered by a script), the real Turnstile, and a recording made on a live back end (the recorder ran
  against the real service once and its output was thrown away).
- **LB-09's board** records with the microphone and plays the audio from the browser. The recorder
  (`app/boards/lb-09/recorder.ts`) asks for the microphone only when the visitor presses record, after
  the panel has said what will happen; it counts down the minute and stops itself; it reads and draws
  the sound level only while recording and not for a visitor who prefers reduced motion; and the audio
  stays in the page (an object URL) until the visitor sends it. A file from the visitor's device is
  checked in the page first (one of the containers the service takes, 3 MiB, a minute by the length
  the browser reads), so a file the service would refuse spends nothing. The visitor's own recording is
  sent with no language: the transcriber hears which, since Whisper told the wrong language writes
  invented words. The player plays the visitor's recording and a sample's file, never anything from
  the back end, which deletes the audio once transcribed; a sample's file is fetched once and played
  from the page's memory (`AudioPlayer.vue`, up to 8 MiB), because the site serves its static files
  without byte ranges and Chrome cannot seek such a file, so a click on an item played from 0:00. Its
  two board pages alone widen the policy, each addition the smallest that works: `connect-src` gains
  the API's WebSocket origin (the grant from `POST /api/tokens/lb-09`, as LB-02's), `media-src` is
  `'self' blob:`, and the `Permissions-Policy` allows `microphone=(self)` (`server/lib/lb09-policy.ts`,
  tested in `e2e/security.spec.ts`; `docs/SECURITY.md`, section 3). The board follows a meeting over the
  socket and, when the socket cannot be opened or drops, reads the meeting every second or two and says
  so; it reads the meeting once more when the transcription is over, for the transcriber, the language
  heard and the length the socket's states leave out. Each stage is said in words, on the page and in
  the live region. The visitor's meetings of the last 24 hours are listed beside the board
  (`MyMeetings.vue`), so a reload or another tab opens one again where it stands, and the day's count
  is read again when a meeting ends, since one the service could not finish gives its place back. When
  the control that held the keyboard's focus gives way (the run button switched off, the recording
  sent), the progress's heading takes the focus, and the result's when it is done. The exports are made
  in the browser from what the page holds (`export.ts` mirrors the service's, formula-safe CSV cells
  included), so a replay exports the same thing a live run does.
- **What ran against the real thing for LB-09.** The board ran in Chromium (with a fake microphone)
  against the real Django service as production runs it: the API under uvicorn with its WebSocket, the
  Celery worker with its beat, Postgres, Redis, the shared audio folder, private mode on faster-whisper's
  base weights, and the real gateway on the real `routing.yaml` with a scripted provider standing in for
  Groq, Workers AI and the chat models. Every sample in both modes, uploads of WAV, WebM, Ogg and MP3,
  the microphone in both modes, the failure paths, hostile recordings, the sweep and the page in both
  languages, both themes and four widths (axe clean) were driven. It found the bugs fixed with the
  jump, the facts, the Scope that gave up on a long meeting, the lost meetings, the forced language and
  the focus. Not run there: a real provider, the real Turnstile, and a recording made on a live back end.
- **LB-08's canvas** (Vue Flow) is a separate chunk, fetched when the canvas view is first shown, which
  a wide screen with a pointer does at once and a phone does not (it starts on the outline). It costs
  about 52 KB gzipped of script and 1.6 KB of style, and nothing else on the page pays for it. It
  needed no change to the policy: the places of the steps are inline styles, which `style-src` already
  allows site-wide, it writes no script, and the Trusted Types list is still `vue lb-turnstile` (the
  end-to-end tests fail on any violation). Two things of its own are set aside because they are wrong
  for this page: its hidden help texts and live message are English (the page's own are in the
  visitor's language), and its global key handlers for Backspace, Space, Control and Shift would stop
  those keys working anywhere on the page while the canvas is open, so they are switched off and
  Delete, Space and the arrow keys are handled on the steps themselves.
- **LB-03's page and its boxes.** The page is a plain `<img>` of the service's own JPEG (a replay's is the sample's
  static page under `public/lb03/pages`), and over it an SVG whose view box is the page itself, 0 to 1 on both sides:
  a box is four corners as shares of the page, drawn as a polygon, so it follows the picture at any size and a
  crooked box of a photograph stays crooked. The service's boxes are as tight as the words, so each is drawn a small
  margin outside them (the same number of pixels above as beside, whatever the picture's shape), or the outline would
  lie on the letters. How sure the reader is of a box is said in words and a percentage and drawn with its own kind of
  line (solid, dashed, dotted) and a three-segment meter, never colour alone. The picture is white paper in both
  themes, so the marks on it use their own tokens (`--lb-page-line`, `--lb-page-ink`, `--lb-page-marker`, the same in
  both themes); the dark theme's near-white ink vanishes on it. The overlay is a convenience for a pointer and is
  hidden from assistive technology: the table of fields does everything it does, from the keyboard. The page also
  opens at full size in a tab of its own, since at the width of a column an invoice's print is too small to read.
  A document that failed after its pages were read still shows its page, with no box and a caption that says why.
- **LB-03's wait is told, not decorated.** The service gives a state, the place in the queue and nothing else, so the
  board shows the stages it has, the place in the line, and a clock, and never a percentage it would have to make up.
  It polls once a second, says when a reading is slow, and stops waiting after 300 seconds (the service ends every
  reading with a result or a reason, within 240). The run is named only when it is over, so the Scope waits and then
  fills in, as for LB-01.
- **LB-03's file goes in through the typed client** (`apiClients().flask.POST(...)` with a `bodySerializer` that hands
  the `FormData` on), after checks the board makes for the visitor's sake and the server makes again (4 MiB, the four
  kinds, no SVG, not empty). A correction is live only: a replay's fields are read-only, since a correction is a write.
  The documents of the hour are the visitor's shelf, from `GET /api/lb03/documents`, and deleting one is theirs.
- **What ran against the real thing for LB-03.** The board ran against the real Flask service as production runs it
  (the real OCR cage, Postgres, Redis, files on disk and its own sweep), behind the real gateway on the real routing
  table, with the test build of the site and a browser (see "Against the real services"); the providers were a script.
  Not run: a real model (so the extraction's accuracy and the injection classifier's hit rate are unmeasured), the real
  Turnstile, a recording made on a live back end (the three recordings in `e2e/fixtures` are the mock's and say so),
  R2, and the box's own two ARM cores (the timings are from this machine's four x86 cores).
- **LB-04's citations** are `{ page, start, end }`: characters of one page's text, and that text is made
  by one function (`extractPageText` in `@lb/contracts`) that both readers call. The server's pdf.js (the
  legacy build, in a worker thread with a deadline and a memory limit) reads a page for the check of every
  quote; the browser's (the modern build, in a module worker) reads it again for the viewer. Before the
  viewer draws a single box it compares the two readings of each page, and where they differ it leaves the
  highlight off, says which pages, and still shows the passage as text. `e2e/lb04.spec.ts` checks in a real
  browser that they agree on every sample the system can review (11, 11, 6 and 30 pages), that a highlight
  lies over the ink of the cited words and over nothing else, and that the same holds for a PDF the visitor
  chose, which the board keeps in the browser when it sends the file, so the viewer never fetches it back.
- **LB-04's viewer** is a separate chunk: pdf.js (435 KB, 129 KB gzipped) and its worker file (1.27 MB,
  375 KB gzipped) are fetched when a visitor first asks for the contract's pages and from the site's own
  origin, and the build leaves the chunk out of the page's prefetch hints (`nuxt.config.ts`), so a visitor
  who only reads the report pays for neither. It needs the policy to change in two places, on the board's
  two pages only: a Trusted Types policy, `lb-pdf-worker`, that makes the worker file's address and refuses
  every other, and `worker-src 'self'` (`server/lib/lb04-csp.ts`, `docs/SECURITY.md`). pdf.js 6 evaluates
  no code, so nothing else was needed, and the journeys fail on any violation. The page is drawn on a
  canvas on `--lb-paper`, a token that is white in both themes because a PDF is drawn for white paper.
  Drawings on one canvas are made one after another (`pdf/engine.ts`): pdf.js refuses a second render on a
  canvas the first has not let go of, which the first run in a browser found as a viewer that read every
  page and drew none.
- **LB-04's radar** is made by code from the report's scores (`radar.ts`, no chart library): nine axes, a
  ring for each severity, a polygon through the worst verified finding of each topic, and a title and
  description for assistive technology. The table beside it is its text alternative and its keyboard
  control (a topic's button narrows the findings to that topic), and severity is always a word and pips as
  well as a shape, never colour alone. It sits beside its table only when its own section is wide enough
  (a container query, since the board's column is narrower than the page).
- **LB-04's progress is the service's state**, never a guess: the board polls the contract (quickly for the
  first minute, then more slowly) and marks each step from the last answer. A review takes from a few
  seconds to a minute, so the board counts the wait, offers to stop waiting (the service goes on, the
  contract stays in the visitor's list for an hour) and does not move a step on by itself.
- **LB-04's board ran against the real Node service**: its API and its BullMQ worker as processes on a
  scratch Postgres database and a Redis prefix, the real gateway in front of a provider that answers as
  the golden set's reference reviewer (see "Against the real services"), and the test build of the site.
  The live journeys passed there, as did the whole matrix of PDFs, the real 429 at the fourth contract
  (with `Retry-After` and `resets_at`), the tenth file and the eleventh's refusal, an encrypted, a
  restricted, an XFA, an embedded-file, a page-attachment and a not-a-PDF file (each with its own words),
  a model that was down (three attempts, then "the model could not be reached" and the place given back,
  with the Scope showing the three failed attempts), and models slow enough to show every state. It found
  nothing wrong in the board. It did show that the mock moves a review on one state for every read, which a
  real review with instant models does not: the journey that follows each state needs models that take
  seconds to pass there. The recorder ran against it too; its output, labelled `live` though a fake model
  made it, was thrown away. Not run: a real model, a real Turnstile site key and challenge, a recording made
  on a live back end, and the site on Vercel, where a function's request body is limited (4.5 MB, as
  documented) above the proxy's 3 MiB for a PDF of 2 MB sent as base64.
- **LB-06's incident is its log.** The board keeps the events of the incident and works the rest out of them
  (`incident.ts`): the state is the newest event that changes it, the proposal that waits is the newest
  `proposal.made` nobody has answered, the model calls spent are the most any step says it had spent, and the
  charts are the `tick` events. The service's own view of the incident (the cost, the guard's verdict, whether the
  answers were cached) is read again a moment after the events that change it, and the larger of the two counts
  wins, so the numbers never run behind the log. The log is capped (`LB06_LIMITS.maxEvents`) and merged by event
  number, so an event that arrives twice, over the socket and by a poll, is drawn once.
- **LB-06's feed is a WebSocket with a polling fallback.** The visitor's pass for it is fetched from the site
  (`/api/tokens/lb-06`, five minutes, LB-06 only) and sent in the first frame, never in the address. The socket
  reconnects with backoff and asks for the events after the last it holds. A network that blocks WebSockets, or a
  socket that cannot be kept open, turns into reading the log's pages every second and a half, and says so
  ("Polling the log"); nothing else about the board changes.
- **The visitor's click is the only way to change the shop.** The card that waits shows the proposal in words,
  why, and what it touches; Approve and Reject send the id of the proposal that waits, and the service refuses an
  answer to one that is gone (409), so a stale tab cannot approve a proposal it has not seen. A replay has no
  buttons and says there is nobody to ask. Rejecting sends the agents back to work, up to three proposals in all.
- **The charts are SVG drawn by code** (`series.ts`, `ServiceChart.vue`, no chart library) and say everything in
  words as well: the service's state is a word with an icon, a failing service has a heavier frame, the landmarks
  are letters on dashed lines (staggered over three rows, since the fault, the alert and the agents' start are
  within three minutes of each other, and turned to the left near the right edge so none is cut off), and each
  chart has a title and a description that give the start, the peak and the present value. Every number is also
  offered as a table for the metric chosen.
- **The Scope looks again at the end.** The incident's root span is written after the incident ends, and an
  incident that reuses an earlier run's answers writes nothing before it; so when the incident ends, a Scope that
  had stopped looking (nothing found, stalled, failed) looks again for six seconds, keeping what it has.
- **A cached incident spent no model call**, whatever its steps say: they are replayed stamped with the contract's
  smallest step and no call, so the board counts calls only once a step says one was made.
- **An incident the agents could not run gives the day's incident back**, in the service and in the mock, and the
  board counts it again; one ended early, or at the step cap, stays spent. Abandoned incidents (a visitor who
  closes the tab at the approval) hold one of the eight places the demo runs at once until the incident's
  eight minutes are over.
- **LB-06's board ran against the real Node service** (see "Against the real services"). Not run: a real model
  (so how often real agents find the cause, and what they propose after a rejection, are unmeasured: the reference
  agents propose the same fix again), a real Turnstile site key and challenge, a recording made on a live back end
  (the two in `e2e/fixtures` are the mock's and say so), and the box's two ARM cores.
- **LB-07's screenshots come from a picture route of the site's own** (`server/handlers/lb07-evidence-image.ts`).
  The service answers a screenshot as base64 in JSON; the route reads it with the same authenticated call the proxy
  makes (the visitor's token, so a run of someone else's is a 404), checks the PNG signature and the size (at most
  400 kB, the contract's), and answers the bytes as `image/png` with `nosniff` and `no-store`. A plain
  `<img src>` to the site's own path is enough, so the page's policy is unchanged. A replay's screenshots are in
  the recording and are shown as `data:` addresses, which the site's policy already allows (`img-src 'self'
  data:`), once the browser has checked their PNG signature.
- **A run's evidence has no list.** The API gives a piece by its id only (`e1`, `e2`, ... in the order the run
  kept them), so the board shows the screenshots the findings name through the picture route without reading
  them first, then reads the two ids after them (the screenshot at the end and the page's tree, the order the
  service keeps them in) as JSON, and stops at the first that is not there.
- **LB-07's board follows a run by polling**: one read at a time, the next after the answer (0.4 s, then 0.9 s
  while the run moves, 2.5 s while other runs are ahead of it in the queue, 3 s after 120 reads), and none once
  it has ended or the visitor has left. A read that comes back after a newer one is dropped, and an ended run is
  never turned back into a running one. The board stops waiting after the longest a full queue could take and
  says so; the run stays in the visitor's runs of the hour, which open it again after a reload.
- **The mock plans one curated run wrong on purpose.** `cart-count`'s first plan names a button the shop does not
  have ("Add to basket", the mistake of the golden set's re-plan case), so a curated run shows a re-plan on the
  mock and in the fixtures; the real service with a correct model plans it right. The mock's other differences:
  a run is worked out whole when it starts (with the service's own finding ledger, verdict and test generator)
  and shown as far as the clock has got, its screenshots are tiny synthetic PNGs, its page's tree is made from a
  model of the shop, and a test can end a run with any of the service's failure codes, `goal_refused` and
  `plan_refused` included, which the service does not produce today (the board has words for both all the same).
- **The second engine is Chromium wearing Firefox's user agent**, and the board says so under its introduction and
  under the verdict's table, so "red in the second engine" is never read as a Firefox result. The table shows the
  three passes as the service ran them: the second engine's pass is red when a step of the test failed there,
  even when the finding behind it was made in Chromium already (its count of bug findings is then 0).
- **LB-07's board ran against the real Node service** (see "Against the real services"): the API, the worker and
  the sandbox with a real Chromium and the real staging shop, the real gateway in front of a provider that plans
  as the golden set does. Not run: a real model (so how well a real planner writes plans and re-plans is
  unmeasured), a real Turnstile site key and challenge, a recording made on a live back end (the three in
  `e2e/fixtures` are the mock's and say so), a run that uses its three minutes of browser time on the real
  service, and the box's two ARM cores.
