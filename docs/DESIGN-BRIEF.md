Design brief: the redesign of landrybodjona.com

Written on 2026-10-11 for the session that does the design work, by the session that deployed the platform. Read AGENTS.md first; this file adds what is specific to the redesign and what the owner decided. It holds no secret.

Who decides

The owner, Landry Bodjona, is the art director. He approves the direction on a prototype, and each slice on a preview link, before it merges. When a choice is his (taste, his own words, what the site says about him), ask one short question and wait.

What he asked for, in his words

"As i am full stack engineer i am not allowed to present only a texted project without any design NO! make a plan so that we fire a advanced and a blowing mind ux design."

"1 opus alone. 2 do the recommended. 3 as you wish but design only."

"we start with the landing page and LB 01 LB 02 etc"

What that settles

1. One model, Opus, does the direction and the build. No team of agents: it was weighed and dropped to save tokens and to keep one hand on the design.
2. The scope is "evolve". Keep the datasheet identity (part numbers, spec tables, numbered figures, the LB mark, two themes) and push it hard: motion, depth, live instrument visuals, a signature first screen. Two written rules in AGENTS.md may bend where the design argues for it: gradients outside the mark, and a second accent colour. Say which rule a change bends, and why, in the pull request.
3. The order is fixed: the landing page first, then LB-01, then LB-02, and on through LB-10, one slice at a time. A slice is finished and live before the next one starts.
4. Design only. The work lives in `apps/web`, `packages/ui`, and `packages/icons` when a new icon is needed. Nothing in `infra/`, `services/`, `.github/`, the secrets, Vercel's settings or the server changes here.

The bar

Work as a product designer with twenty years of practice who also ships the code. One idea, held on every page, that a visitor still remembers after ten seconds. Restraint where it is quiet, precision where it moves. Nothing that looks like a template or like every other portfolio made this year. The frontend-design skill says the rest.

What is wrong today

Seen on the live site on 2026-10-10, dark theme, desktop:

1. The landing page is a headline, a spec box, a filter row, a table of ten rows and three boxes. It reads like documentation. Nothing moves and nothing shows a system doing its work.
2. A visitor cannot see what any of the ten systems looks like without opening it. The table tells; it does not show.
3. The owner is absent. There is no about, no contact, no CV, no link to GitHub or LinkedIn, and no reason given to hire him.
4. There is no first-screen moment: the thing a recruiter screenshots, or remembers the site by.
5. A link shared in a chat shows no preview image.
6. The demo boards work well and look like forms.

What must not be lost

1. The honesty of the site: every number says where it was measured, a replay is labelled a replay, a demo that cannot run says why.
2. The structure a hurried reader needs: the ten systems, what each does, which back end and technique, in one scan.
3. Both languages, both themes, full keyboard use, and anonymity for the visitor.
4. Speed. The site is server-rendered and light today.

Hard constraints, checked on the live site

1. The security policy. Scripts run only from the site itself, with a nonce. Trusted Types is enforced, with one policy named `vue` (the board pages add `lb-turnstile`), so a library that writes HTML strings or builds code from text is refused in production. Images, fonts and video come only from the site (`img-src 'self' data:`, `font-src 'self'`), and `blob:` addresses are not allowed. Inline styles are allowed, so the Web Animations API and setting styles from code both work. Before adopting any library, run it in the production build (`pnpm --filter @lb/web build`, then `pnpm --filter @lb/web start`): the dev server is more forgiving than production. Prefer CSS, SVG, canvas and the Web Animations API. The policy itself does not get loosened for a visual effect.
2. Never `v-html`, never TSX, never code or markup built from strings (AGENTS.md).
3. Accessibility: WCAG 2.2 AA in both themes, checked by axe in the end-to-end journeys on every page. Every animation has a still state under `prefers-reduced-motion`. Nothing essential is said by motion or colour alone.
4. Two languages. Every visible string lives in `apps/web/i18n/locales/en.ts` and `cs.ts` or the files they import, and `cs.ts` must have the English shape. The owner reviews Czech himself: list every Czech line you add or change in the pull request so he can read them in one place.
5. Two themes. Every colour is a token with a light and a dark value, in `packages/ui/app/assets/css/tokens.css`. No colour is written into a component.
6. Type: Archivo and Martian Mono, served by the site. A new typeface must be served by the site too, and earn its weight.
7. Icons come only from `@lb/icons`, and the LB mark only from `brand/`. No emoji.
8. Two states of the site. With the back end it runs demos live; without it (every preview deployment) it replays recordings and says live runs are off. Design both: a preview link shows the second.
9. Speed budget for the landing page on a mid-range phone: largest paint under 2.5 seconds, no layout shift from the first screen, and the script added for effects stated in the pull request with its size. A heavy effect loads after the page is usable, or not at all on a small screen.
10. Every function, component and file carries its doc comment (lint enforces it), and code reads as a person wrote it.

