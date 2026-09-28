# The LB mark

Rev C · 27 Sep 2026 · the owner's logo, traced to vector

The logo of Landry Bodjona is an L and a stemless B joined by a blue ribbon. The ribbon
runs from the B's middle bar down to the foot of the L. The owner designed it in two
versions: ink on white for the light theme and brushed silver on black for the dark
theme. Both originals are in [`source/`](source).

The SVGs are traced from those originals with one shared geometric construction. The
light file matches its original with 99.4% shape overlap and a mean colour error of 2
out of 255. The dark file matches with 98.1% overlap and a mean colour error of 3 out
of 255 inside the letters.

## Files

| File | Use |
|---|---|
| `lb-mark-light.svg` | Light theme: ink letters, blue ribbon, transparent background |
| `lb-mark-dark.svg` | Dark theme: silver letters, blue ribbon, transparent background |
| `lb-mark-mono.svg` | One colour, for print and single-ink uses. A keyline keeps the ribbon apart |
| `lb-icon-light.svg` | App icon on a white tile, 512 × 512 |
| `lb-icon-dark.svg` | App icon on a black tile, 512 × 512 |
| `lb-favicon.svg` | Favicon. Switches to light letters when the browser is in dark mode |
| `source/lb-owner-light.png`, `source/lb-owner-dark.png` | The owner's originals. Reference only; never serve them |

## Rules

- Light theme: `lb-mark-light.svg`. Dark theme: `lb-mark-dark.svg`. Never put the
  light file on a dark surface or the dark file on a light one.
- Use the files. Never redraw, retype or recolour the mark: it is geometry, not text.
- The dark mark's metal and blue gradients are the only gradients in the design. The
  interface stays flat.
- Clear space: the width of the L's stem (16% of the mark's width) on every side.
- Minimum width: 24 px for the marks, 16 px for the favicon.
- Wordmark: LANDRY BODJONA in Archivo Expanded 800, beside the mark.

## Colour

| Name | Light theme | Dark theme | Where it comes from |
|---|---|---|---|
| Ink | `#111214` | `#F2F2F4` | The letters of the light logo; the favicon's dark-mode letters |
| Paper | `#FFFFFF` | `#000000` | The backgrounds of the two originals |
| Signal blue | `#045EFE` | `#1389FD` | The ribbon: flat in the light logo, its highlight in the dark one |

Signal blue is the one accent colour of the whole project. On the site, the evaluation
board that marks live demos uses a deep shade of the same blue.

## Construction

Measurements are in mark units, with the origin at the top-left of the L. The mark is
514.4 × 413.4.

| Part | Geometry |
|---|---|
| L | Stem 82.3 wide, from the top down to the ribbon, which it tucks 1.5 under |
| B | No stem. Bars at y 26.9 to 90.3, 181.0 to 245.1 and 345.0 to 413.4. Outer bowls r 98.0 and r 108.5, meeting in a sharp waist; semicircular counters r 45.3 and r 50.0. The bottom bar's left end is cut along the ribbon, with a 46.5 fillet on top |
| Ribbon | Edges at 38.2° (upper) and 40.3° (lower), so it widens towards the foot. It folds into the top corner of the middle bar at x 239.4. The foot sits on the B's baseline, flush with the L's left edge, with corners r 26.6 and r 39.6 |

The same pattern drives the icon set in [`../packages/icons`](../packages/icons): the
ribbon's diagonal, flat terminals, round bowls and one blue accent per icon.

Each part of the dark mark is an opaque base gradient plus soft overlays for shade,
glint and shadow, clipped to the part's outline, with a 1.5-unit bright rim inside
every edge. All variants share one construction, so change them together.
