# Security architecture

Status: accepted · Rev E · 28 Sep 2026 · Owner: Landry

The site has **no accounts**: no sign-up, no login, no logout. Every visitor is
anonymous, and every protection below works without asking anyone who they are.
To report a vulnerability, see [`../SECURITY.md`](../SECURITY.md).

## Principles

1. **No accounts, no login surface.** There are no passwords, reset flows or user
   sessions to steal, because there are no users to impersonate.
2. **Zero inbound ports.** The server accepts no connections from the internet. It
   dials out to Cloudflare, and Cloudflare is the only way in.
3. **Least privilege.** Every service, database role, Redis user and storage token
   reaches only what it needs.
4. **The model is untrusted.** Its output is validated, never executed, and never
   allowed a real side effect.
5. **Nothing worth stealing.** Synthetic data only, uploads expire within hours, and
   IP addresses are never stored in the clear.

## Request path

```mermaid
flowchart LR
  V[Visitor] -->|TLS 1.3| CF[Cloudflare: WAF, bot checks, rate limits]
  CF -->|Tunnel, dialled out from the box| CD[Caddy: security headers]
  CD --> APP[Django · Flask · Node]
  APP -->|signed service token| GW[AI gateway]
  GW --> P[Model providers]
  O[Owner] -->|Tailscale only| ADM[Admin and dashboards]
```

## 1. Edge

- DNS and HTTPS through Cloudflare; the origin IP is never published.
- Cloudflare Tunnel: the box runs `cloudflared`, an outbound-only connector. There is
  no inbound firewall rule for HTTP or SSH.
- Cloudflare's free managed WAF rules, Bot Fight Mode, a rate-limiting rule on the API
  hostnames, and DDoS protection.
- TLS 1.3 and HSTS with preload.

## 2. Visitors without accounts

- **Anonymous session.** A random 128-bit ID in a signed cookie with the `__Host-`
  prefix, `HttpOnly`, `Secure` and `SameSite=Strict`, rotated daily. It exists only for
  quotas and abuse protection, so it is strictly necessary and needs no consent
  banner. The site sets no other cookies and loads no trackers. The visitor's theme
  choice stays in the browser's `localStorage`, and the language is part of the URL
  (`/cs` for Czech), so choosing one stores nothing.
- **Turnstile** in invisible mode before a visitor's first AI run. People never solve
  a puzzle; bots are stopped before they spend quota.
- **Short-lived tokens.** The Nuxt server's Nitro routes mint Ed25519-signed JWTs,
  valid for 5 minutes and scoped to one system, for SSE and WebSocket calls to the
  box. Their subject is a keyed hash of the session, never the cookie itself. The
  systems check each one against the site's public key and fail closed without it;
  `services/django-systems/core/visitors.py` specifies the claims.
- **Three rate-limit layers:** Cloudflare per IP, the gateway per session, and the
  gateway per system and per provider.
- **Private by design.** IP addresses are kept only as salted hashes, and the salt
  rotates daily.

### What the site's server does

The Nuxt server (Nitro routes in `apps/web/server`) is the only thing a visitor's browser
talks to for data. It holds the site's secrets (the signing key for visitor tokens, the
`web` service key, the Turnstile secret and the session secret: the `NUXT_LB_*` variables
of [`docs/DEPLOY.md`](DEPLOY.md), part 10), checks them with Zod at startup, and refuses to
start when some are set and any is wrong, naming the variable and never its value. With none
set it serves the catalog and the datasheets and answers every demo route with 503, which is
how a Vercel preview runs.

- **Session.** A call to `GET /api/session` creates the visitor's session the first time and
  says whether this deployment has a back end, whether the Turnstile check has passed today
  and when the day's quotas turn over. The cookie is `__Host-lb_session`, worth
  `v1.<payload>.<signature>`: the payload holds a random 128-bit ID, the UTC date it was
  made and the "verified" flag, and the signature is an HMAC-SHA-256 under a key derived
  (HKDF) from `NUXT_LB_SESSION_SECRET`. A cookie the server did not sign, or one from
  another day, is ignored and replaced by a fresh session, so a visitor cannot choose their
  own ID (session fixation), and a day's verification does not carry past midnight UTC, where
  the quotas turn over too. The subject of a visitor token is a second keyed hash of the ID,
  derived under a different key, so a token never shows the cookie's ID. Pages set no cookie:
  only a call to `/api/*` creates a session.
