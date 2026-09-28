# lb-common

The Python every LB system shares: the AI gateway client, service tokens, and the run
context and tracer behind the Scope. The Django and Flask systems depend on it; the
gateway it talks to is [`services/gateway`](../../services/gateway/README.md).

## At a glance

| Module | What it gives a system |
|---|---|
| `lb_common.gateway` | `Gateway`: the official `openai` client pointed at the gateway, plus `embed`, `rerank` and `guard`; `GatewayCode`, the gateway's error codes |
| `lb_common.run` | `Run` and `run_scope`: the run a piece of work belongs to |
| `lb_common.tracing` | `Tracer`: run spans in the gateway's format, written to the same Redis streams |
| `lb_common.tokens` | The short-lived Ed25519 service tokens the gateway checks |

## Using it

```python
from lb_common.gateway import Gateway, GatewayCode
from lb_common.run import Run, new_run_id, run_scope
from lb_common.tracing import RedisSpanWriter, Tracer

gateway = Gateway.from_env()
tracer = Tracer(RedisSpanWriter(redis, prefix="lb:"))

with run_scope(Run(system="lb-01", run_id=new_run_id(), session=session_key)):
    with tracer.span("screen for injection") as span:
        verdict = gateway.guard(ticket_text)
        span.set("flagged", verdict.flagged)
    with tracer.span("classify"):
        reply = gateway.openai.chat.completions.create(model="lb-fast", messages=messages)
```

- **Every call belongs to a run.** The client labels each request with the current
  run's `x-lb-*` headers, and refuses a call made outside `run_scope`
  (`OutsideRunError`) before anything leaves the process.
- **Spans nest across runtimes.** A call made inside a span carries that span's ID, so
  the gateway's spans for the call appear under the step that made it.
- **Samples are synthetic.** A run over the site's curated samples uses
  `data_class="synthetic"` and needs no session; a visitor's run needs their hashed
  session key, never the raw cookie.

## Settings

| Variable | Meaning |
|---|---|
| `LB_GATEWAY_URL` | The gateway's base URL, such as `http://gateway:8080`. Plain HTTP only on this machine or the internal Docker network; HTTPS anywhere else |
| `LB_SERVICE_NAME` | The calling service, such as `django-systems`. It must own the systems it calls for in `routing.yaml` |
| `LB_SERVICE_KEY_FILE` | The service's private key: the JWK file `just gateway-token keygen` writes. Only its owner may read it (`chmod 600`) |

## Errors

Every failure raises an `openai` error. When the gateway answered, `error.code` is
one of `GatewayCode`, and the gateway's README says what each one means: for example,
`budget_exhausted` means serve a replay, and `quota_exceeded` means the visitor's
quota is spent. The client never retries, because the gateway has already fallen back
across providers; a retry would only spend the run's quota twice. An answer that
doesn't match the gateway's API raises `GatewayResponseError`.

## Security

- **Tokens.** Each request carries a token with more than a minute to live, reused
  until then and minted fresh after. The private key file is refused if other users
  could read or change it.
- **Nowhere but the gateway.** The client follows no redirects and ignores proxy
  settings, so a token can't be sent anywhere else, and it refuses plain HTTP to any
  host outside the internal network.
- **Metadata only.** Span details are short labels and numbers. When a step fails,
  its span records the exception's type, never its message, which could quote a
  visitor's words.

## Tests

`just test` runs them with every other suite, and `uv run pytest python/lb-common` runs
them alone. Unit tests need nothing. Integration tests need a Redis (`LB_TEST_REDIS_URL`,
or Docker for Testcontainers) and Node: the contract tests start the real gateway on
fake providers (`services/gateway/test/support/contract-server.ts`) and drive it with
this client, from token checks to spans that nest across the two runtimes.
