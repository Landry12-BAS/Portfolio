# The LB mark

Rev B · 27 Sep 2026 · replaces the Rev A chip mark

The logo of Landry Bodjona is a brushed-silver L and B joined by a blue ribbon. The
ribbon runs from the B's middle bar down to the foot of the L. It is the only element
in colour, and the one that ties the two letters together.

The mark is a vector recreation of the owner's reference image. It was checked
against that image in the same composition: 97.7% shape overlap, and a mean colour
error of 3 out of 255 inside the letters.

## Files

| File | Use |
|---|---|
| `lb-mark.svg` | Master, full colour. Dark surfaces only |
| `lb-mark-graphite.svg` | Light surfaces: gunmetal letters, the same blue ribbon |
| `lb-icon.svg` | Favicon, app icon, avatar: the master on its near-black tile |
| `lb-mark-mono.svg` | One colour, for print and single-ink uses. A keyline keeps the ribbon apart |
| `lb-hero.svg` | The master composition, 878 × 515, for banners and social cards |

## Rules

- Use the files. Never redraw, retype or recolour the mark: it is geometry, not text.
- On the light site, put `lb-icon.svg` beside the wordmark in the header and use
  `lb-mark-graphite.svg` for large placements. The silver master needs a dark surface.
- The mark's metal and blue gradients are the only gradients in the design. The
  interface stays flat.
- Clear space: the width of the L's stem (16% of the mark's width) on every side.
- Minimum width: 24 px for the marks, 16 px for the icon.
- Never on the green evaluation board, which is reserved for live demos.
- Wordmark: LANDRY BODJONA in Archivo Expanded 800, beside the mark.

## Construction

Measurements are in mark units, with the origin at the top-left of the L. The mark is
420 × 332.5.

| Part | Geometry |
|---|---|
| L | Stem 66.5 wide. Its foot is cut along the ribbon and tucks 1.5 under it |
| B | No stem. Bars at y 20 to 73, 145 to 199 and 277 to 332.5. Outer bowls r 79.5 and r 94; counters r 36 and r 39. The bottom bar's left end is cut parallel to the ribbon |
| Ribbon | From the B's middle bar (x 194.3) to the foot of the L. Fold r 35.9, foot corner r 20 |
| Gap | 1.7 between the ribbon and the middle bar |

Colours measured on the rendered master:

| Role | Values |
|---|---|
| Silver | `#F4F4F5` at the top of the L, `#DDDCE1` across the B, `#585D71` at the foot of the L |
| Signal blue | `#4F8FE5` at the fold, `#2C5BE7` mid-ribbon, `#122573` at the foot |
| Field | `#020106`, lifting to `#0C0D12` at the top right |

Each part is an opaque base gradient plus soft overlays for shade, glint and shadow,
clipped to the part's outline, with a 1.5-unit bright rim inside every edge. The
variants share geometry and layer order, so change them together.
