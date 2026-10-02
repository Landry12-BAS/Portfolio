// The design tokens as the stylesheet declares them (packages/ui/app/assets/css/tokens.css), read for
// the tests: the values of the light theme and of the dark one, with `var(--other)` resolved. A test
// that draws a chart headless has no page to read computed styles from, so it reads the same file the
// page does, and a token a theme lacks is a failing test.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { ChartTokens } from '~/boards/lb-05/chart/theme'

/** The two themes. */
export type Theme = 'light' | 'dark'

/** The path of the token stylesheet. */
const TOKENS_FILE = fileURLToPath(new URL('../../../../packages/ui/app/assets/css/tokens.css', import.meta.url))

/** Reads the declarations of one block of the stylesheet, such as `:root` or `html.dark`, as name and value pairs. */
function declarationsOf(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`)
  const end = css.indexOf('}', start)
  const block = css.slice(start + selector.length + 2, end).replace(/\/\*[\s\S]*?\*\//g, '')
  const declarations = new Map<string, string>()
  for (const line of block.split(';')) {
    const colon = line.indexOf(':')
    if (colon > 0) declarations.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
  }
  return declarations
}

/** Reads every token of a theme: the dark theme's own values over the light theme's, and `var()` references resolved. */
export function readTokens(theme: Theme): Map<string, string> {
  const css = readFileSync(TOKENS_FILE, 'utf8')
  const tokens = declarationsOf(css, ':root')
  if (theme === 'dark') for (const [name, value] of declarationsOf(css, 'html.dark')) tokens.set(name, value)
  for (const [name, value] of tokens) {
    const reference = /^var\((--[\w-]+)\)$/.exec(value)?.[1]
    if (reference !== undefined) tokens.set(name, tokens.get(reference) ?? value)
  }
  return tokens
}

/** The tokens a chart needs, for a theme, as the stylesheet declares them. */
export function chartTokensFor(theme: Theme): ChartTokens {
  const tokens = readTokens(theme)
  const get = (name: string): string => tokens.get(name) ?? ''
  return {
    sheet: get('--lb-sheet'),
    ink: get('--lb-ink'),
    graphite: get('--lb-graphite'),
    rule: get('--lb-rule'),
    fontSans: get('--lb-font-sans'),
    fontMono: get('--lb-font-mono'),
    series: Array.from({ length: 8 }, (_, index) => get(`--lb-series-${index + 1}`)),
  }
}
