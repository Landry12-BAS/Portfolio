<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/lb-mark-dark.svg">
  <img src="brand/lb-mark-light.svg" alt="LB" width="96" height="77">
</picture>

# Landry Bodjona · Portfolio
Where real-world work meets AI, agentic intelligence, and powerful tools.

Ten live AI systems built for one fictional company, Basalt & Bean Coffee Co. Every
system runs on the site, open to any visitor, with a trace of every step it takes.

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

Status: all ten systems are built and tested, each with its evaluation board on the site in
English and Czech, and the AI gateway (LB-00) that every model call goes through
([how it works](services/gateway/README.md)). `just dev-mock` opens every demo against the mock
back end with no keys at all. What is not done needs the owner's provider keys and the box: no
hosted model has been called yet, so the recorded sample runs, the live evals and the live
baselines are still to be made, and deploying is the owner's step
([`docs/DEPLOY.md`](docs/DEPLOY.md) is the runbook). [`AGENTS.md`](AGENTS.md) says where each
system lives, and every README says what was measured and what was not.

Run it with Node 22.18 or later, pnpm 10 and uv: `just install`, then `just dev`. The
commands are listed in [`AGENTS.md`](AGENTS.md#commands).
