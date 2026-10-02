# Django systems · LB-01 Support Desk Agent and LB-02 Booking Concierge

One Django project for the systems that suit Django best: LB-01 Support Desk Agent and
LB-02 Booking Concierge today, then LB-09 Meeting Recorder. Each system keeps its data in
a Postgres schema of its own and calls models only through the AI gateway.

LB-01 triages a customer's ticket, drafts a reply in which every sentence cites a
policy passage or an order record, and hands the draft to a person to approve, edit or
escalate. LB-02 books tastings, cupping sessions and roasting workshops in a chat, in
English, Czech or another language, on a real calendar, and cannot double-book it: the
database refuses an overlapping reservation whatever the model does. This is its back
end; the page that uses it, the phone-frame PWA, isn't built yet. Why it is built this
way: [`docs/STACK.md`](../../docs/STACK.md), Django systems. Platform security:
[`docs/SECURITY.md`](../../docs/SECURITY.md).

## At a glance

| Parameter | Value |
|---|---|
| API | Django Ninja under `/api/`: LB-01 at `/api/lb01/`, LB-02 at `/api/lb02/`, plus `/api/healthz` (liveness) and `/api/readyz` (each system's schema). Schema: [`openapi.json`](openapi.json) |
| WebSocket | LB-02's conversation at `/ws/lb02/`, on Django Channels 4 with a Redis channel layer (keys under `lb:channels:`). The visitor token travels in the first frame, never in the address |
| Callers | The site's server, with an Ed25519 visitor token scoped to one system and valid 5 minutes at most ([`core/visitors.py`](core/visitors.py)) |
| Worker | Celery on Redis: LB-01's ticket pipeline, sweep and nightly reseed; LB-02's hold sweep (every minute), 24-hour sweep (every 15 minutes) and nightly calendar reset (03:11 UTC) |
| Data | PostgreSQL 17 with pgvector and btree_gist: one schema per system (`lb01`, `lb02`), extensions in `extensions` |
| Model calls | Through the gateway only, with [`lb-common`](../../python/lb-common/README.md), each labelled with its ticket's run |
| Runtime | Python 3.13, Django 5.2 LTS, uvicorn with `--ws-max-size 8192` |

## LB-01: from a ticket to a cited draft

One ticket is one run. Each step below is a span of the run's trace, and the model
calls behind it nest under it.

| Step | What it does | When it can't |
|---|---|---|
| Redact PII | Replaces emails, phone numbers, card numbers and IBANs with labels before any model reads the ticket ([`lb01/redaction.py`](lb01/redaction.py)) | Never fails: patterns only |
| Screen for injection | `lb-guard` (Prompt Guard 2) checks the redacted ticket | Fails closed: the ticket goes to a person as `unchecked` |
| Classify | `lb-fast` names the category, the order number, any senior agent's matter, and an English search query | Repairs a malformed answer once, then escalates as `pipeline_error` |
| Hybrid search | Postgres full-text search and pgvector, fused by reciprocal rank ([`lb01/search.py`](lb01/search.py)) | Without a query vector, keywords alone |
| Rerank | `lb-rerank` orders the finalists by relevance | Keeps the fused order and claims no relevance |
| Look up order | Finds the order on the ticket's own customer only, without a model ([`lb01/orders.py`](lb01/orders.py)) | Another customer's order reads exactly like a missing one |
| Draft with citations | `lb-tools` writes the reply sentence by sentence, each with its sources, in the ticket's language | Repairs once, then escalates; says so when the sources don't answer |
| Check claims | Every cited source must be one the drafter was given, and every number must appear in it ([`lb01/claims.py`](lb01/claims.py)) | Marks the failing sentences for the person who approves |
| Route | Leaves the draft for approval, or hands the ticket over with a reason | |

A ticket costs an injection check, a query embedding, a rerank and two chat calls, plus
a third when an answer needs its repair. Escalation reasons: `injection`, `unchecked`,
`senior_agent` (a legal claim, an allergy, fraud or personal data), `no_policy`,
`pipeline_error`. Nothing is sent without a person: auto-send is off for visitors.

## LB-02: from a message to a booking

A conversation is one run of up to 30 visitor messages, and each message is a span of
it. The run's root span (`booking conversation`, a `system.run` span with no parent and
only counts and a reason in it) is written once, when the conversation is handed to a
person, so the trace route says `finished` then and not before; the turns name that root
as their parent in advance, so the Scope shows them under it once it arrives. A booked
conversation is still open (the visitor may write again), so it has no root, and a message
to a conversation that is over writes no span, no transcript line and no copy of the
handoff, so such a client cannot make any of them grow. A booking takes three messages and 7 gateway calls in the offline eval: an injection
check for each message and four calls to `lb-tools`. That is what scripted models cost;
the datasheet's "6 to 10" stays an estimate until `just eval-lb02` has run live.

