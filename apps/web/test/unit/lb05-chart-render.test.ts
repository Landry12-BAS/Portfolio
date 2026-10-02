// Tests of how the board draws a chart. The proof that matters runs in a Node process with V8's code
// generation from strings switched off, where `eval` and `new Function` throw as the site's Content
// Security Policy makes the browser refuse them: every kind of chart is compiled, parsed with its
// expressions' syntax trees and drawn through the interpreter, and comes out as SVG in the design
// tokens' colours. Beside it: the expressions a compiled chart contains are the few a chart needs
// (so a new Vega-Lite that starts to emit another is noticed), no chart asks to load anything or
// shows a tooltip, and the series tokens have a value in both themes.
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it, vi } from 'vitest'

import { compileChart } from '~/boards/lb-05/chart/render'
import { checkChart } from '~/boards/lb-05/chart/spec'
import type { ChartSpec } from '~/boards/lb-05/chart/spec'
import { readChartTokens } from '~/boards/lb-05/chart/theme'

import { barChart, lineChart, pointChart } from '../support/lb05'
import { chartTokensFor, readTokens } from '../support/tokens'

const run = promisify(execFile)
const HARNESS = fileURLToPath(new URL('../support/draw-chart-headless.ts', import.meta.url))

/** Checks the three kinds of chart the back end writes and returns them as accepted specs. */
function acceptedCharts(): ChartSpec[] {
  return [barChart(), lineChart(), pointChart()].map((chart) => {
    const checked = checkChart(chart)
    if (!checked.ok) throw new Error('A fixture chart was refused.')
    return checked.spec
  })
}

/** The output of the headless harness. */
interface HarnessOutput {
  codeGenerationIsOff: boolean
  drawn: { svg: string }[]
}

/** Draws charts in a Node process that may not generate code from strings, and returns what it drew. */
async function drawWithoutEval(charts: ChartSpec[], theme: 'light' | 'dark'): Promise<HarnessOutput> {
  const child = run(process.execPath, ['--disallow-code-generation-from-strings', HARNESS], { encoding: 'utf8', maxBuffer: 20_000_000, timeout: 60_000 })
  child.child.stdin?.end(JSON.stringify({ tokens: chartTokensFor(theme), charts, width: 640 }))
  return JSON.parse((await child).stdout) as HarnessOutput
}

describe('drawing the charts without ever generating code from a string', () => {
  it('draws a bar, a line and a point chart, with the Function constructor and eval switched off', async () => {
    const output = await drawWithoutEval(acceptedCharts(), 'light')
    expect(output.codeGenerationIsOff).toBe(true)
    expect(output.drawn).toHaveLength(3)
    for (const { svg } of output.drawn) {
      expect(svg.startsWith('<svg')).toBe(true)
      expect(svg).toContain('<text')
    }
  }, 90_000)

  it('draws the marks in the series tokens, the grid in the rule token and the text in the graphite token, in the light theme and the dark one', async () => {
    for (const theme of ['light', 'dark'] as const) {
      const tokens = chartTokensFor(theme)
      const [bar, line] = (await drawWithoutEval(acceptedCharts(), theme)).drawn
      const normal = (colour: string) => colour.toLowerCase()
      expect(bar?.svg.toLowerCase()).toContain(normal(tokens.series[0] ?? ''))
      expect(bar?.svg.toLowerCase()).toContain(normal(tokens.rule))
      expect(bar?.svg.toLowerCase()).toContain(normal(tokens.graphite))
      expect(line?.svg.toLowerCase()).toContain(normal(tokens.series[0] ?? ''))
      expect(line?.svg.toLowerCase()).toContain(normal(tokens.series[1] ?? ''))
    }
  }, 90_000)

  it('draws every label, title and value as text in the drawing, and none as markup', async () => {
    const [bar] = (await drawWithoutEval(acceptedCharts(), 'light')).drawn
    for (const label of ['Basalt Blend', 'Ethiopia Guji', 'Kenya Nyeri', 'product', 'revenue']) expect(bar?.svg).toContain(label)
    expect(bar?.svg).not.toContain('<script')
    expect(bar?.svg).not.toContain('<foreignObject')
  }, 90_000)
})

describe('what a compiled chart contains', () => {
  /** The names of the functions an expression string calls. */
  function calledIn(expression: string): string[] {
    return [...expression.matchAll(/([a-z_]\w*)\s*\(/gi)].map(match => match[1] ?? '')
  }

  /** Collects every expression a compiled Vega spec holds, in the places a spec can hold one. */
  function expressionsIn(node: unknown, found: string[] = []): string[] {
    if (Array.isArray(node)) node.forEach(item => expressionsIn(item, found))
    else if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (['expr', 'signal', 'update', 'init', 'test'].includes(key) && typeof value === 'string') found.push(value)
        else expressionsIn(value, found)
      }
    }
    return found
  }

  const ALLOWED = new Set(['toDate', 'isValid', 'isFinite', 'format', 'timeFormat', 'isArray', 'join', 'ceil', 'min', 'max', 'scale', 'bandwidth', 'datum'])

  it('calls only the few functions a bar, line or point chart needs', () => {
    const called = new Set(acceptedCharts().flatMap(spec => expressionsIn(compileChart(spec, chartTokensFor('light'), 640)).flatMap(calledIn)))
    expect([...called].filter(name => !ALLOWED.has(name))).toEqual([])
    expect(called.size).toBeGreaterThan(3)
  })

  it('asks to load nothing, listens to nothing and has no tooltip', () => {
    for (const spec of acceptedCharts()) {
      const { $schema: address, ...compiled } = compileChart(spec, chartTokensFor('light'), 640) as Record<string, unknown>
      const text = JSON.stringify(compiled)
      expect(address).toContain('vega.github.io')
      expect(text).not.toContain('"url"')
      expect(text).not.toContain('"events"')
      expect(text).not.toContain('containerSize')
      expect(text).not.toContain('http')
      // The tooltip encoding is there and switched off; nothing builds one.
      expect(text).not.toMatch(/"tooltip":\{"(?!value":false)/)
    }
  })

  it('draws at the width it is given, and no narrower than a chart can be read', () => {
    const [bar] = acceptedCharts()
    expect(bar && compileChart(bar, chartTokensFor('light'), 640)).toMatchObject({ width: 640 })
    expect(bar && compileChart(bar, chartTokensFor('light'), 40)).toMatchObject({ width: 240 })
  })
})

describe('the tokens a chart is dressed in', () => {
  it('has all eight series colours, each with a value in both themes, and the first follows signal blue', () => {
    for (const theme of ['light', 'dark'] as const) {
      const tokens = readTokens(theme)
      for (let slot = 1; slot <= 8; slot += 1) expect(tokens.get(`--lb-series-${slot}`), `${theme} ${slot}`).toMatch(/^#[\da-f]{6}$/i)
      expect(tokens.get('--lb-series-1')).toBe(tokens.get('--lb-signal'))
    }
  })

  it('has eight different colours in a theme', () => {
    for (const theme of ['light', 'dark'] as const) expect(new Set(chartTokensFor(theme).series).size).toBe(8)
  })

  it('is read off the page as it is styled now, and a page without them gives none', () => {
    const page = {} as Element
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (name: string) => readTokens('dark').get(name) ?? '' }))
    expect(readChartTokens(page)).toEqual(chartTokensFor('dark'))
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    expect(readChartTokens(page)).toBeUndefined()
    vi.unstubAllGlobals()
  })
})