How to run things

1. `pnpm install` once at the root.
2. `pnpm --filter @lb/web dev:mock` runs the site on http://localhost:3000 against the mock back end: every demo works with no keys.
3. `pnpm --filter @lb/web lint`, `typecheck` and `test` before every commit that changes code.
4. The end-to-end journeys (`pnpm --filter @lb/web build:e2e`, then `pnpm --filter @lb/web e2e`) need Playwright's Chromium; CI runs them on every pull request, with axe.
5. Pages: `apps/web/app/pages/index.vue` (landing), `systems/[slug]/index.vue` (a datasheet), `systems/[slug]/board.vue` (a demo board), `runs/[runId].vue` (a trace). The boards are in `apps/web/app/boards/lb-01` to `lb-10`, the shared kit in `apps/web/app/board-kit`, the six shared components in `packages/ui/app/components`.

The gates

Gate 1, the direction. Three clearly different ideas for the first screen of the landing page and the first sight of the ten systems, each a real page in the app that the owner opens on a preview link, in both themes, at phone and desktop width. One paragraph for each: the idea, what a visitor remembers, what it costs in speed and effort. Then a recommendation. Then stop and wait for his choice. Build nothing else before it.

Gate 2, the system. For the chosen direction: the tokens, the type scale, the rules of motion, the components, written down in `docs/DESIGN.md` and built in `packages/ui`. He approves it before the pages are built.

Gate 3 and on, the slices. The landing page whole (with the owner's presence on it, and the image shown when a link is shared), then LB-01, LB-02 and so on: for each system its datasheet and its board together. Each slice is one pull request with pictures in both themes, both languages and at 390, 768 and 1440 pixels wide, and with the checks green.

What the owner has to give

Ask for these at gate 1, in one message: a short text about himself, where he wants to be reached (email, LinkedIn, GitHub), a CV file or link, a portrait if he wants one on the site, two or three sites whose look he admires, and anything he cannot stand.

Git and pull requests

1. AGENTS.md's git rules apply: every commit as `Tchiwa-Kibolou BODJONA <78790172+Landry12-BAS@users.noreply.github.com>`, no trace of an assistant anywhere, branches named `kibo/<topic>`. This work starts on `kibo/design`.
2. `main` is protected: a pull request and the sixteen checks. The owner says when to merge.
3. Pull request titles and descriptions are plain: no hash headings, no dash lists, no bold or underscore emphasis, no long dashes, no tables. Short paragraphs, numbered lists, a plain line where a heading would go. He corrected this on 2026-10-10.
4. A merge to `main` also starts the Deploy workflow for the box, which rebuilds the images and waits for his approval. For a change to the site alone he can leave that approval alone: Vercel publishes the site by itself.

Spending tokens well

1. Read what the slice needs, not the repository.
2. Show, do not describe: a preview link and three pictures say more than a page of text.
3. Commit each piece as soon as it passes its checks.
4. One round of his remarks per slice, then ship. A second idea goes in the next slice.
5. Keep messages to him short, and end each with what you need from him, most urgent first.
