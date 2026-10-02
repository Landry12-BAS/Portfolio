# LB-00 · AI gateway

The one door for every model call on the platform. Systems ask for a capability alias
such as `lb-tools`; the gateway picks the provider, enforces the free-tier budgets and
each visitor's quota, falls back when a provider fails, and records a span for every
attempt. Services never hold a provider key.

Why it is built this way: [`docs/STACK.md`](../../docs/STACK.md), AI providers and
routing. Threat model: [`docs/SECURITY.md`](../../docs/SECURITY.md), sections 4 and 5.

## At a glance

| Parameter | Value |
|---|---|
| API | OpenAI-compatible: `POST /v1/chat/completions` (JSON or SSE), `POST /v1/embeddings`, `GET /v1/models`. The gateway's own: `POST /v1/rerank`, `POST /v1/guard` |
| Operations | `GET /v1/usage`, `GET /healthz` (liveness), `GET /readyz` (Redis and providers). The Scope's route: `GET /v1/runs/{runId}/spans` (a run's trace, for the site's server only) |
| Providers | Groq, Cloudflare Workers AI, OpenRouter; NVIDIA in the `dev` profile only |
| Aliases | `lb-fast`, `lb-tools`, `lb-reason`, `lb-long`, `lb-vision`, `lb-judge`, `lb-embed`, `lb-rerank`, `lb-guard` |
| Routing table | [`routing.yaml`](routing.yaml), validated in CI by `pnpm check` |
| Callers | Services with an Ed25519-signed token, 10 minutes at most |
| State | Redis: budgets and quotas (atomic Lua), run spans (streams) |
| Runtime | Node 24, Fastify 5, TypeScript run directly by Node's type stripping |

## Calling it

Any OpenAI client works. Point it at `http://gateway:8080/v1`, send the service token
as the API key, and add the call headers:

| Header | Required | Meaning |
|---|---|---|
| `Authorization: Bearer <token>` | Yes | The calling service's signed token |
| `x-lb-system` | Yes | The system the call is for, such as `lb-01`. It must belong to the calling service |
| `x-lb-run-id` | Yes | The visitor's run, 8 to 64 characters. Spans and the per-run cap hang off it |
| `x-lb-data-class` | No | `visitor` (the default) or `synthetic`. Visitor content only reaches providers that don't train on inputs |
| `x-lb-session` | For visitor calls | An opaque, hashed visitor ID (never the raw cookie), for the visitor's daily quota |
| `x-lb-parent-span` | No | The system's own span for this step, so the Scope can nest the call under it |

The AI SDK in a Node system, with a freshly minted token per run:

```ts
const gateway = createOpenAICompatible({
  name: 'lb-gateway',
  baseURL: 'http://gateway:8080/v1',
  apiKey: token,
  headers: { 'x-lb-system': 'lb-04', 'x-lb-run-id': runId, 'x-lb-session': session },
  includeUsage: true,
})
const { text } = await generateText({ model: gateway('lb-tools'), prompt })
```

A Python system uses `lb-common` ([`python/lb-common`](../../python/lb-common/README.md)),
which signs the tokens and adds the call headers for the current run:

```python
gateway = Gateway.from_env()  # LB_GATEWAY_URL, LB_SERVICE_NAME, LB_SERVICE_KEY_FILE
with run_scope(Run(system="lb-01", run_id=new_run_id(), session=session_key)):
    verdict = gateway.guard(ticket_text)
    reply = gateway.openai.chat.completions.create(model="lb-fast", messages=messages)
```

Responses carry `x-lb-provider`, `x-lb-model` (for example `groq/gpt-oss-120b`),
`x-lb-attempts` and `x-lb-span-id`.

## Reranking and the guard

Two endpoints have no OpenAI equivalent, so the gateway defines them and maps them to
each provider.

**`POST /v1/rerank`** takes `{"model": "lb-rerank", "query": "…", "documents": ["…"],
"top_n": 5}` (1 to 64 documents) and answers `{"object": "list", "model": "lb-rerank",
"results": [{"index": 2, "relevance_score": 0.91}, …]}`, best first.