- **Turnstile.** `POST /api/session/verify` sends the widget's token to Cloudflare's
  `siteverify` with the secret key and checks the hostname; a pass sets the "verified" flag in
  the cookie for the rest of the day. Every request to a back end that is not a read needs the
  flag, or it is answered 403 `verification_required`. The widget loads only when a visitor
  starts a live run (never for the catalog, a datasheet, a replay or a trace), from
  `challenges.cloudflare.com`, and its script's address is made by one named Trusted Types
  policy, `lb-turnstile`, that hands out that address and no other. The test build accepts a
  fixed stand-in token instead of the widget's; the stand-in is compiled out of the production
  bundle, and `just check-build` (run in CI) fails if any trace of it is left there.
- **The proxy.** `/api/lb01/...`, `/api/lb02/...`, `/api/lb05/...` and `/api/lb08/...`
  forward a visitor's call to that system with a visitor token the server signs (EdDSA,
  5 minutes, the system as audience, the keyed hash as subject). Only the routes in the back
  ends' committed OpenAPI documents are forwarded, with the methods those documents give
  (`packages/api-clients` generates the table, and `pnpm check` fails when it is stale);
  anything else is a 404 from the site, and the back end never sees it.
- **The Scope's route.** `GET /api/runs/{id}/spans` reads a run's trace from the gateway with
  the `web` service token (a permission that cannot call a model, see "Service tokens") and
  hands the page on after checking it with the span schema. A trace holds names, timings,
  models and token counts, never what was typed or answered, and expires within a day, so
  whoever has a run's ID (8 to 64 unguessable characters) may read it: that is what makes a
  permalink possible, and why it needs no session.
- **Recordings.** `GET /api/recordings/{system}[/{sample}]` serves the recordings of the
  curated samples, which are bundled with the site, checked with their schema on every read and
  looked up by a name that must match `[a-z0-9-]{1,60}`. Only a recording whose `origin` is
  `live` is served; one made on the test mock is refused, except by the end-to-end build, which
  needs it to drive the replay player.

### Threat model of the proxy

| Threat | Control |
|---|---|
| SSRF: a visitor makes the server call somewhere else | The address is the configured origin plus a path the route table matched, and is checked to still be that origin before the call. A path parameter may hold only `[\w-]{1,64}` and a query value `[\w.:-]{1,64}`, so no dot segment, escape, slash or space reaches a back end. A redirect is never followed: a 3xx is a failure |
| Request smuggling and desync | The visitor's bytes are never forwarded. The body is read with a size cap per system (the `Content-Length` is checked before a byte is read, and a chunked body is counted as it arrives), must be JSON, is parsed and written again, and the request to the back end is made with fixed headers only: the token, an `accept` and a JSON content type. Node's HTTP parser refuses conflicting or repeated length headers before any handler runs |
| Token leakage | A visitor token is made per call, lives 5 minutes and never reaches the browser. The one exception is LB-02's WebSocket, whose grant goes in the connection's first frame and never in an address. Errors name the rule that was broken and never repeat a value, the server logs an unexpected error by its name and route and never its message or stack, every answer is `no-store`, and no CORS header is ever sent |
| A back end, or something between, answering with more than it should | An answer must be JSON within a size limit and a deadline, with a status from a short list; an error is passed on only in the platform's error shape and only with the fields that shape allows, so a stack trace, an HTML page or a database message becomes a generic failure. Only `Retry-After` goes back as a header, and never a cookie |
| CSRF | `SameSite=Strict` on the cookie, plus an `Origin` check on every request that changes anything (the origin must be the site's own, and `Sec-Fetch-Site` must say `same-origin` when a browser sends it), and no CORS, so no other site can read an answer |
| Session fixation and forgery | A cookie the server did not sign is replaced, never adopted; a visitor cannot choose an ID, and there is no login to fix a session to |
| Quota evasion by clearing cookies | A new cookie is a new session, with a fresh daily quota: the daily limits are per session because there are no accounts. What bounds a visitor who keeps clearing it is the Turnstile check before the first live run, Cloudflare's per-IP limits on the API hostnames, and the gateway's per-system and per-provider budgets, which cap total spend however many sessions ask. See the known gaps |
| Body bombs and slow requests | A size cap and a deadline for each system (`apps/web/server/lib/policy.ts`), set a little above what the system itself allows |
| Markup in what the models write or a visitor types | Everything is rendered as text by Vue, `v-html` is banned by lint, and the site's API accepts a ticket that quotes a tag so the system can be tried with it (the XSS filter of `nuxt-security` is off for `/api/**`, where it would read the body first and refuse what a demo invites visitors to try) |

### Known gaps

- **Clearing cookies resets a session's quota.** See the threat model: the daily limits are
  per session, so a determined visitor can spend more than their share until Cloudflare's
  per-IP limits or the gateway's budgets stop them.
- **The per-IP layer sees the site's server, not the visitor.** The site's server calls the
  API from its host (Vercel), so Cloudflare's per-IP rate limit on the API hostnames sees that
  host's addresses for everything the site relays. It still protects the API hostnames from
  direct abuse, but abuse relayed by the site is bounded only by the Turnstile check, the
  per-session quotas and the gateway's budgets. The site has no rate limiter of its own on
  purpose: one per serverless instance would not see all requests.
- **The real Turnstile widget has not been run under this policy.** The loader, the Trusted
  Types policy and the board pages' headers are tested (component tests with a stand-in
  widget, and a header test in the end-to-end suite), but no network or Cloudflare account
  was available when they were built, so the first deployment needs one manual pass: open a
  board, start a live run, and check the console for a policy violation.
