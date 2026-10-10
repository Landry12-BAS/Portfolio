# Handoff: the Portfolio work, from the cloud session to the Mac session

Written on 2026-10-10 by the cloud session ("Cloud Project") that built the ten systems and
drove PR #4, for the session on the owner's Mac ("Cloud Setup"), which takes over all
Portfolio work from here. Nothing below is a secret: no key, token or password appears in
this file, and none should ever be added to it.

## Where things stand

- **Branch and PR.** All work is on `kibo/integration`, which is PR #4 into `main`
  (https://github.com/Landry12-BAS/Portfolio/pull/4). PR #3 is closed: its whole history is
  inside PR #4. `main` holds only a README until PR #4 merges.
- **Head:** this file's own commit, on top of `0374323`. CI on `0374323`: 17 jobs green
  (the four end-to-end shards among them), the eval jobs skipped or green by design, and
  **one red: "Lint, types and tests"**, from one unit test at its time limit (below, first
  in the CI history). Nothing in this file's commit touches code, so its CI is expected to
  show the same.
- **`main` is protected:** a pull request is required (0 approvals, since the owner is the
  only reviewer), the 16 non-eval CI checks must pass, no force pushes or deletion, admins
  included.
- **Merging PR #4 starts the first deploy** (`deploy.yml` runs after CI passes on `main`), and
  the deploy waits for the owner's approval on the `production` environment. Do not merge
  until parts 5 to 7 and part 10's secrets below are done.

### CI history worth knowing

- `0374323`, **not fixed yet, the Mac session's first task:** "Lint, types and tests" failed
  on one unit test, `apps/web/test/unit/lb06-store.test.ts:65` ("looks for the trace again
  when the incident ends if the Scope had given up"), which timed out at 5039 ms; the other
  1973 passed. It plays a whole incident on fake timers, stepping 20 ms at a time through
  up to 100 seconds of simulated time, and every step costs real time: 1.4 s on the cloud
  session's machine, 0.46 s on an M4, and 2231, 2814, 4512 and 4921 ms on the four earlier
  green CI runs of this branch. The unit project in `apps/web/vitest.config.ts` sets no
  `testTimeout` (the integration project's is 20 s), so it runs under Vitest's 5 s default,
  and a busy runner tipped it over. The e2e change in `0374323` is not imported by it. The
  fix: an explicit time limit on that test (20 s, as the integration project uses), or on
  the file's long simulated journeys. The cloud session did not change it, so it is not done
  twice.
- `595f0b7`: "End-to-end, accessibility and security headers (1/4)" failed in
  `e2e/i18n.spec.ts` ("filters the catalog in Czech"). **Not a flake in the sense of "retry
  it": a real race in the test.** The catalog is server-rendered, and a click that lands
  before Vue hydrates the page finds a button with no handler and is lost. A probe that held
  the site's scripts back three seconds reproduced it every time. Fixed in `0374323`:
  `pressUntilPressed` in `apps/web/e2e/fixtures.ts` clicks until `aria-pressed="true"`
  (the catalog filters set a value rather than flip it, so pressing again is harmless).
  Use it for any toggle a journey presses right after `goto`.
- `1e782d0`: Vercel's preview builds had failed with "No Output Directory named dist".
  `turbo.json` had one `build` task shaped for `@lb/icons` that also governed
  `@lb/web#build`, so Vercel's Turbo remote cache replayed the site's build without its
  output, and the site's source was not in the cache key. The shared `build` task is now
  uncached and `@lb/icons#build` has its own cached definition;
  `apps/web/test/unit/build-cache.test.ts` fails on the old shape. Verified with two Vercel
  builds in a row (`1e782d0`, then the docs-only `595f0b7`): both say `@lb/web:build: cache
  bypass, force executing` and both are READY. CI and `just` build with `pnpm --filter
  @lb/web build` and never go through Turbo, which is why CI never saw it.

## docs/DEPLOY.md, part by part

| Part | State | What is left |
|---|---|---|
| 1. Accounts and tools | Done | |
| 2. The box | Done: Oracle Frankfurt, AD-2 (AD-1 was out of Ampere capacity), Ubuntu 24.04 aarch64, 2 OCPUs, 12 GB, boot volume grown to 100 GB, updated and rebooted | Watch the reclaim rule in the first week (part 2, step 4) |
| 3. Tailscale, then close SSH | `lb-box` is on the tailnet with `tag:lb-box`; Tailscale SSH works; the policy holds both tags, the grants and the ssh rules; port 22 is closed in the host's own iptables rules | **The owner removes the three ingress rules** in the VCN's default security list (TCP 22, ICMP 3/4, ICMP 3 from the VCN). Keep the egress rule. Then step 6: a public SSH attempt must time out |
| 4. System, Docker, folders, tools, keys | Done at `2638bb8`: Docker 29.9.0, Compose v5.6.0, sops 3.10.2, cosign v3.0.6; `deploy` can run Docker; the box's age key exists | |
| 5. Cloudflare | Domain on Cloudflare (TLS 1.3 minimum); tunnel `lb` with `api.landrybodjona.com` to `http://caddy:8080`; the `/ws/` rate-limit rule; Bot Fight Mode off; Turnstile widget `lb` lists `landrybodjona.com`; R2 buckets `lb-backups` (30-day rule) and `lb-uploads` (private, 1-day rule); Vercel's DNS records (two A on the root, CNAME on www, all DNS-only) | **Two R2 API tokens** (Object Read and Write, each scoped to its own bucket), made by the owner in the dashboard. The tunnel's token goes into part 7 |
| 6. Provider and service keys | Not started | On the owner's Mac |
| 7. Secrets | Not started | On the owner's Mac, **in this order**: `just secrets-init` (lists the owner's key; it only does so while `.sops.yaml` lists none), the eleven `just secrets-new`, then `just secrets-add-recipient box age1c0uy9adkfsz2he7qg9j6mrnu9ualuu77eu7err3prrszfpv33amqhkfkex` (the box's public key, checked valid), then `just secrets-check`. Commit the encrypted files and `.sops.yaml` to `kibo/integration` before PR #4 merges |
| 8. GitHub | `production` environment with `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_SECRET`; the owner is its required reviewer (self-review allowed); `LB_BOX_HOST=lb-box`; `main` protected as above | Unverified: Actions' default `GITHUB_TOKEN` permission is read-only |
| 9. The first deploy | Not started | Merge PR #4; the first run stops at the box's pull until the seven `lb-*` GHCR packages are made public; then re-run the failed jobs |
| 10. Vercel | Project `portfolio`: Nuxt preset, root `apps/web` with source files outside it, Node 24.x, `pnpm install --frozen-lockfile`, functions in `fra1`, domains `landrybodjona.com` and `www` (308 to the apex, done by Vercel), Standard deployment protection, Git connected (`Landry12-BAS/Portfolio`, production branch `main`); 5 of the 9 Production variables set | **The owner pastes the 4 Sensitive ones** (`NUXT_LB_WEB_SIGNING_KEY`, `NUXT_LB_GATEWAY_SERVICE_KEY`, `NUXT_LB_SESSION_SECRET`, `NUXT_TURNSTILE_SECRET_KEY`) before PR #4 merges: with some set and not all, the site refuses to start. Until the first production deploy, `landrybodjona.com` serves the owner's older "Developer Portfolio" (a Next.js deployment from 27 August) |
| 11. Verification checklist | Not started | After the first deploy |

## Four open decisions, for the owner

1. **Phase 3 shown as solid.** The catalog, the home page's build order and each datasheet
   draw a system's phase as a pill: solid for phase 1, outline for phase 2, dashed for
   phase 3, which reads as "later". All ten systems are built and live now.
   *Recommendation: yes,* draw every phase solid (or drop the dashed style): one line in
   `CatalogGuide.vue`, `pages/index.vue` and `pages/systems/[slug]/index.vue`, plus their
   e2e expectations.
2. **LB-07's `partner-link` sample** (the one curated sample without a recording, 65 of 66).
   The planner declines to click the About page's partner links, as its prompt tells it,
   so the sandbox's network stop the sample exists to show never happens, and the verdict
   is `passing` where the golden case expects `not_verified`. Either (a) let the planner
   click a link the goal names and leave the stop to the sandbox (a prompt change, which
   must pass `just eval-lb07`, about 77 gateway calls), or (b) make the sample show the
   planner's refusal. *Recommendation: (b).* No prompt change and no eval spend, and two
   layers stay (the planner's rule and the sandbox); the sandbox's stop is already proven
   by `just test-lb07-sandbox`. Then `just samples` and `just record-sample lb-07 partner-link`.
3. **The live evaluations** (`just eval-lb0N`, `just wer-lb09` in fast mode, LB-10's
   nightly, judge and baselines). Only LB-09's eval and LB-01's search recall have run
   live. *Recommendation: yes, spread over several days,* since the free tiers' daily
   budgets (`services/gateway/routing.yaml`) do not fit them in one. LB-09's speaker labels
   (0.71), owners (0.75) and deadlines (0.88) are under its gate; the labeller switch to
   `lb-tools` at default effort scored better on 5 of 6 cases and waits on a full
   `just eval-lb09`.
4. **44px header buttons.** The header's buttons meet WCAG 2.2 AA's 24px target size; 44px
   is the AAA size and kinder to thumbs. *Recommendation: yes if it costs nothing visible,*
   but it is optional.

## Known traps

- **Keys.** Provider keys live only in the gateway's SOPS file on the box. Never in Vercel,
  the repository, a chat or a session. Vercel holds the site's 9 variables only, and the 4
  secret ones are pasted by the owner.
- **Evals in CI.** The eval jobs run or skip depending on whether CI has provider keys
  ("Eval gate skipped (no provider keys)" is green by design). Never make an eval job a
  required check: one of the two names never reports, and every merge would block.
- **Turbo on Vercel.** Keep the site's build uncached; the unit test above holds it. No
  `TURBO_FORCE` is needed.
- **The box's firewall.** Change `/etc/iptables/rules.v4` only by editing it and
  rebooting. `netfilter-persistent reload` or `iptables-restore` on a running box replaces
  the whole table, Docker's and Tailscale's rules with it. Never remove Oracle's
  `InstanceServices` chain.
- **`.sops.yaml` order:** the owner's key first, the box's second (part 7 above).
- **GitGuardian's alert on PR #4** names throwaway passwords in CI and test fixtures. It is
  dismissed on GitGuardian's dashboard; it is not a leak.
- **Playwright locally:** `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome`
  where Chromium is preinstalled; the older 1194 build cannot draw LB-04's PDF pages.
- **LB-03's real-service integration test** can time out when the machine is loaded; it
  passes alone.
- **Git rules (AGENTS.md):** commits as `Tchiwa-Kibolou BODJONA
  <78790172+Landry12-BAS@users.noreply.github.com>`, unsigned, with no AI attribution in
  commits, PR text or comments; branches `kibo/<topic>`.

## Half-finished

- The time limit on LB-06's long store test (the CI history above).
- LB-07's `partner-link` recording (decision 2).
- LB-09's labeller switch (decision 3).
- The live evals and LB-10's nightly, judge and baselines (decision 3).
- Everything in the table above that says "Not started" or has something left.

## Where things live

| What | Where |
|---|---|
| Working rules for agents | `AGENTS.md` |
| The runbook, part by part | `docs/DEPLOY.md` |
| Stack, security, playbook | `docs/STACK.md`, `docs/SECURITY.md`, `docs/PLAYBOOK.md` |
| Model routes and free-tier budgets | `services/gateway/routing.yaml` |
| The site, its server and the boards | `apps/web` (journeys in `apps/web/e2e`, recordings in `apps/web/recordings`) |
| The systems | `services/django-systems` (LB-01, 02, 09), `services/flask-systems` (LB-03, 05, 10), `services/node-systems` (LB-04, 06, 07, 08) |
| Infrastructure, secrets templates, deploy script | `infra/` (`infra/secrets/*.example.env`, `infra/scripts/deploy.sh`) |
| Who can open the secrets | `.sops.yaml` |
| Golden sets and eval packs | `evals/` |
| Synthetic data | `data/seed` |
| CI and deploy workflows | `.github/workflows` |
