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
| Operations | `GET /v1/usage`, `GET /healthz` (liveness), `GET /readyz` (Redis and providers) |
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
| 404 | `model_not_found` | Ask for an `lb-` alias of the right kind |
| 413 | `input_too_large` | Shorten the prompt |
| 429 | `quota_exceeded` | The run, visitor or system quota is spent; `Retry-After` when it frees up |
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
- **Claude Code cloud sessions:** an environment variable of the same name in the
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
control, a client disconnecting mid-stream, reranking and the guard's segments. Without Docker, point them at any Redis:
`LB_TEST_REDIS_URL=redis://127.0.0.1:6379 pnpm --filter @lb/gateway test`. Each test
uses its own key prefix and removes its keys afterwards.

## Not yet in the gateway

These arrive with the system that first needs them:

- `lb-stt` (speech to text), with LB-09.
- A response cache for synthetic samples, and the persister that drains the span
  stream into `platform.run_spans`, with the Scope.