- **Long calls on a serverless host.** LB-05 and LB-08 answer within 90 seconds, and the
  site's proxy waits 95 for them (`policy.ts`); whether the Vercel plan in use lets a function
  run that long has not been checked. If it does not, those two boards must poll.

## 3. Application

- **Content Security Policy** with per-request nonces and `strict-dynamic`, plus
  Trusted Types (`require-trusted-types-for 'script'`), so injected script can't run
  even if markup slips through. `nuxt-security` sets the headers and nonces. The only
  Trusted Types policy allowed is `vue`, which Vue creates for its own compiled
  markup; the evaluation boards' pages alone add `lb-turnstile` (see "What the site's
  server does") and Cloudflare's frame, and nothing else changes. Zod is told not to build
  its parsers with `new Function` (`apps/web/app/plugins/00.zod-jitless.ts`): the policy
  would report each probe as a violation.
- **Headers:** `frame-ancestors 'none'`, `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Resource-Policy: same-origin`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`,
  and a `Permissions-Policy` that denies every device API except the microphone on
  the LB-09 page.
- **CSRF:** `SameSite=Strict` cookies plus an `Origin` check on every state-changing
  request.
- **Input and output:** Zod or Pydantic at every boundary. Vue escapes everything a
  template renders, and `v-html` is banned by lint (`vue/no-v-html`), so no visitor or
  model text is ever parsed as markup.
- **Uploads:** checked by magic bytes, size and page count; parsed in a worker with
  CPU, memory and time limits; stored in R2 under random keys; deleted by lifecycle
  rules.
- **Target:** A+ on Mozilla Observatory, checked in CI.

## 4. AI-specific risks

Mapped to the OWASP Top 10 for LLM applications:

| Risk | Control |
|---|---|
| Prompt injection | Prompt Guard 2 on visitor text, read in overlapping segments so nothing hides past its window, and failing closed without a verdict; untrusted content kept out of instruction slots; tools scoped per step |
| Insecure output handling | Structured output validated; model-written SQL parsed and allowlisted; charts are Vega-Lite data, never code |
| Excessive agency | No real side effects: sandboxed connectors, and a human click before any action |
| Sensitive data disclosure | Synthetic data; visitor content routed only to providers that don't train on inputs |
| Model denial of service | Per-run call caps, per-visitor and per-system quotas, token-aware provider budgets, replay mode |
| Supply chain | Model IDs pinned in `routing.yaml`; the eval gate runs before any change |
| System prompt leakage | No secrets or internal URLs in prompts |

Eval Lab keeps a red-team golden set of injections, jailbreaks and exfiltration
attempts. Every prompt change must pass it.

## 5. Services and data

- **Segmented networks.** Docker networks `edge` (cloudflared, Caddy), `app` (gateway
  and systems), `data` (Postgres, Redis) and `sandbox` (Playwright worker, staging
  shop). The data network has no route to the internet. Neither has `edge` or `app`, nor
  the network of either egress proxy: one `outbound` network has a route out, and only
  the two proxies and the tunnel connector join it. (`sandbox` arrives with LB-07.)
- **Allowlisted egress.** Outbound traffic goes through an egress proxy with a domain
  allowlist: the gateway may reach the model providers, the systems may reach R2 and
  Sentry, and nothing else leaves the box except the tunnel. There are two Squid
  proxies, one for the gateway and one for the systems, each reachable only from its
  caller's network, so one list never has to serve both; they allow HTTPS CONNECT to
  the listed hosts and refuse everything else.
- **Service tokens.** Each service signs short-lived JWTs (EdDSA) with its own private
  key; the gateway holds only the public keys, refuses tokens older than 10 minutes,
  ties each system to one service, and rejects everything else. The site's server has a
  token of its own, `web`, with one permission: it reads a run's trace for the Scope
  (`GET /v1/runs/{id}/spans`, metadata only, for the systems `routing.yaml` lists under
  `traceReaders`). It owns no system, so it cannot call a model, and no service that does
  call models may read traces: `pnpm check` refuses a routing table that lets one service
  do both. A service refuses a
  key file other users could read, and its gateway client never follows a redirect or
  a proxy setting, so a token can't be sent anywhere but the gateway. Provider keys
  exist only in the gateway. Without Redis the gateway can't check a budget, so it
  fails closed.
- **Postgres:** one role per system (LB-01, LB-02, LB-05 and LB-08 so far), granted only
  its own schema and the shared `extensions` schema (pgvector, btree_gist: an extension
  object, not data); the gateway's role sees only `platform`. The superuser can log in
  only over the container's own socket, and every deploy re-applies the roles and
  passwords, so a role is never created by hand. `infra/postgres/test-roles.sh` proves,
  for every pair of systems, that one role cannot read, write, create in or drop
  another's schema.
- **Redis:** one ACL user per service, limited to its key prefixes, with dangerous
  commands disabled: the gateway's meters, the Django systems' Celery queue and LB-02's
  channel layer, the Node systems' BullMQ queues, and for every service its own run
  spans. The ACL was derived from what the services run, and `infra/redis/test-acl.sh`
  runs their own test suites against it (the gateway's, lb-common's, LB-02's WebSocket
  consumers, LB-05's and LB-08's, and a Celery worker) and then checks that Redis's ACL
  log is empty. It also tries every service on every other service's keys.
- **LB-05's data:** the DuckDB warehouse is generated into a volume by a one-shot job
  that has no network, no secret and no database, and the API mounts that volume
  read-only: a compromised API cannot change the data it answers from. The volume holds
  nothing but synthetic data, is not backed up, and is made again when it is missing.
- **WebSockets:** only the site's origin may open one (Caddy checks it, and answers `403`
  to the rest), the visitor token travels in the first frame and never in the address, and
  uvicorn refuses a frame over 8192 bytes before the service reads it.
- **R2:** one scoped token per bucket.
- **Backups:** a nightly `pg_dump`, encrypted with age before it leaves the box, to
  public keys whose private halves stay off the box: a stolen box cannot read its own
  backups.

## 6. Containers and host

- **Images:** pinned by digest, slim or distroless bases, non-root users, read-only
  root filesystems, `cap_drop: [ALL]`, `no-new-privileges`, and PID, CPU and memory
  limits. CI holds every service block to these rules (`infra/scripts/check-compose.sh`),
  so a new service cannot quietly weaken them, and no service publishes a port.
- **Browser sandbox:** the LB-07 Playwright worker runs under gVisor, and its network
  reaches only the staging shop.
- **Host:** an Oracle Cloud Always Free VM running Ubuntu LTS, with unattended
  security upgrades, no password logins, and SSH reachable only over Tailscale.
  Oracle's default VCN security list opens SSH (port 22) to the internet. That rule is
  deleted once Tailscale is up, so the security list admits no inbound traffic and the
  host firewall drops anything that doesn't arrive over Tailscale.
- **Owner tools** (Django admin, dashboards) listen only on the Tailscale network. The
  public internet has no admin page and no login page.

## 7. Supply chain and delivery

- **Secrets:** encrypted in the repository with SOPS and age, and decrypted only on
  the box at deploy time, into a tmpfs (`infra/scripts/decrypt-secrets.sh` refuses any
  other folder), with an age key that is made on the box and used nowhere else. The
  owner's key stays on the owner's machine; no age key or SSH key is stored in GitHub.
- **CI:** GitHub Actions pinned by commit SHA, a least-privilege `GITHUB_TOKEN`, and
  OIDC instead of long-lived cloud keys. Deploys reach the box through an ephemeral
  Tailscale node.
- **Every image** gets an SBOM (Syft), a Trivy scan, a build-provenance attestation
  and a keyless cosign signature. The box verifies the signature before it runs the
  image: `infra/scripts/deploy.sh` checks the digest it pulled against this
  repository's image workflow, run from `main`, and a release with an unsigned image is
  refused before anything is started. Third-party images are pinned by digest instead.
- **Every change** is linted with eslint-plugin-security (no eval-like code, no regexes
  built from strings, no hidden bidirectional Unicode) and eslint-plugin-regexp (no
  regexes open to catastrophic backtracking), and CI fails on any high or critical
  advisory from `pnpm audit`.
- **Every pull request** runs CodeQL and Semgrep on the code, gitleaks for secrets,
  pip-audit and pnpm audit on dependencies, and an OWASP ZAP baseline scan against the
  full stack started in CI.
- **Renovate** keeps dependencies current, and security updates merge first.

## 8. Detection and response

- Sentry for errors, Cloudflare security events, and gateway alerts on quota
  anomalies and repeated guard hits.
- An append-only audit table records every human-approved action and every blocked
  request type.
- Runbook: block at the edge, rotate the affected key, switch systems to replay mode,
  rebuild from seed.
- `/.well-known/security.txt` points to the disclosure policy.
