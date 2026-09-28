# CLAUDE.md

Guidance for Claude Code sessions working in this repository.

## Project

A live AI portfolio: ten AI systems (LB-01 to LB-10) built for one fictional company,
Basalt & Bean Coffee Co., on a shared platform (LB-00). Every system runs live on the
main site and any visitor can try it, inspect its trace, and try to break it.

- Stack and the reasons behind it: [`docs/STACK.md`](docs/STACK.md)
- How each system is built and shipped: [`docs/PLAYBOOK.md`](docs/PLAYBOOK.md)
- Visual proposal (private to the owner): https://claude.ai/artifact/GJi1aeCdsYB6UDwDuD6WgC
- Brand: Landry Bodjona, logo mark LB ([`brand/`](brand/README.md)). Part numbers and
  internal names use the LB prefix (`LB-01`, `lb-fast`).

Status: planning. Only the workspace root and `packages/icons` are scaffolded. Add
each new command to the Commands section in the change that introduces it.

## Git rules (owner's instruction, mandatory)

- Every commit is authored and committed as
  `Tchiwa-Kibolou BODJONA <78790172+Landry12-BAS@users.noreply.github.com>`.
- Never commit as `Claude <noreply@anthropic.com>`, and never add a `Co-Authored-By`
  trailer that carries an Anthropic address.
- Use the GitHub noreply address, never a personal email: the owner keeps email
  privacy on, and GitHub can reject pushes that expose a private address.
- Cloud sessions start with the environment's identity and its commit-signing key.
  Before the first commit in a new environment, run:

  ```sh
  git config user.name  "Tchiwa-Kibolou BODJONA"
  git config user.email "78790172+Landry12-BAS@users.noreply.github.com"
  git config commit.gpgsign false   # the environment key is not on the owner's account,
                                    # so signed commits would show as "Unverified"
  git var GIT_AUTHOR_IDENT && git var GIT_COMMITTER_IDENT   # verify both lines
  ```

## Architecture rules

- Every model call goes through the AI gateway (`services/gateway`) using a virtual
  model alias such as `lb-fast` or `lb-tools`. Services never call a provider directly
  and never hold provider keys.
- Treat model output as untrusted input: validate structured output against its
  schema (Zod or Pydantic) and repair or reject, never pass it through unchecked.
- Free-tier limits are design inputs. A feature that adds model calls must state its
  calls per run and fit the budgets in `services/gateway/routing.yaml`.
- Demos open on curated samples whose results are cached. Custom input is the only
  path that spends provider quota.
- Synthetic data only. Visitor uploads expire through storage lifecycle rules.
- Visitor content only goes to providers that don't train on inputs; `routing.yaml`
  marks each provider. The NVIDIA API catalog is for private experiments only: its
  trial terms forbid production use.
- One database, one schema per system. Each runtime owns its migrations: Django
  migrations, Alembic for Flask, Drizzle for Node. Never write across schemas.

## Security rules

- No accounts: never add sign-up, login or logout for visitors. Visitors stay
  anonymous; protection comes from Turnstile, signed sessions and quotas.
- The server opens no inbound ports (Cloudflare Tunnel). Owner tools and SSH are
  reachable only over Tailscale, never on a public hostname.
- Every response carries the headers in `docs/SECURITY.md`: nonce-based CSP with
  Trusted Types, no framing. Never use `v-html`, and never execute model output.
- Secrets live in SOPS-encrypted files or deploy secrets, never in code, logs or
  prompts.

## Code conventions

- Front end: Nuxt with Pinia (owner's decision). Vue single-file components with
  `<script setup lang="ts">`; no TSX or JSX anywhere in the repo.
- TypeScript: strict mode, ESLint (flat config) for lint and format, Zod at every
  boundary.
- Python: 3.13, uv, Ruff for lint and format, mypy (with django-stubs), Pydantic v2.
- Comments explain why, not what. No placeholders or pseudo-code in committed code.
- Every change ships with tests at the right level: unit, integration
  (Testcontainers), or end to end (Playwright). Prompt changes pass the eval gate.

## Design rules

- Light theme by default; a dark theme follows the visitor's system setting, with a
  toggle. Both follow electronic component datasheets: part numbers, spec tables,
  numbered figures, revision history.
- Colors and type come from the tokens in `packages/ui`, and every token has a light
  and a dark value. Archivo (display and text) and Martian Mono (data). No hard-coded
  colors, and no gradients outside the LB mark.
- Signal blue, the logo's ribbon, is the one accent colour. The evaluation board, in
  a deep shade of it, marks live demos and nothing else.
- Icons come only from `@lb/icons`, drawn in the logo's pattern. No emoji, no
  third-party icon sets.
- The LB mark comes only from the files in `brand/`: `lb-mark-light.svg` in the light
  theme, `lb-mark-dark.svg` in the dark theme. Never redraw, recolour or retype it.
- WCAG 2.2 AA in both themes, full keyboard use, `prefers-reduced-motion` respected.

## Commands

Everything runs through the root `justfile`, which wraps the pnpm scripts (Node 22.18
or later, pnpm 10; `.mise.toml` pins Node 24 for CI).

| Command | What it does |
|---|---|
| `just install` (`pnpm install`) | Install every workspace dependency |
| `just lint` (`pnpm lint`) | ESLint on every TypeScript and Vue package |
| `just typecheck` (`pnpm typecheck`) | Strict type-check with `vue-tsc` |
| `just test` (`pnpm test`) | Every Vitest suite |
| `just check` (`pnpm check`) | Fail when a generated file is stale (the CI drift check) |
| `just icons` | Regenerate the icon sprite and registry after editing `packages/icons/svg` |

`just dev` and `just seed` arrive with the Nuxt app and the seed data.
