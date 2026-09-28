import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { IconPath } from '../src/types.ts'

export const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
export const SOURCE_DIR = join(PACKAGE_DIR, 'svg')
export const REGISTRY_PATH = join(PACKAGE_DIR, 'src', 'generated', 'icons.ts')
export const SPRITE_PATH = join(PACKAGE_DIR, 'sprite.svg')

/** The logo's ribbon blue. Sources use it to mark accent paths. */
export const ACCENT = '#045EFE'

/** Every coordinate must stay inside the live area, leaving a 2-unit margin. */
export const LIVE_AREA = { min: 2, max: 22 }

export interface Icon {
  name: string
  paths: IconPath[]
}

// Sources are strict so they preview correctly on their own (GitHub, editors) and so
// the build never has to guess: one root line, then one line per path.
const ROOT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" '
  + 'stroke="currentColor" stroke-width="2.5" stroke-linecap="butt" stroke-linejoin="miter">'

const KINDS: Record<string, Pick<IconPath, 'accent' | 'fill'>> = {
  '': { accent: false, fill: false },
  ' fill="currentColor" stroke="none"': { accent: false, fill: true },
  [` stroke="${ACCENT}" stroke-linecap="round"`]: { accent: true, fill: false },
  [` fill="${ACCENT}" stroke="none"`]: { accent: true, fill: true },
}

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const PATH_LINE = /^ {2}<path d="([^"]+)"(.*)\/>$/
const TOKEN = /[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g
const ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }

type Point = [number, number]

/** Parse and validate one source file. Throws with the icon's name on any violation. */
export function parseIcon(name: string, source: string): Icon {
  const fail = (why: string): never => {
    throw new Error(`${name}.svg: ${why}`)
  }
  if (!NAME.test(name)) fail('file names are lowercase kebab-case')
  const lines = source.split('\n')
  if (lines[0] !== ROOT) fail('the root element must be exactly the shared <svg> line')
  if (lines.at(-1) !== '' || lines.at(-2) !== '</svg>') fail('the file must end with </svg> and a newline')

  const paths: IconPath[] = []
  for (const line of lines.slice(1, -2)) {
    const match = PATH_LINE.exec(line)
    if (!match) fail(`unexpected line: ${line.trim()}`)
    const [, d = '', attrs = ''] = match ?? []
    const kind = KINDS[attrs]
    if (!kind) fail(`unsupported path attributes:${attrs}`)
    const outside = pathPoints(name, d).find(([x, y]) =>
      x < LIVE_AREA.min || x > LIVE_AREA.max || y < LIVE_AREA.min || y > LIVE_AREA.max)
    if (outside) fail(`point ${outside.map(v => +v.toFixed(2)).join(',')} leaves the live area`)
    paths.push({ d, accent: kind?.accent ?? false, fill: kind?.fill ?? false })
  }
  if (paths.length === 0) fail('an icon needs at least one path')
  const firstAccent = paths.findIndex(p => p.accent)
  if (firstAccent >= 0 && paths.slice(firstAccent).some(p => !p.accent)) {
    fail('accent paths come last, so the accent always paints on top')
  }
  return { name, paths }
}

/**
 * Points along a path, including sampled curve and arc interiors, so bounds checks see
 * the painted extent and not just the endpoints. Only absolute commands are allowed:
 * they keep sources readable and every coordinate checkable.
 */
export function pathPoints(name: string, d: string): Point[] {
  const tokens: string[] = d.match(TOKEN) ?? []
  const points: Point[] = []
  let cur: Point = [0, 0]
  let start: Point = [0, 0]
  let i = 0
  while (i < tokens.length) {
    const cmd = tokens[i++] ?? ''
    const arity = ARITY[cmd]
    if (arity === undefined) throw new Error(`${name}.svg: use absolute commands only, found "${cmd}"`)
    if (cmd === 'Z') {
      cur = start
      continue
    }
    do {
      const args: number[] = tokens.slice(i, i + arity).map(Number)
      if (args.length !== arity || args.some(Number.isNaN)) {
        throw new Error(`${name}.svg: "${cmd}" needs ${arity} numbers`)
      }
      i += arity
      const next = step(cmd, args, cur, points)
      if (cmd === 'M') start = next
      cur = next
    } while (i < tokens.length && !/[A-Za-z]/.test(tokens[i] ?? ''))
  }
  return points
}

