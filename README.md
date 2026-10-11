<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/lb-mark-dark.svg">
  <img src="brand/lb-mark-light.svg" alt="LB" width="96" height="77">
</picture>

# Landry Bodjona · Portfolio
Where real-world work meets AI, agentic intelligence, and powerful tools.

Ten live AI systems on one platform, built around a specialty coffee business, Basalt &
Bean Coffee Co., the platform's reference business. Every system runs on the site, open to
any visitor, on demo data, with a trace of every step it takes.

| Part | System | Back end |
|---|---|---|
| LB-01 | Support Desk Agent: cited replies to tickets, approved by a person | Django |
| LB-02 | Booking Concierge: multilingual booking chat that can't double-book | Django Channels |
| LB-03 | Invoice Reader: photos and PDFs to checked accounting entries | Flask (async) |
| LB-04 | Contract Radar: every risk tied to the exact clause | Node + TypeScript |
| LB-05 | Data Analyst: plain-language questions to safe SQL | Flask (sync) |
| LB-06 | Incident Commander: AI agents diagnose a simulated outage | Node + TypeScript |
| LB-07 | QA Engineer: a browser agent that writes the test proving each bug | Node + TypeScript |
| LB-08 | Automation Studio: plain language to durable workflows | Node + TypeScript |
| LB-09 | Meeting Recorder: action items linked to the moment they were said | Django |
| LB-10 | Eval Lab: every prompt change gets a score | Flask (async) |

Front end: Nuxt (Vue 3) with Pinia, in TypeScript, with light and dark themes, in
English and Czech (`/cs`). AI: free tiers from Groq, Cloudflare Workers AI and
OpenRouter behind one gateway, with NVIDIA NIM for private experiments.

- [Stack decision](docs/STACK.md)
- [Build playbook](docs/PLAYBOOK.md)
- [Security design](docs/SECURITY.md): no accounts, no login, zero inbound ports
- [The LB mark](brand/README.md)

Status: all ten systems are built, tested and live, each with its evaluation board on the site in
English and Czech, and the AI gateway (LB-00) that every model call goes through
([how it works](services/gateway/README.md)). The site runs on Vercel at
[landrybodjona.com](https://landrybodjona.com) and the ten systems on the owner's Oracle box
behind a Cloudflare tunnel, deployed and verified by the runbook
([`docs/DEPLOY.md`](docs/DEPLOY.md), parts 9 and 11, on 2026-10-10). `just dev-mock` opens every
demo against the mock back end with no keys at all. Still to come: the live evals and LB-10's
nightly, judge and baselines, which the free tiers' daily budgets spread over several days, and
one curated sample's recording (LB-07's partner link). [`AGENTS.md`](AGENTS.md) says where each
system lives, and every README says what was measured and what was not.

Run it with Node 22.18 or later, pnpm 10 and uv: `just install`, then `just dev`. The
commands are listed in [`AGENTS.md`](AGENTS.md#commands).
