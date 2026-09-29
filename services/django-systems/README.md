# Django systems · LB-01 Support Desk Agent

One Django project for the systems that suit Django best: LB-01 Support Desk Agent
today, then LB-02 Booking Concierge and LB-09 Meeting Recorder. Each system keeps its
data in a Postgres schema of its own and calls models only through the AI gateway.

LB-01 triages a customer's ticket, drafts a reply in which every sentence cites a
policy passage or an order record, and hands the draft to a person to approve, edit or
escalate. Why it is built this way: [`docs/STACK.md`](../../docs/STACK.md), Django
systems. Platform security: [`docs/SECURITY.md`](../../docs/SECURITY.md).

## At a glance

| Parameter | Value |
|---|---|
| API | Django Ninja under `/api/`: LB-01 at `/api/lb01/`, plus `/api/healthz` (liveness) and `/api/readyz` (each system's schema). Schema: [`openapi.json`](openapi.json) |
| Callers | The site's server, with an Ed25519 visitor token scoped to one system and valid 5 minutes at most ([`core/visitors.py`](core/visitors.py)) |
| Worker | Celery on Redis: the ticket pipeline, a sweep of tickets past 24 hours, a nightly reseed |
| Data | PostgreSQL 17 with pgvector: one schema per system (`lb01`), extensions in `extensions` |
| Model calls | Through the gateway only, with [`lb-common`](../../python/lb-common/README.md), each labelled with its ticket's run |
| Runtime | Python 3.13, Django 5.2 LTS, uvicorn |

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

## The API

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

Errors answer `{"error": {"code", "message"}}` and never echo what was sent.

## Data and evals

| What | Where | Command |
|---|---|---|
| Policies (30 passages, English and Czech), customers and orders | [`data/seed/lb01`](../../data/seed/lb01) | `just seed` checks every file, then syncs the tables. Order dates are relative, so a demo never goes stale |
| Recorded vectors for the corpus and the golden set | `data/seed/lb01/embeddings.json`, `evals/lb01/query-embeddings.json` | `just embed`, once a Workers AI key is set; commit both files |
| Golden set: 49 tickets in English and Czech, with expected outcomes | [`evals/lb01/golden.yaml`](../../evals/lb01/golden.yaml) | `just eval-lb01` runs the live pipeline and grades it by rules |
| Search recall gate | [`evals/lb01/search-baseline.yaml`](../../evals/lb01/search-baseline.yaml) | `just eval-search`; CI fails below the gate |

Search recall today, keyword search only: 1.000 at 4 when searching by the classifier's
English query, 0.441 when searching by the customer's own words, and 0 of 14 Czech
tickets. The hybrid numbers join the gate once `just embed` has recorded the vectors.

## Running it locally

```sh
docker run -d --name lb-postgres -e POSTGRES_USER=lb -e POSTGRES_PASSWORD=lb \
  -p 127.0.0.1:5432:5432 pgvector/pgvector:pg17
cp services/django-systems/.env.example services/django-systems/.env   # then fill it in
just migrate && just seed
just django     # the API on http://127.0.0.1:8001
just worker     # the pipeline, the sweep and the reseed
```

The pipeline needs the gateway (`just gateway`) with provider keys, and the service key
pair from `just gateway-token keygen django-systems <key-file>`.

## Tests

`just test` runs them with the rest of the monorepo; from this folder, `uv run pytest`.
Unit tests need nothing. Integration tests need Postgres with pgvector: Testcontainers
starts one, or set `LB_TEST_DATABASE_URL` to use a running server whose user may create
databases. The gateway is replaced by fakes, so no test spends quota.

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
- **Denial of service.** 20 tickets per visitor a day; the gateway caps calls per run
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
- The daily ticket limit is counted when a ticket is filed, so simultaneous requests
  can pass it by a few; the gateway's call quotas are the hard limit.
- Until the vectors are recorded, search runs on keywords, and Czech tickets depend on
  the classifier's English query.
