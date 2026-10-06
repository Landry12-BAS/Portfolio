// Unit tests of the colour tokens that axe cannot check: a mark that says something on its own (a meter's
// fill, the chosen or current item, a running step) is not text, so WCAG 1.4.11 asks it to stand 3:1 from
// what it is drawn on. The board's mark must do so on the board's tint and on the sheet, in both themes.
// It reads tokens.css from the disk, so it runs in Node rather than the package's DOM:
// @vitest-environment node
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/** A theme of the site: the `:root` rule of tokens.css, or that rule with `html.dark`'s on top. */
type Theme = 'light' | 'dark'

const css = readFileSync(new URL('../app/assets/css/tokens.css', import.meta.url), 'utf8')

/** Reads the custom properties one rule of tokens.css declares, such as `:root` or `html.dark`. */
function declarations(selector: string): Map<string, string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const rule of withoutComments.split('}')) {
    const [head, body] = rule.split('{')
    if (head?.trim() !== selector || body === undefined) continue
    const found = new Map<string, string>()
    for (const declaration of body.split(';')) {
      const [name, ...value] = declaration.split(':')
      if (name?.trim().startsWith('--')) found.set(name.trim(), value.join(':').trim())
    }
    return found
  }
  throw new Error(`tokens.css has no ${selector} rule`)
}

const themes: Record<Theme, Map<string, string>[]> = {
  light: [declarations(':root')],
  dark: [declarations('html.dark'), declarations(':root')],
}

/** Gives a token's colour in a theme: the theme's own value, else the light one, following var() as CSS does. */
function token(name: string, theme: Theme): string {
  const value = themes[theme].map(rule => rule.get(name)).find(found => found !== undefined)
  if (value === undefined) throw new Error(`no token ${name}`)
  const reference = /^var\((--[a-z0-9-]+)\)$/.exec(value)
  return reference?.[1] ? token(reference[1], theme) : value
}

/** Gives the relative luminance of a #rrggbb colour, as WCAG defines it. */
function luminance(hex: string): number {
  const linear = [1, 3, 5].map((start) => {
    const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
}

/** Gives the contrast ratio of two #rrggbb colours, as WCAG defines it. */
function contrast(one: string, two: string): number {
  const [lighter, darker] = [luminance(one), luminance(two)].sort((a, b) => b - a)
  return (lighter! + 0.05) / (darker! + 0.05)
}

describe('the board mark', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`stands 3:1 from the board's tint and from the sheet in the ${theme} theme`, () => {
      expect(contrast(token('--lb-board-mark', theme), token('--lb-board-tint', theme))).toBeGreaterThanOrEqual(3)
      expect(contrast(token('--lb-board-mark', theme), token('--lb-sheet', theme))).toBeGreaterThanOrEqual(3)
    })
  }

  it('is the board\'s own deep blue in the light theme, and the ribbon in the dark one', () => {
    expect(token('--lb-board-mark', 'light')).toBe(token('--lb-board', 'light'))
    expect(token('--lb-board-mark', 'dark')).toBe(token('--lb-signal', 'dark'))
  })

  it('is needed: the deep blue itself vanishes into the dark tint and sheet', () => {
    expect(contrast(token('--lb-board', 'dark'), token('--lb-board-tint', 'dark'))).toBeLessThan(1.5)
    expect(contrast(token('--lb-board', 'dark'), token('--lb-sheet', 'dark'))).toBeLessThan(1.5)
  })
})
