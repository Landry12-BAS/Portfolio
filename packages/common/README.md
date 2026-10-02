# @lb/common

The TypeScript every LB Node system shares: the AI gateway client, service tokens, the
run context and tracer behind the Scope, and the check on the visitor token the site
mints. It is the twin of [`python/lb-common`](../../python/lb-common/README.md), with the
same rules, and the gateway it talks to is
[`services/gateway`](../../services/gateway/README.md).

## At a glance

| Module | What it gives a system |
|---|---|
| `gateway` | `Gateway`: the AI SDK's OpenAI-compatible provider pointed at the gateway, with a fresh service token and the run's `x-lb-*` headers on every request; `gatewayErrorOf` and `GatewayCode` for failures |
| `run` | `createRun`, `runScope`, `currentRun`: the run a piece of work belongs to, kept in an `AsyncLocalStorage` |
| `tracing` | `Tracer` and `RedisSpanWriter`: run spans in the gateway's format, written to the same Redis streams |
| `tokens` | `ServiceTokens` and `loadServiceKey`: the short-lived Ed25519 service tokens the gateway checks |
| `visitors` | `mintVisitorToken`: the signer the site's server uses for a visitor's token. `createVisitorVerifier` and `verifyVisitorToken`: the check every system runs on it. Both on `node:crypto` alone |

## Using it

```ts
import { Gateway, RedisSpanWriter, Tracer, createRun, gatewayErrorOf, newRunId, runScope } from '@lb/common'
import { generateObject } from 'ai'

const gateway = Gateway.fromEnv()
const tracer = new Tracer(new RedisSpanWriter(redis, 'lb:'))

await runScope(createRun({ system: 'lb-08', runId: newRunId(), session: sessionKey }), () =>
  tracer.span('generate graph', async (span) => {
    const { object } = await generateObject({ model: gateway.chat('lb-tools'), output: 'no-schema', prompt, maxRetries: 0 })
    span.set('attempts', 1)
    return object
  }))
```

- **Every call belongs to a run.** The client labels each request with the current run's
  `x-lb-*` headers, and refuses a call made outside `runScope` (`OutsideRunError`) before
  anything leaves the process.
- **Spans nest across the two sides.** A call made inside a span carries that span's ID,
  so the gateway's spans for the call appear under the step that made it. The contract
  tests prove it against the real gateway.
- **Samples are synthetic.** A run over the site's curated samples uses
  `dataClass: 'synthetic'` and needs no session; a visitor's run needs their hashed
  session key, never the raw cookie.
- **Structured output.** The client leaves the SDK's `response_format` out of every
  request, because the gateway's fallback chains cross providers whose JSON modes differ
  (the Django systems do the same). Describe the format in the prompt, call
  `generateObject` with `output: 'no-schema'`, check the reply with your Zod schema, and
  repair it once. Pass `sendResponseFormat: true` to `Gateway` to keep it.
- **No retries here.** Pass `maxRetries: 0` to the SDK's calls: the gateway has already
  fallen back across providers, and a retry would only spend the run's quota twice.
  `generateObject` is deprecated in AI SDK 7 in favour of `generateText` with
  `Output.object`; it stays because STACK.md names it, and only the structured-output
  helper of a service has to change when it goes.

## Settings

| Variable | Meaning |
|---|---|
| `LB_GATEWAY_URL` | The gateway's base URL, such as `http://gateway:8080`. Plain HTTP only on this machine or the internal Docker network; HTTPS anywhere else |
| `LB_SERVICE_NAME` | The calling service, such as `node-systems`. It must own the systems it calls for in `routing.yaml` |
| `LB_SERVICE_KEY_FILE` | The service's private key: the JWK file `just gateway-token keygen` writes. Only its owner may read it (`chmod 600`) |
| `LB_WEB_TOKEN_KEY` | The site's Ed25519 public key (base64url, a JWK's `x`), for `createVisitorVerifier`. Without it nobody is let in |

## Errors

`gatewayErrorOf(error)` turns a failed call into a `GatewayCallError` with the HTTP
status, the gateway's `code` and the `Retry-After` in seconds, and nothing else. The AI
SDK's own errors carry the whole request, prompt included, so log the reduced error and
never the original. `budget_exhausted` means serve a replay, and `quota_exceeded` means
the visitor's quota is spent; the gateway's README lists every code. An answer that
fails the system's own schema is not the gateway's fault, and `gatewayErrorOf` returns
`undefined` for it.

## Security

- **Tokens.** Each request carries a token with more than a minute to live, reused until
  then and minted fresh after. A key file that other users could read or change is
  refused, and no error message quotes a key.
- **Nowhere but the gateway.** The client follows no redirects, refuses any address but
  the gateway's, refuses plain HTTP to any host outside the internal network, and refuses
  to start under `NODE_USE_ENV_PROXY`, so a token can't be sent anywhere else.
- **Visitor tokens.** EdDSA only: `none`, HMAC and tokens with header extensions are
  refused. Issuer `lb-web`, audience the system, at most 300 seconds, and a subject that
  is a session hash. Without the site's key, every token fails. The signer refuses to
  make a token the verifiers would refuse (a longer life, a malformed subject or system),
  and python/lb-common's `test_visitor_contract.py` runs the real signer and checks its
  tokens with Python's real verifier, tampered, expired, wrong-audience and over-long ones
  included.
- **Metadata only.** Span details are short labels and numbers. When a step fails, its
  span records the error's name, never its message, which could quote a visitor's words.

## Tests

`pnpm --filter @lb/common test` runs them. Unit tests need nothing. The contract tests
start `services/gateway`'s own app on a fake provider and a real Redis (Testcontainers, or
`LB_TEST_REDIS_URL=redis://127.0.0.1:6379` where Docker isn't available), and drive it
with this client: tokens, run headers, chat and JSON answers, error codes, and spans that
nest across the two sides.

`@lb/common/testing` is for other packages' tests: it makes the site's key pair and signs
tokens with claims of the test's choosing (`makeSiteKeys`, and a `mintVisitorToken` that, unlike
the site's signer of the same name in `@lb/common/visitors`, takes any claims and any header, so a
test can build a token that is wrong on purpose). Never import it from a service's own code.

The site's server imports only the two small modules it needs, `@lb/common/visitors` and
`@lb/common/tokens`, so its bundle carries `node:crypto` and nothing of the AI SDK or Redis.