- Workers AI scores every document on its own `/ai/run` endpoint. The gateway checks
  that the answer covers each document exactly once, maps the reranker's logits to 0
  to 1, sorts (ties keep the request's order) and cuts to `top_n`.
- Each document must fit the reranker together with the query (`maxInputTokens` is
  per pair). A longer one gets 413, since the reranker would quietly read only its
  opening.
- The reranker reads English and Chinese, so rerank in English.

**`POST /v1/guard`** takes `{"model": "lb-guard", "input": "…"}` and answers
`{"object": "guard.verdict", "model": "lb-guard", "flagged": false, "score": 0.0003,
"threshold": 0.9, "segments": 1}`.

- `score` is the highest injection probability found anywhere in the text, and
  `flagged` means it reached the alias's threshold.
- Prompt Guard 2 reads 512 tokens at a time and may cut the rest without saying so.
  The gateway reads the text in overlapping segments of 480 characters, sized for the
  worst case of one token per character, and sends each to the same model. The check
  counts once against the run's quotas, and each segment counts as one provider
  request.
- It fails closed. Groq doesn't document the classifier's answer, so only a
  probability or a `BENIGN` / `MALICIOUS` label is accepted, and an answer that filled
  the whole window is refused. When no model gives a readable verdict, the call fails
  (502, 503 or 504), and the caller must treat the text as unchecked: skip the steps
  that can call tools, or serve a replay.

## Reading a run's trace

`GET /v1/runs/{runId}/spans` is what the site's server reads for the Scope: one run's spans
from its Redis stream (`<prefix>run:<runId>:spans`), as metadata-only JSON, in the order
they were written. The site hands them to the visitor's browser, which polls it while a
run is live and opens it again for a permalink. `infra/caddy/Caddyfile` lets exactly this
path through, as a `GET`, and nothing else under `/v1`.

```sh
curl -H "authorization: Bearer $WEB_TOKEN" "localhost:8080/v1/runs/run-0123456789/spans?limit=100&after=1790000000123-0"
```

```json
{
  "runId": "run-0123456789",
  "spans": [{ "v": 1, "runId": "run-0123456789", "system": "lb-01", "spanId": "9c1f...", "kind": "gateway.call", "name": "lb-fast", "status": "ok", "startMs": 1790000000123, "endMs": 1790000000610, "attrs": { "alias": "lb-fast", "attempts": 1 } }],
  "cursor": "1790000000611-0",
  "more": false,
  "finished": false
}
```

| Field | Meaning |
|---|---|
| `spans` | Up to `limit` spans (1 to 500, default 200) written after `after`, oldest first. A parent is written after its children, because a span is written when it ends |
| `cursor` | The ID of the last entry looked at. Send it back as `after` to poll a live run: the next page holds only what was written since, and an empty page returns the same cursor |
| `more` | Spans were already waiting beyond this page, or the page hit its byte budget (256 KB). Ask again at once |
| `finished` | The run's root span has been written: a `system.run` span with no parent, which a system writes last. It stays `true` for a client that is already past the root. A run that goes on in turns writes its root when it ends: LB-02's conversation (one run, a span for every message) writes it when it is handed to a person, so it finishes then, and a booked conversation that is still open does not. A run with no root span, such as LB-08's step spans, never finishes, so the client decides when to stop |

- **Who may call it.** Only a service listed under `traceReaders` in `routing.yaml`
  (`web`, the site's server). Any other valid service token gets `403 permission_denied`,
  so a service that makes model calls can't read traces by accident. A reader owns no
  system, so every model route answers it `system_not_allowed`: it can read traces and
  can't call a model. `pnpm check` fails when a reader owns a system or names one that
  isn't listed. The reader may read only the systems it lists (`web`: LB-01, LB-02, LB-05,
  LB-08), and a run of any other system answers like a run that isn't there.
- **Unknown runs.** A run ID is 8 to 64 letters, digits, `_` or `-`. A run that has no
  stream answers `404 run_not_found`: it never existed, its 24 hours are up, or it
  belongs to a system the reader can't see, and the three read the same. A run that
  hasn't written its first span yet is also unknown, so a client that has just started a
  run keeps asking for a few seconds before it believes the 404.
- **Metadata only.** Spans carry names, timings, models, token counts and scores. The
  route reads each stream entry with a strict schema ([`src/spans.ts`](src/spans.ts)): no
  unknown field, details that are short labels (200 characters), numbers or flags, at most
  64 of them, and at most 8 KB a span. An entry that doesn't fit is passed over, and the
  cursor moves past it. The schema checks the shape and the size, not the meaning:
  keeping a visitor's words out of a span is the writers' rule (`lb-common`'s tracers
  record an error's name, never its message), and a test reads real spans, written by the
  gateway and by `@lb/common`'s tracer around calls whose prompts and answers carry marker
  words, and finds none of them.
- **Bounded.** At most 500 spans and 256 KB a response, and a stream holds at most about
  1,000 spans. The route reads with `XRANGE` and `XREVRANGE` on the one run's key and
  nothing else, which the gateway's Redis user may do there (`infra/redis/users.acl.tmpl`).
  Without Redis the route answers `503 gateway_unavailable` and says nothing about why.
- **How often.** A full page costs about 10 ms of CPU and the route needs no visitor behind
  it, so each run's reads are counted before anything is read ([`src/read-limit.ts`](src/read-limit.ts)):
  a burst of 20 reads of one run is let through, and 5 more come back every second. A read
  past that is `429 rate_limited` with `Retry-After`, whatever page it asks for. The count is in
  the gateway's memory (it is one process, and nothing has to survive a restart), for at most
  5,000 runs at a time; a request refused for another reason (the service, the run ID, the query)
  is not counted. A Scope polls about twice a second, so a client that follows a run never meets it.

## How a call is routed

1. **Check.** The token, the headers and the body are validated. Unknown fields are
   dropped rather than forwarded (`n`, `user`, `logit_bias`), images must be inline
   data URLs, and the prompt estimate must fit the alias.
2. **Admit.** The call counts against the run cap, the visitor's day and the system's
   day. A call that never reaches a provider is not counted.
3. **Plan.** The alias's chain is filtered: visitor content skips providers that may
   train on it, the production profile skips providers whose terms forbid production,
   and models without a capability the call needs (tools, vision, JSON schema) are
   skipped.
4. **Walk the chain.** For each model: skip it while its circuit breaker is open or a
   429's Retry-After runs; reserve its minute and day budgets (requests, tokens or
   Neurons) atomically; call it. A 429, 5xx, timeout or dropped connection moves to the
   next model. A 400 comes straight back, since every model would refuse it.
5. **Stream.** A stream commits to a model when its first event arrives. After that it
   never switches provider: a failure ends it with an error event.
6. **Settle.** The reservation is corrected with the provider's own token count, and
   the call and attempt spans go to `<prefix>run:<runId>:spans`. Spans carry models,
   timings and token counts, never prompt or answer text.

## Errors

Errors use the OpenAI envelope, `{"error": {"message", "type", "code"}}`. The `code`
is stable:

| Status | `code` | What the caller should do |
|---|---|---|
| 400 | `invalid_request` | Fix the headers or body |
| 400 | `unsupported_request` | No allowed model on the alias can take this call (for example images on `lb-tools`) |
| 400 | `upstream_rejected` | The provider refused the request itself; its reason is in the message |
| 401 | `invalid_service_token` | Mint a fresh token |
| 403 | `system_not_allowed`, `alias_not_allowed` | The service or system may not make this call |
| 403 | `permission_denied` | The service may not read run traces (only a `traceReaders` service may) |
| 404 | `run_not_found` | No trace for that run: unknown, expired, or a system the reader may not see |
| 404 | `model_not_found` | Ask for an `lb-` alias of the right kind |
| 413 | `input_too_large` | Shorten the prompt |
| 429 | `quota_exceeded` | The run, visitor or system quota is spent; `Retry-After` when it frees up |
| 429 | `rate_limited` | A run's trace is read too often; `Retry-After` says when to ask again |
| 502 | `upstream_failed` | Every model failed: serve a replay |
| 503 | `budget_exhausted` | Every model is out of budget or cooling down: serve a replay, retry after `Retry-After` |
| 503 | `gateway_unavailable` | Redis is down or no provider is configured. The gateway fails closed |
| 504 | `upstream_timeout` | The alias's deadline passed |

## Budgets

`routing.yaml` holds each provider's free limits: per model on Groq, one shared pool
of 10,000 Neurons a day on Workers AI (each model converts tokens to Neurons at
Cloudflare's rates), and account-wide request limits on OpenRouter. Minute windows
slide; day windows reset at 00:00 UTC, as the providers' do. Traffic stops at 90% of a
minute limit and 95% of a day limit, and `/v1/usage` flags any daily budget past 70%.

## Security

- **Service tokens.** Each service signs short-lived JWTs (EdDSA, `aud: lb-gateway`,
  `kid` and `iss` both the service name) with its own private key. The gateway holds
  only public keys, refuses tokens older than 10 minutes, and ties each system to one
  service.
- **Trace readers are not callers.** Reading traces and calling models are separate
  permissions that no service holds together: `traceReaders` in `routing.yaml` lists the
  readers, a reader owns no system, and the loader refuses a file that says otherwise.
  Any valid service token can still read `GET /v1/models` (only its own aliases, so a
  reader sees none) and `GET /v1/usage` (budget counters, no visitor data).
- **Fails closed.** Without Redis there is no budget check, so calls are refused, not
  sent unmetered.
- **No content in logs or spans.** Request logs carry no headers or bodies, and
  authorization and session headers are redacted as a second line of defence.
- **Provider traffic** is HTTPS only, never follows redirects, and response bodies and
  SSE events are size-capped.

## Provider keys

Keys live only in the gateway's environment, under the names routing.yaml gives them
(`GROQ_API_KEY`, `CLOUDFLARE_API_TOKEN` with `CLOUDFLARE_ACCOUNT_ID`, `OPENROUTER_API_KEY`,
`NVIDIA_API_KEY`). Never paste a key into code, a chat, an issue or a log.

- **Local runs:** `services/gateway/.env`, which git ignores.
- **Cloud coding sessions:** an environment variable of the same name in the
  environment's settings; a new session picks it up.
- **Production:** the SOPS-encrypted secrets file, decrypted only on the box at deploy.

For OpenRouter, create a key used only by this gateway and give it a small credit
limit, such as $1. The gateway only calls free (`:free`) models, which cost nothing and
don't draw on the limit, but the account now holds a $10 balance (decision D9), and the
limit is what stops a leaked key from spending it on paid models. That one-time credit
lifts the free-model day limit from 50 to 1,000 requests for good, as
`providers.openrouter.limits.day` in routing.yaml says. Keep the balance above zero:
OpenRouter refuses even free models on a negative balance, and the gateway then falls
back past it.

## Local use

```sh
cp services/gateway/.env.example services/gateway/.env    # then add provider keys
just gateway-token keygen django-systems ~/.lb/django-systems.jwk.json
# paste the printed entry into LB_SERVICE_KEYS, start Redis, then:
just gateway
TOKEN=$(just gateway-token mint django-systems ~/.lb/django-systems.jwk.json)
curl -N localhost:8080/v1/chat/completions \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'x-lb-system: lb-01' -H 'x-lb-run-id: local-run-0001' -H 'x-lb-data-class: synthetic' \
  -d '{"model": "lb-fast", "stream": true, "messages": [{"role": "user", "content": "Classify: my bag arrived torn"}]}'
```

## Tests

`pnpm --filter @lb/gateway test` runs the unit tests and the integration tests. The
integration tests use a real Redis from Testcontainers and scripted fake providers on
local ports, and cover fallback, streaming, budgets, quotas, data classes, access
control, a client disconnecting mid-stream, reranking and the guard's segments, and the
Scope's route (who may read a trace, cursors, size limits, what is refused, how often a run
may be read, what the request log leaves out, and spans that hold no visitor's words). Without Docker, point them at any Redis:
`LB_TEST_REDIS_URL=redis://127.0.0.1:6379 pnpm --filter @lb/gateway test`. Each test
uses its own key prefix and removes its keys afterwards.

## Not yet in the gateway

These arrive with the system that first needs them:

- `lb-stt` (speech to text), with LB-09.
- A response cache for synthetic samples, and the persister that drains the span
  stream into `platform.run_spans`. Until it exists a trace lives in Redis for 24 hours
  after its last span, so a permalink to an older run answers 404.
