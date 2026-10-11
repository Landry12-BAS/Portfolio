The design of the site: the direction the owner chose and the rules it runs on

Written on 2026-10-11, after the owner chose between six directions for the landing page's first screen (docs/DESIGN-BRIEF.md says how). He chose a mix of two: "the Scope first" and "ten signals". This file is the design system as it stands; it grows with each slice (the landing page, then LB-01, LB-02 and on).

The idea, in one line

The site shows its own work. The first thing a visitor sees is a real recorded run playing in the Scope, and the ten systems are shown working, not listed.

The first screen

1. Left, the headline, the lede, two ways in (pick a system, read this trace) and a stamp with the facts: no accounts, two languages, free model tiers behind one gateway.
2. Right, the Scope: the nine steps of LB-01's torn-bag run as bars on one time axis, the model call under each with its tokens, a playhead that crosses the run in the run's own time (10.9 seconds) and starts again. The numbers come from the recording in apps/web/recordings; shared/data/hero-trace.ts holds them and a unit test keeps them equal to the file.
3. Under the fold's edge, the wall: ten tiles, one per system, each with a small scene of that system at work, the part number, the back end, the name and what a visitor does there. The tile opens the datasheet.
4. Then the sections that were there: the selection guide with its filters, what every system page shows, the build order.

What a visitor should remember after ten seconds: the trace moving, and ten machines working.

Type

Archivo for display and text, Martian Mono for data, both served by the site. The headline at font-stretch 118 percent, weight 800, line-height 0.96, from 2.4 rem on a phone to 5.2 rem on a desktop. Kickers and every number in the mono face, in capitals with wide tracking, 10 to 12 pixels.

Colour

Only the tokens in packages/ui/app/assets/css/tokens.css, each with a light and a dark value. Signal blue stays the one accent: the kicker, the lit tile, the playhead, the pulse. The Scope's four channels keep their colours (model, tool, retrieval, guard) in the hero exactly as in the real Scope, so a visitor who opens a board recognises them. A scene that draws a document uses the paper tokens, white in both themes. No gradients, no new colours: the chosen direction did not need the two rules it was allowed to bend.

Motion

1. Everything moves with CSS alone: keyframes and transitions, no library. The security policy stays as it is.
2. One pace for the whole site, in tokens: fast (160 ms) for a control that answers, slow (420 ms) for a part that arrives as the page is scrolled, enter (640 ms) for a page's first screen, and one easing, quick to start and soft to land.
3. The first screen comes in once, top to bottom, the Scope a beat after the headline: it rises and wipes in, the way a sheet prints. What is below the fold comes in as the visitor reaches it, with a short rise, siblings staggered by 50 ms (useRevealOnScroll). Nothing fades: text at partial opacity reads as low contrast, to an accessibility check that runs while it arrives and to anyone who catches that moment. Nothing is ever hidden from someone who can see it: the page renders whole, and only parts still below the fold are set back, once the page is scripted.
4. Pages change with a short fade and a four-pixel rise, the old one leaving before the new one comes.
5. One load-bearing motion per screen: the playhead. The tiles' scenes are quiet loops, under four seconds each, and none carries meaning on its own.
6. Every animation has a still state under prefers-reduced-motion: the playhead parks at the drafting step, the scenes stop, hover lifts are off, the reveals and page changes are instant.
7. Hover lifts a tile two pixels and darkens its border; nothing else reacts to the pointer.

Layout

1. The page keeps its 16 pixel gutter and its sheet. The hero is a 5 to 7 grid on a desktop and one column under 980 pixels.
2. The wall is five tiles across, three under 1100 pixels, two under 640, where the scenes shrink and the one-line action gives way to the name alone.
3. Every link and button is at least 44 pixels tall.

Honesty

1. A replay is labelled a replay, in the Scope's header.
2. The hero says when the run was recorded.
3. The scenes are decoration and are hidden from assistive technology; the words on each tile say everything the scene does.

Where it lives

1. apps/web/app/components/home/HeroScope.vue, SystemsWall.vue and TileScene.vue.
2. apps/web/shared/data/hero-trace.ts and its test, apps/web/test/unit/hero-trace.test.ts.
3. The strings under home.hero and home.wall in apps/web/i18n/locales/en.ts and cs.ts.

Still to come in this slice, once the owner sends them: his own presence on the page (a short text, where to reach him, a CV, a portrait if he wants one) and the image shown when a link is shared.
