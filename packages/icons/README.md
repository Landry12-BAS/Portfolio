# @lb/icons

The LB icon set: 42 icons drawn in the pattern of the LB logo. It ships the way Font
Awesome does, as one SVG sprite plus a component, built for Vue and Nuxt.

## The pattern

- **Grid.** 24 × 24 with a live area from 2 to 22. The build rejects any point outside
  it.
- **Stroke.** 2.5 wide, with flat ends and sharp corners, like the logo's cut bars and
  square counters.
- **Curves.** Full circles and round bowls, like the B.
- **Accent.** At most one element per icon is drawn in signal blue, the logo's ribbon.
  Accent strokes have round ends, like the ribbon's foot. The accent always means
  something: the moving part (`upload`, `download`), the chosen route (`gateway`), the
  result (`check`, `booking`), the trend (`analyst`).

No third-party logos (GitHub, LinkedIn and the like): their owners' guidelines forbid
redrawing them. Use their official files where one is needed.

## Icons

| Group | Icons |
|---|---|
| Systems | `gateway` (LB-00), `support` (LB-01), `booking` (LB-02), `invoice` (LB-03), `contract` (LB-04), `analyst` (LB-05), `incident` (LB-06), `qa` (LB-07), `automation` (LB-08), `meeting` (LB-09), `eval` (LB-10) |
| Platform | `trace`, `datasheet`, `chip`, `database`, `live`, `shield`, `clock` |
| Navigation | `arrow-left`, `arrow-right`, `arrow-up-right`, `chevron-down`, `chevron-right`, `menu`, `close`, `search` |
| Actions | `copy`, `check`, `play`, `pause`, `replay`, `upload`, `download`, `filter` |
| Status | `info`, `success`, `warning`, `error` |
| Theme and contact | `sun`, `moon`, `code`, `mail` |

## Use in Vue

```vue
<script setup lang="ts">
import { LbIcon } from '@lb/icons'
</script>

<template>
  <!-- Decorative: hidden from assistive tech -->
  <LbIcon name="trace" />
  <!-- Meaningful on its own: announced by its label -->
  <LbIcon name="copy" label="Copy the trace link" />
  <!-- One colour, 16 px -->
  <LbIcon name="warning" tone="mono" :size="16" />
</template>
```

- `name` is typed, so a misspelt icon fails the type check.
- The base follows `currentColor`. The accent follows `--lb-icon-accent`, which
  defaults to `#045EFE`; the dark theme sets it to the ribbon's highlight, `#1389FD`.
  `tone="mono"` paints the whole icon in `currentColor`.

## Use without JavaScript

Serve `@lb/icons/sprite.svg` from the site's public folder and reference a symbol:

```html
<svg width="24" height="24" aria-hidden="true"><use href="/icons/sprite.svg#lb-trace"/></svg>
```

## Add or change an icon

1. Copy an existing file in `svg/` as a template: one root line, one `<path>` per line.
   Mark accent paths with the ribbon blue (`#045EFE`) and put them last.
2. Run `just icons` (or `pnpm --filter @lb/icons build`) to regenerate `sprite.svg`
   and `src/generated/icons.ts`. Never edit those two files by hand.
3. Run `pnpm --filter @lb/icons test`. The tests reject points outside the live area,
   relative path commands, unknown attributes, base paths drawn over the accent, and
   stale generated files.
