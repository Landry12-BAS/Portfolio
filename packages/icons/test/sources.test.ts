// @vitest-environment node
// Tests for the icon sources and the build: every source follows the house rules, and
// the generated registry and sprite match the sources. The build script reads the file
// system, so these tests run in Node, not the DOM.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  loadIcons,
  parseIcon,
  REGISTRY_PATH,
  renderRegistry,
  renderSprite,
  SOURCE_DIR,
  SPRITE_PATH,
} from '../scripts/icons.ts'

const icons = loadIcons()
const check = readFileSync(join(SOURCE_DIR, 'check.svg'), 'utf8')

describe('icon sources', () => {
  it('ship the starter set', () => {
    expect(icons.length).toBeGreaterThanOrEqual(40)
  })

  it('cover the platform and every LB system', () => {
    const names = icons.map(icon => icon.name)
    const systems = ['gateway', 'support', 'booking', 'invoice', 'contract', 'analyst', 'incident', 'qa',
      'automation', 'meeting', 'eval']
    expect(names).toEqual(expect.arrayContaining(systems))
  })

  it('match the generated registry and sprite', () => {
    expect(readFileSync(REGISTRY_PATH, 'utf8')).toBe(renderRegistry(icons))
    expect(readFileSync(SPRITE_PATH, 'utf8')).toBe(renderSprite(icons))
  })
})

describe('parseIcon', () => {
  it('reads the layer and style of each path from its attributes', () => {
    expect(parseIcon('check', check).paths).toEqual([
      { d: 'M4.5 12.5L9.5 17.5L19.5 6.5', accent: true, fill: false },
    ])
  })

  it('requires kebab-case names', () => {
    expect(() => parseIcon('Check', check)).toThrow(/kebab-case/)
  })

  it('rejects relative path commands', () => {
    expect(() => parseIcon('check', check.replace('L9.5 17.5', 'l5 5'))).toThrow(/absolute commands/)
  })

  it('rejects points outside the live area', () => {
    expect(() => parseIcon('check', check.replace('19.5 6.5', '23 6.5'))).toThrow(/live area/)
  })

  it('checks arcs by their painted extent, not only their endpoints', () => {
    const bulge = check.replace('M4.5 12.5L9.5 17.5L19.5 6.5', 'M4 8A8 8 0 0 1 20 8')
    expect(() => parseIcon('check', bulge)).toThrow(/live area/)
  })

  it('rejects attributes outside the four path kinds', () => {
    expect(() => parseIcon('check', check.replace('stroke="#045EFE"', 'stroke="red"'))).toThrow(/unsupported/)
  })

  it('keeps accent paths on top of base paths', () => {
    const accentFirst = check.replace('</svg>', '  <path d="M4 4H20"/>\n</svg>')
    expect(() => parseIcon('check', accentFirst)).toThrow(/accent paths come last/)
  })
})
