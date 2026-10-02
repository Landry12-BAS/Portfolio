# Build playbook

How the portfolio gets built: in what order, how one system goes from idea to live
demo, and what "done" means. The stack itself is in [`STACK.md`](STACK.md).

## Principles

1. **Finish one system before starting the next.** A finished system beats three
   half-built ones in front of a recruiter.
2. **Samples first.** Every demo opens on curated samples with cached results, so a
   visitor sees it work instantly and free-tier quota is spent only on custom input.
3. **Every number is measured.** Datasheet figures come from recorded runs and eval
   results, never from estimates. Until measured, a number is labelled as a target.
4. **Budgets are design inputs.** Each system declares its model calls per run before
   it is built, and the gateway enforces them.
5. **The demo never breaks.** When a budget runs out or a provider fails, the system
   serves a recorded real run, labelled as a replay.

## Build order

| Phase | Systems | Why this order |
|---|---|---|
| 1. Foundation | LB-00 Platform, LB-01 Support Desk (Django), LB-08 Automation Studio (Node), LB-05 Data Analyst (Flask sync) | Covers all three back ends, the gateway, tracing, quotas and the eval harness. Everything after reuses them. |
| 2. Breadth | LB-02 Booking Concierge, LB-03 Invoice Reader (Flask async), LB-04 Contract Radar, LB-07 QA Engineer | Adds real-time chat, vision, long documents and browser automation on a stable base. |
| 3. Showpieces | LB-06 Incident Commander, LB-09 Meeting Recorder, LB-10 Eval Lab | The most complex builds, on the most mature platform. Eval Lab inherits golden sets grown since Phase 1. |

Start with LB-00 and LB-01 together: the support desk exercises every platform piece
(gateway, quotas, traces, streaming, evals, human review) with the least domain risk.

Relative size for one developer: M is about 1 to 2 weeks, L about 2 to 4 weeks, XL
4 weeks or more. Phase 1 is about two months. All ten systems come to about six months.

## Building one system

Follow these steps in order. Each step lands as its own small pull request when it
can.

1. **Datasheet stub.** Write the system's MDX datasheet first: function, problem,
   what the visitor does, what it proves, and target operating limits. If it can't be
   explained on one page, the scope is too big.
2. **Contracts.** Define the API (OpenAPI from Django Ninja, flask-openapi3 or
   Fastify), the events, and the run spans. Regenerate the TypeScript clients.
3. **Golden set before prompts.** Collect 20 to 50 cases with expected outputs and a
   grading method (exact match, schema checks, execution checks, or a rubric).
4. **Budget.** State model calls per run and the gateway aliases used. Add the
   system's quotas to `routing.yaml`.
5. **Pipeline.** Implement behind the gateway. Validate every structured output.
   Keep untrusted content (uploads, tickets, web pages) out of instruction slots, and
   require human approval for any side effect.
6. **Evaluation board.** Build the live demo UI on the curated samples, wire the Scope
   trace, and support the Brief and Technical reading modes. The kit (shell, limits,
   Scope, Turnstile gate, notices, replay) is in `apps/web`, and so is the recipe; LB-01's
   board is the reference (`apps/web/README.md`, "Adding a board").
7. **Tests.** Unit tests for logic, integration tests against real Postgres and Redis
   (Testcontainers), one Playwright journey, and the eval gate in CI.
8. **Threat model.** Write short notes on spoofing, tampering, data exposure, denial
   of service and privilege escalation, and set the operating limits.
9. **Replays.** Record real runs for every sample and store them for replay mode:
   `just record-sample <system> <sample>` runs a sample on the live back end and writes the
   recording (`apps/web/recordings`), which the board replays under a "Replay" badge.
10. **Release.** Replace the datasheet targets with measured values, then deploy.

## Definition of done

A system is done when all of these are true:

- [ ] Live demo on the main site, open to any visitor, opening on cached samples
- [ ] Datasheet page in Brief and Technical modes, with measured numbers
- [ ] Scope trace for every run, with a permalink
- [ ] Golden set and a CI eval gate that blocks regressions
- [ ] Unit, integration and at least one end-to-end test, all green in CI
- [ ] Threat model notes and operating limits enforced by the gateway
- [ ] Security gate green: headers, CodeQL and Semgrep, secret scan, ZAP baseline
- [ ] Replay recordings for every sample
- [ ] Accessibility check (axe) and performance budget passing, in the light and the
      dark theme

## Workflow

- **Branches.** Short-lived branches off `main`, merged by squash with a Conventional
  Commit title (`feat(lb-01): cite policy chunks in drafts`).
- **Pull requests.** Every PR gets a Vercel preview. CI must pass: lint, types, tests,
  API client drift check, eval gate (when prompts change), axe and Lighthouse budgets.
- **Commits.** Owner identity only. See the git rules in [`../AGENTS.md`](../AGENTS.md).
- **Deploys.** Merging to `main` builds multi-arch images, pushes them to GHCR, and
  deploys the box over SSH with health checks. Roll back by redeploying the previous
  image tag.

## Operating on free tiers

Free tiers change without notice, so they get a routine:

- **Weekly:** check each provider's published limits, model list, deprecation notices
  and terms. Update `routing.yaml` when anything changes.
- **On any routing change:** rerun the affected golden sets in Eval Lab. A fallback
  model has to pass the same quality bar as the primary before it is allowed on
  that route.
- **Daily (automated):** the gateway reports usage against each provider's budget.
  Alert at 70% of a daily budget; switch that route to replay mode at 95%.
- **Never:** send real personal data to a free endpoint. Some free endpoints log or
  train on prompts.

## Content and voice

- Write like a datasheet: short, specific, measured. Name things the way a visitor
  would, not the way the code does.
- Every system page states its limits plainly, including when a result is a replay.