| Step | What it does | When it can't |
|---|---|---|
| Mask | Replaces email addresses with `[email]` and runs of 9 or more digits with `[number]`, and drops control characters ([`lb02/privacy.py`](lb02/privacy.py)). The code, never a model, keeps the first example address (`example.com`, `.test` and the other reserved domains) | Never fails: patterns only. A real address is counted and refused, never kept |
| Count | Adds the message to the conversation's 30 in one statement that refuses the 31st; the table also refuses a count above 30 | The 31st message hands the conversation to a person, with the whole transcript |
| Detect the language | Reads the script, the stop words and the letters ([`lb02/languages.py`](lb02/languages.py)): ten Latin-script languages and nine other scripts, and a switch mid-conversation | A first message the code can't read costs one `lb-fast` call; if that fails, English |
| Screen | `lb-guard` reads every message before any model that can call a tool does | A flagged message is refused with no model call, and the third hands over; one that can't be checked is asked again, and the second hands over: the screen fails closed |
| Refresh | Marks the conversation's own run-out hold expired and searches again, so the slots on offer are free now; a slot that stays keeps its number, and the model is told which numbers have gone | Never fails |
| Converse | `lb-tools` with only the tools the step allows, at most 3 chat calls a message and 3 tool calls a reply | An empty answer asks the visitor to repeat; twice in a row, or a spent quota, hands over |
| Run each tool | The step must accept the tool, and its arguments must pass a strict Pydantic model that forbids extra fields ([`lb02/tools.py`](lb02/tools.py)) | A refused or invalid call changes nothing, and the model is told which field was wrong, never its own text |
| Answer | A hold, a confirmation, a taken slot and a run-out hold are written by the code from the database's facts, in English and Czech, so they cost no second call; other languages get the model's words | The model's own words are never trusted to state a booking: see the known gaps |

The booking rules, each enforced below the model:

- **The database refuses a double booking.** `lb02_no_double_booking` is an exclusion
  constraint on a reservation's room and its time range, for held and booked rows, and it
  needs `btree_gist`, which the first migration installs in `extensions` (and checks it
  landed there). A room is shared by the offerings in it, so the 11:30 cupping and the
  12:00 tasting exclude each other. Tests race eight transactions for one slot, and two
  transactions that wait on each other inside Postgres; exactly one wins every time.
- **A hold lasts five minutes and expires by being read, not by a sweep.** Every search,
  hold and confirm compares `hold_expires_at` with the clock, placing a hold first marks
  the stale holds of its room expired in the same transaction, and the Celery sweep
  (`lb02.sweep_expired_holds`, every minute) only tidies rows and tells the live
  calendar. A worker that is down for an hour changes nothing a visitor can see.
- **Confirming is idempotent.** The key is made from the booking's code, so a repeated
  confirm returns the same booking; one live hold and one booking per conversation are
  partial unique indexes; the confirmation is a recorded mock, and the table refuses any
  `delivery` but `mock`: nothing is ever sent.
- **The step follows the facts, never the model.** Details, availability, hold, done, or
  handoff, from what is in the database ([`lb02/states.py`](lb02/states.py)). The model
  is offered `confirm_booking` only while the conversation holds a live slot, and it takes
  no arguments, so it can't confirm a slot it never held or one somebody else holds. A hold
  made in a turn can't be confirmed in the same turn: the visitor has to say yes first.
  `hold_slot` takes an option number, never a slot ID.