function step(cmd: string, a: number[], cur: Point, out: Point[]): Point {
  const n = (k: number) => a[k] ?? 0
  let end: Point
  switch (cmd) {
    case 'H':
      end = [n(0), cur[1]]
      break
    case 'V':
      end = [cur[0], n(0)]
      break
    case 'C': case 'S': case 'Q':
      // Control points bound a Bézier curve, so checking them is conservative.
      for (let k = 0; k < a.length - 2; k += 2) out.push([n(k), n(k + 1)])
      end = [n(a.length - 2), n(a.length - 1)]
      break
    case 'A':
      end = [n(5), n(6)]
      out.push(...sampleArc(cur, n(0), n(1), n(2), n(3) === 1, n(4) === 1, end))
      break
    default:
      end = [n(0), n(1)]
  }
  out.push(end)
  return end
}

// Endpoint-to-centre conversion from the SVG specification (implementation notes,
// F.6.5), then sampling along the sweep.
function sampleArc(p0: Point, rxIn: number, ryIn: number, rotDeg: number, large: boolean, sweep: boolean, p1: Point): Point[] {
  const phi = (rotDeg * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (p0[0] - p1[0]) / 2
  const dy = (p0[1] - p1[1]) / 2
  const x1 = cos * dx + sin * dy
  const y1 = -sin * dx + cos * dy
  let rx = Math.abs(rxIn)
  let ry = Math.abs(ryIn)
  const scale = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
  if (scale > 1) {
    rx *= Math.sqrt(scale)
    ry *= Math.sqrt(scale)
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den))
  const cx1 = (coef * rx * y1) / ry
  const cy1 = (-coef * ry * x1) / rx
  const cx = cos * cx1 - sin * cy1 + (p0[0] + p1[0]) / 2
  const cy = sin * cx1 + cos * cy1 + (p0[1] + p1[1]) / 2
  const angle = (ux: number, uy: number) => Math.atan2(uy, ux)
  const t0 = angle((x1 - cx1) / rx, (y1 - cy1) / ry)
  let dt = angle((-x1 - cx1) / rx, (-y1 - cy1) / ry) - t0
  if (sweep && dt < 0) dt += 2 * Math.PI
  if (!sweep && dt > 0) dt -= 2 * Math.PI
  const samples: Point[] = []
  for (let k = 1; k < 32; k++) {
    const t = t0 + (dt * k) / 32
    const ex = rx * Math.cos(t)
    const ey = ry * Math.sin(t)
    samples.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy])
  }
  return samples
}

/** Every icon in the source folder, sorted by name. */
export function loadIcons(dir: string = SOURCE_DIR): Icon[] {
  return readdirSync(dir)
    .filter(file => file.endsWith('.svg'))
    .sort()
    .map(file => parseIcon(file.slice(0, -4), readFileSync(join(dir, file), 'utf8')))
}

/** The typed registry the Vue component draws from. */
export function renderRegistry(icons: Icon[]): string {
  const entries = icons.map(({ name, paths }) => {
    const rows = paths.map(p => `    { d: '${p.d}', accent: ${p.accent}, fill: ${p.fill} },`)
    return `  '${name}': [\n${rows.join('\n')}\n  ],`
  })
  return [
    '// Generated by scripts/build.ts from svg/*.svg. Do not edit: change the sources and',
    '// run `pnpm --filter @lb/icons build`.',
    `import type { IconPath } from '../types'`,
    '',
    'export const icons = {',
    ...entries,
    '} as const satisfies Record<string, readonly IconPath[]>',
    '',
    'export type IconName = keyof typeof icons',
    '',
    'export const iconNames = Object.keys(icons) as IconName[]',
    '',
  ].join('\n')
}

/** One SVG sprite: `<use href="sprite.svg#lb-NAME">`, coloured through currentColor. */
export function renderSprite(icons: Icon[]): string {
  const symbols = icons.map(({ name, paths }) => {
    const body = paths.map((p) => {
      if (p.accent && p.fill) return `    <path class="lb-af" d="${p.d}" fill="${ACCENT}" stroke="none"/>`
      if (p.accent) return `    <path class="lb-a" d="${p.d}" stroke="${ACCENT}" stroke-linecap="round"/>`
      if (p.fill) return `    <path d="${p.d}" fill="currentColor" stroke="none"/>`
      return `    <path d="${p.d}"/>`
    })
    return [
      `  <symbol id="lb-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" `
      + 'stroke-width="2.5" stroke-linecap="butt" stroke-linejoin="miter">',
      ...body,
      '  </symbol>',
    ].join('\n')
  })
  return [
    '<svg xmlns="http://www.w3.org/2000/svg">',
    '  <!-- Generated from svg/*.svg by scripts/build.ts. Accent paths take --lb-icon-accent. -->',
    `  <style>.lb-a{stroke:var(--lb-icon-accent,${ACCENT})}.lb-af{fill:var(--lb-icon-accent,${ACCENT})}</style>`,
    ...symbols,
    '</svg>',
    '',
  ].join('\n')
}