- **An option number means one slot for the whole conversation.** A slot gets its number the
  first time the conversation is shown it, and keeps it in every tab: when availability
  changes between two messages, the slots that remain keep their numbers, a new slot takes
  the next number, and a number is never reused ([`lb02/offers.py`](lb02/offers.py);
  `Conversation.shown_slots` is the registry, a slot's number its place in it). A number
  whose slot has gone holds nothing else: if someone else has the slot the visitor is told
  it was taken, and if the search merely moved on the model is told what is on offer. Only
  a slot on offer can be held, so an old number can't reach a slot of another offering.
  A conversation can be shown 128 different slots (the 14-day calendar has 112).
- **The calendar resets nightly.** `lb02.reset_calendar` clears what visitors made and lays
  out the next 14 days from the day it runs; a conversation is deleted 24 hours after it
  started.

Limits, all in [`lb02/limits.py`](lb02/limits.py), and checked against the gateway's
quotas in `routing.yaml` by a test:

| Limit | Value |
|---|---|
| Messages in a conversation | 30 (datasheet) |
| Hold | 5 minutes (datasheet) |
| Gateway calls in a conversation | 64: 30 messages at a check and a reply each is 60, plus the language check and a second reply or two; the gateway's cap is 68, so a visitor is handed to a person, never refused halfway |
| Conversations a visitor may start a day | 10 |
| A message | 500 characters; a party of at most 12, and at most what the offering takes |
| A WebSocket frame | 4 KB; a connection has 10 seconds to say hello and 15 minutes of silence |
| Messages one connection has in hand | 2: the one being answered and one waiting behind it; a third is refused with `too_many_pending` |
| Connections one visitor may hold | 4 at a time, in one server process (two tabs, the installed app and one still being torn down); the fifth is refused with `too_many_connections` and closed with 1013 |

## The API

### LB-01

Every route needs a visitor token for `lb-01`, and a visitor reaches only their own
session's tickets.

| Route | What it does |
|---|---|
| `GET /api/lb01/customers` | The synthetic customers a visitor can file a ticket as |
| `POST /api/lb01/tickets` | File a ticket (20 a day per visitor). Answers 202 and queues it for the worker |
| `GET /api/lb01/tickets` | The visitor's tickets, newest first, for the agent console's queue |
| `GET /api/lb01/tickets/{id}` | One ticket in full: the cited draft, each source in the ticket's language, the decision |
| `POST /api/lb01/tickets/{id}/decision` | Approve, edit or escalate a waiting draft, once |
| `GET /api/lb01/stats` | The demo's counters: deflection and accuracy |

### LB-02

Every route needs a visitor token for `lb-02`, and a visitor reaches only their own
session's conversations.

| Route | What it does |
|---|---|
| `GET /api/lb02/offerings` | What can be booked, in English and Czech: duration, capacity, price, room |
| `GET /api/lb02/calendar?from=&days=&conversation=` | A snapshot of up to 14 days: each slot free, held or booked, and `mine` for the named conversation. `as_of` orders it against live changes |
| `GET /api/lb02/conversations` | The visitor's own conversations, newest first |
| `GET /api/lb02/conversations/{id}` | One in full: the transcript, the hold, the booking, the recorded confirmation, the handoff with its transcript. Reading changes nothing |

Errors answer `{"error": {"code", "message"}}` and never echo what was sent.

### LB-02 WebSocket

`/ws/lb02/`, one JSON object to a text frame ([`lb02/events.py`](lb02/events.py) holds the
models; both directions are strict). The first frame must be a hello, within 10 seconds:

```json
{"type": "hello", "token": "<visitor token for lb-02>", "conversation": null}
```

`conversation` names one of the visitor's own to resume, or is null to start a new one.
The token is checked before anything is read, joined or sent. It travels in the frame and
not in the address because addresses end up in proxy and access logs, in history and in
referrers, and a frame is in none of them; a subprotocol header was the other candidate,
and more proxies log headers than message bodies. After that:

| Client sends | Server answers |
|---|---|
| `{"type": "message", "text": "..."}` (1 to 500 characters) | `working`, then `reply`: the text, the `receipt` when the code wrote it, the tools called, the step, language, options, hold, booking, `messages_left`, `model_calls` |
| the hello | `ready`: the conversation, whether it resumed, its whole transcript and state, and `pending` (below) |
| nothing | `calendar`: slots that changed, each `free`, `held` or `booked`, and `mine` for this conversation; `calendar_reset`: load the snapshot again |

Frames are read as they arrive, and a message is not answered where it is read: it joins a
line of two (the one being answered and one behind it) that a worker task of the connection
answers one at a time, so the calendar keeps moving during a long turn and a client that never
waits cannot pile work up in memory. Calendar events may therefore arrive between `working`
and `reply`.

**A turn outlives its connection.** If the network cuts a connection while the concierge is
answering, the turn still ends and its answer is saved in the transcript. A connection that
resumes the conversation meanwhile is told in `ready` that the answer is on its way
(`"pending": true`: the last line of the transcript is the visitor's and a turn of the
conversation is running) and is sent it as a `reply` when the turn ends, or an `error` if
the turn failed, through a channel-layer group of the conversation. One that resumes after the
turn ended finds the answer in the transcript, with `pending` false, and is not sent it again
(each answer carries its place in the transcript, and a connection ignores one it already
holds). Only a connection that is waiting for an answer is sent one: a second, idle tab of the
conversation is not shown a reply to a question it never saw, and catches up when it resumes.
If the server process is lost mid-turn, nothing can send the answer; the resumed page finds
the visitor's message last with `pending` false, and says so.

A frame that isn't in the protocol, or can't be taken, gets an `error` event with a code
(`invalid_frame`, `message_too_long`, `already_said_hello`, `conversation_gone`,
`too_many_conversations`, `unavailable`, and these three:
`turn_failed`, `too_many_pending`, `too_many_connections`) and the connection goes on, except
where the table below closes it.

- `turn_failed`: the turn raised an error nobody planned for. The visitor's message stays in
  the transcript with a note that the concierge could not answer it, the failure counts like a
  model that said nothing (the second in a row hands the conversation to a person, and that
  arrives as a `reply` with the `unavailable` receipt instead), and the conversation, and the
  connection, go on: the visitor can send the message again. The log holds the error's type and
  the conversation's ID, never what the error said, since that may hold anything.
- `too_many_pending`: a third message while two are in hand. It is dropped; nothing is queued.
- `too_many_connections`: the visitor already holds four connections. It is followed by a close
  with 1013 ("try again later"), which a page treats as a drop and retries with a growing wait.

These close the connection, with the code that says why:
4400 (not a hello first, or not JSON), 4401 (the token is missing, malformed, expired,
signed by anyone else or for another system, or there is no key to check it with; nothing
more is said), 4404 (no such conversation of theirs), 4408 (no hello in 10 seconds, or 15
minutes of silence), 4429 (ten conversations today), 1003 (binary), 1009 (over 4 KB), 1011
(the service itself isn't set up) and 1013 (too many connections from this visitor).

## Data and evals

| What | Where | Command |
|---|---|---|
| Policies (30 passages, English and Czech), customers and orders | [`data/seed/lb01`](../../data/seed/lb01) | `just seed` checks every file, then syncs the tables. Order dates are relative, so a demo never goes stale |
| Recorded vectors for the corpus and the golden set | `data/seed/lb01/embeddings.json`, `evals/lb01/query-embeddings.json` | `just embed`, once a Workers AI key is set; commit both files |
| Golden set: 49 tickets in English and Czech, with expected outcomes | [`evals/lb01/golden.yaml`](../../evals/lb01/golden.yaml) | `just eval-lb01` runs the live pipeline and grades it by rules |
| Search recall gate | [`evals/lb01/search-baseline.yaml`](../../evals/lb01/search-baseline.yaml) | `just eval-search`; CI fails below the gate |
| LB-02's rooms, offerings and calendar (3 offerings in 2 rooms, 8 slots a day for 14 days) | [`data/seed/lb02`](../../data/seed/lb02) | `just seed` checks the file, then syncs the tables; dates are relative to the day it runs, and the nightly reset does the same |
| LB-02's golden set: 30 conversations in English, Czech, German and Slovak, written before any prompt | [`evals/lb02/golden.yaml`](../../evals/lb02/golden.yaml) | `just eval-lb02` plays them live as synthetic data and grades them by rules; it fails unless every case passes |

The golden set's grading is tested offline with scripted models: a model that does what a
careful concierge does passes 20 cases, covering every scenario, on the seeded calendar, and
models that get something wrong fail the check that names it. **The live eval has not been
run**, since no provider key was available, so no pass rate, and no measured number of calls
per booking, is claimed anywhere; `just eval-lb02` prints both. No sample runs are recorded
for replay yet either.

Search recall today, keyword search only: 1.000 at 4 when searching by the classifier's
English query, 0.441 when searching by the customer's own words, and 0 of 14 Czech
tickets. The hybrid numbers join the gate once `just embed` has recorded the vectors.

## Running it locally

```sh
docker run -d --name lb-postgres -e POSTGRES_USER=lb -e POSTGRES_PASSWORD=lb \
  -p 127.0.0.1:5432:5432 pgvector/pgvector:pg17
cp services/django-systems/.env.example services/django-systems/.env   # then fill it in
just migrate && just seed
just django     # the API and WebSockets on http://127.0.0.1:8001
just worker     # the pipelines, the sweeps, the reseed and the calendar reset
```

LB-02's channel layer needs the Redis from `LB_REDIS_URL`. The pipeline and the concierge
need the gateway (`just gateway`) with provider keys, and the service key pair from
`just gateway-token keygen django-systems <key-file>`.

## Tests

`just test` runs them with the rest of the monorepo; from this folder, `uv run pytest`.
Unit tests need nothing. Integration tests need Postgres with pgvector and Redis:
Testcontainers starts them, or set `LB_TEST_DATABASE_URL` and `LB_TEST_REDIS_URL` to use
running servers (the Postgres user may create databases). The gateway is replaced by fakes,
so no test spends quota. The WebSocket tests are `async` (pytest-asyncio) and drive the real
ASGI application with Channels' `WebsocketCommunicator`; they commit for real, because a
turn runs on a worker thread with a connection of its own, as do the concurrency tests,
which race threads against one Postgres.

## LB-01 threat model

Short notes, as the playbook asks (step 8).

- **Spoofing.** Visitors have no accounts. The API trusts only tokens the site signed
  for `lb-01`, at most 5 minutes old, and knows the visitor only by their session hash;
  without the site's public key it refuses everyone.
- **Tampering.** A ticket is data, never instructions: it sits between markers in the
  user message, it can't close them, and it is screened for injection first. Model
  answers must match their Pydantic schemas. The order tool takes no input from the
  model beyond an order number the ticket itself names.
- **Data exposure.** Personal data is redacted before a model reads a ticket. Another
  customer's order, and another visitor's ticket, are indistinguishable from missing
  ones. Spans hold labels and counts, never a visitor's words. Tickets are deleted 24
  hours after filing.
- **Denial of service.** 20 tickets per visitor a day, counted under a per-visitor lock so that
  simultaneous requests cannot pass it; the gateway caps calls per run
  (7), per visitor (140 a day) and for LB-01 (350 a day). Tickets are capped at 2,000
  characters in the API and in the database, and search reads at most 64 words.
- **Privilege escalation.** No draft is sent without a person. The claim check marks
  any sentence its sources don't support, including an uncited promise of a refund,
  a replacement or a delivery. LB-01's connection searches only its own schema, and in
  production logs in as a role granted nothing else (`LB01_DATABASE_URL`).

Known gaps, measured or stated rather than hidden:

- Prompt Guard 2 isn't trained on Czech, so a Czech injection may pass the screen; the
  golden case `injection-czech` measures it, and the claim check and the person who
  approves still stand behind it.
- Names and street addresses aren't redacted: no pattern finds them reliably. Only
  providers that never train on inputs read visitor tickets.
- Until the vectors are recorded, search runs on keywords, and Czech tickets depend on
  the classifier's English query.

## LB-02 threat model

Short notes, as the playbook asks (step 8).

- **Spoofing.** Visitors have no accounts. The only thing the WebSocket accepts before a
  token has been checked is a hello within 10 seconds; the token must be signed by the
  site for `lb-02` and at most 5 minutes old, and without the site's public key nobody is
  let in. It is read from the first frame, never the address, so it isn't logged. A
  conversation's ID is 16 random characters and also needs the visitor's own session: any
  other visitor's is indistinguishable from none. There is no Origin check, on purpose:
  the connection carries no cookie or other ambient credential, so a page on another site
  can't speak as a visitor, only with a token it already holds.
- **Tampering.** The model is untrusted. What it calls must be a tool the step offers and
  pass a strict schema; it names an offered option, never a slot; it can't confirm what it
  didn't hold or confirm in the turn it held; the database refuses overlapping reservations
  and a second booking, and a repeated confirm is a replay. A visitor's words are data in
  the user message, screened first. Receipts are written from the database's rows.
- **Data exposure.** Synthetic data only. Email addresses and long digit runs are masked
  before any model or the transcript sees them, and only reserved example addresses are
  kept; spans hold labels and counts, never a visitor's words. Calendar events say whether
  a slot is free, held or booked and whether it is this conversation's, never whose
  otherwise. The confirmation is a record, never sent. Conversations, holds and bookings
  are deleted 24 hours after they started.
- **Denial of service.** 30 messages and 64 gateway calls a conversation, counted by the
  database in one statement each; 10 conversations a visitor a day, counted under the same
  per-visitor lock as LB-01's tickets (`core/locks.py`); 500 characters a
  message and 4 KB a frame; two messages in hand per connection, with the rest refused
  rather than queued; four connections per visitor in a process; one turn at a time per
  conversation; 10 seconds to say hello, 15 minutes of silence; at most 3 chat calls a message. The gateway
  adds 68 calls a run, 128 a visitor a day and 425 a day. Each turn holds a worker thread
  while the model answers, so the thread pool bounds concurrent turns.
- **Privilege escalation.** Six tools, gated by step; none reads another conversation, sends
  anything or reaches outside the conversation's own rows. A handoff only records. The
  service's connection searches only its own schema and, in production, logs in as a role
  granted nothing else (`LB02_DATABASE_URL`); provider keys live only in the gateway.

Known gaps, stated rather than hidden:

- The model's own words aren't verified. It could say a slot is booked when it isn't; the
  authoritative state travels in the structured fields (`step`, `hold`, `booking`) and in
  the code-written receipts, which the page should show, but in a language other than
  English or Czech the model writes the answer to a hold or a confirmation.
- Prompt Guard 2 isn't trained on Czech or Slovak, so an injection in those may pass the
  screen; the golden cases `injection-cs` and the rest measure it live, and the state
  machine and the database stand behind it.
- Masking finds addresses and numbers by pattern. An obfuscated one ("tom at gmail dot
  com") isn't found, so it reaches the model and stays in the transcript until the 24 hours
  are up.
- Two tabs of one conversation take turns only within one server process. With several
  workers their turns can overlap; the limits, the constraint and the idempotent confirm
  still hold, but the transcript's order of lines is then whichever got there first. The
  cap on a visitor's connections is also kept per process, so with several workers a visitor
  can hold the cap on each, and `pending` is known only to the process running the turn (a
  page resumed on another process still gets the answer, but is not told it is on its way).
- A turn that is lost with its process (a restart in the middle of one) is not recovered:
  the visitor's message stays in the transcript without an answer, and the page says so on
  resume. The caps on messages and connections are in memory, so they start again from zero
  when the process does.
- Calendar events are best effort: if Redis is down, a committed booking stays committed and
  the next snapshot is right, but a tab misses the live change. A client should load the
  snapshot again after it reconnects.
- Not run live: the golden eval, the measured calls per booking, and recorded samples.

## Operating notes for LB-02

- `btree_gist` goes in the `extensions` schema. The first migration runs
  `CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA extensions` (a trusted extension) and
  raises if it finds the extension anywhere else. The role needs `USAGE` on `extensions`
  and its own schema, `lb02`, and that is all (`LB02_DATABASE_URL`, optional).
- The channel layer writes under `lb:channels:*` in Redis, and Celery under its own prefix;
  the Django service's Redis role needs both, and the commands the layer uses to send to a
  group, which include `EVALSHA`.
- Run uvicorn with `--ws-max-size 8192` (the `just django` recipe does): the server library
  reads a whole frame before the consumer can refuse it.
- The site opens the WebSocket on the API domain, as a Vercel function can't hold one, and
  sends the visitor token as its first frame.
