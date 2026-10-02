// Unit tests for the chart the board will draw: the three kinds of chart the back end writes are
// accepted, and everything else is refused, in particular every way a Vega-Lite spec can reach outside
// itself (a URL to load, an expression to evaluate, a signal, a transform, a selection, a link, a
// format that runs code). The checks are on the spec as data; the drawing is tested separately.
import { describe, expect, it } from 'vitest'

import { chartFacts, chartRows } from '~/boards/lb-05/chart/facts'
import { checkChart } from '~/boards/lb-05/chart/spec'
import type { ChartEnvelope } from '~/boards/lb-05/schemas'

import { barChart, lineChart, pointChart } from '../support/lb05'

// A link that would run script if followed, written in two parts so no line of this file is one.
const SCRIPT_LINK = ['java', 'script:alert(1)'].join('')

/** Makes a copy of a chart whose spec a test is free to change. */
function copyOf(chart: ChartEnvelope): ChartEnvelope {
  return structuredClone(chart)
}

/** Changes one part of a chart's spec and returns the chart. */
function withSpec(chart: ChartEnvelope, change: (spec: Record<string, unknown>) => void): ChartEnvelope {
  const copy = copyOf(chart)
  change(copy.spec)
  return copy
}

/** Tells whether a chart was refused. */
function refused(chart: ChartEnvelope): boolean {
  return !checkChart(chart).ok
}

describe('the charts the back end writes', () => {
  it.each([['bar', barChart()], ['line', lineChart()], ['point', pointChart()]] as const)('are accepted: %s', (_, chart) => {
    expect(checkChart(chart).ok).toBe(true)
  })

  it('may leave the tooltip on or off, and the label order out', () => {
    expect(refused(withSpec(barChart(), (spec) => {
      spec.mark = { type: 'bar' }
    }))).toBe(false)
  })

  it('keep their data, their titles and their mark when accepted', () => {
    const checked = checkChart(lineChart())
    expect(checked.ok && checked.spec.mark.type).toBe('line')
    expect(checked.ok && chartRows(checked.spec)).toHaveLength(8)
    expect(checked.ok && checked.spec.encoding.color?.title).toBe('country')
  })
})

describe('a spec that reaches outside itself', () => {
  const hostile: [string, (spec: Record<string, unknown>) => void][] = [
    ['data to load from an address', (spec) => {
      spec.data = { url: 'https://evil.example/data.csv' }
    }],
    ['data to load from an address, next to inline data', (spec) => {
      (spec.data as Record<string, unknown>).url = 'https://evil.example/data.csv'
    }],
    ['named datasets', (spec) => {
      spec.datasets = { evil: [{ x: 1 }] }
    }],
    ['a transform that calculates', (spec) => {
      spec.transform = [{ calculate: 'alert(document.cookie)', as: 'x' }]
    }],
    ['a transform that filters by an expression', (spec) => {
      spec.transform = [{ filter: 'datum.y > 0' }]
    }],
    ['params with an expression', (spec) => {
      spec.params = [{ name: 'p', expr: 'alert(1)' }]
    }],
    ['a selection', (spec) => {
      spec.selection = { s: { type: 'single' } }
    }],
    ['signals', (spec) => {
      spec.signals = [{ name: 's', on: [{ events: 'mousemove', update: 'alert(1)' }] }]
    }],
    ['a layer of other marks', (spec) => {
      spec.layer = [{ mark: 'text' }]
    }],
    ['a config that registers a format type', (spec) => {
      spec.config = { customFormatTypes: true }
    }],
    ['user metadata', (spec) => {
      spec.usermeta = { embedOptions: { loader: { baseURL: 'https://evil.example' } } }
    }],
    ['an HTML tooltip', (spec) => {
      (spec.mark as Record<string, unknown>).tooltip = { content: 'data' }
    }],
    ['a mark that is a link', (spec) => {
      (spec.mark as Record<string, unknown>).href = SCRIPT_LINK
    }],
    ['a mark of another type', (spec) => {
      (spec.mark as Record<string, unknown>).type = 'image'
    }],
    ['a link channel', (spec) => {
      (spec.encoding as Record<string, unknown>).href = { value: SCRIPT_LINK }
    }],
    ['a tooltip channel', (spec) => {
      (spec.encoding as Record<string, unknown>).tooltip = { field: 'x' }
    }],
    ['an axis with a label expression', (spec) => {
      ((spec.encoding as Record<string, Record<string, unknown>>).x as Record<string, unknown>).axis = { labelExpr: 'alert(1)' }
    }],
    ['a format with a custom type', (spec) => {
      ((spec.encoding as Record<string, Record<string, unknown>>).y as Record<string, unknown>).format = { formatType: 'custom' }
    }],
    ['a field that reaches into the datum', (spec) => {
      ((spec.encoding as Record<string, Record<string, unknown>>).x as Record<string, unknown>).field = 'datum.constructor'
    }],
    ['an aggregate', (spec) => {
      ((spec.encoding as Record<string, Record<string, unknown>>).y as Record<string, unknown>).aggregate = 'sum'
    }],
    ['a width that is a number', (spec) => {
      spec.width = 800
    }],
    ['a height beyond what the back end writes', (spec) => {
      spec.height = 9_000
    }],
    ['another schema', (spec) => {
      spec.$schema = 'https://evil.example/vega-lite/v5.json'
    }],
    ['an older schema', (spec) => {
      spec.$schema = 'https://vega.github.io/schema/vega-lite/v4.json'
    }],
    ['a prototype key', (spec) => {
      Object.defineProperty(spec, '__proto__', { value: { polluted: true }, enumerable: true })
    }],
    ['an extra top-level key', (spec) => {
      spec.background = 'url(https://evil.example/x.png)'
    }],
  ]

  it.each(hostile)('is refused: %s', (_, change) => {
    expect(refused(withSpec(barChart(), change))).toBe(true)
  })

  it('is refused with a reason that names where and never repeats what the spec held', () => {
    const chart = withSpec(barChart(), (spec) => {
      spec.data = { url: 'https://evil.example/secret-token-1234' }
    })
    const checked = checkChart(chart)
    expect(checked.ok).toBe(false)
    expect(!checked.ok && checked.reason).not.toContain('evil.example')
    expect(!checked.ok && checked.reason).not.toContain('secret-token')
    expect(!checked.ok && checked.reason).toMatch(/^[a-z_]+( at [\w.]+)?$/)
  })

  it('is refused when its mark is not the kind the answer says', () => {
    expect(refused({ ...barChart(), kind: 'line' })).toBe(true)
  })
})

describe('a spec whose parts do not agree', () => {
  it('is refused when a series appears with no colour channel, or a colour channel has no series', () => {
    expect(refused(withSpec(barChart(), (spec) => {
      (spec.data as { values: Record<string, unknown>[] }).values[0]!.series = 'CZ'
    }))).toBe(true)
    expect(refused(withSpec(lineChart(), (spec) => {
      delete (spec.data as { values: Record<string, unknown>[] }).values[0]!.series
    }))).toBe(true)
  })

  it('is refused when a value does not fit its axis: a date that is not a date, a quantity that is text', () => {
    expect(refused(withSpec(lineChart(), (spec) => {
      (spec.data as { values: Record<string, unknown>[] }).values[0]!.x = 'next tuesday'
    }))).toBe(true)
    expect(refused(withSpec(barChart(), (spec) => {
      (spec.data as { values: Record<string, unknown>[] }).values[0]!.y = 'a lot'
    }))).toBe(true)
  })

  it('is refused when it has more than 200 points or more than eight series', () => {
    expect(refused(withSpec(barChart(), (spec) => {
      (spec.data as { values: unknown[] }).values = Array.from({ length: 201 }, (_, index) => ({ x: `p${index}`, y: index }))
      ;((spec.encoding as Record<string, Record<string, unknown>>).x as Record<string, unknown>).sort = undefined
    }))).toBe(true)
    expect(refused(withSpec(lineChart(), (spec) => {
      (spec.data as { values: unknown[] }).values = Array.from({ length: 9 }, (_, index) => ({ x: '2025-01-01', y: index, series: `s${index}` }))
    }))).toBe(true)
  })

  it('is refused when its label order lists a label the chart does not have', () => {
    expect(refused(withSpec(barChart(), (spec) => {
      ((spec.encoding as Record<string, Record<string, unknown>>).x as Record<string, unknown>).sort = ['Basalt Blend', 'Something else']
    }))).toBe(true)
  })

  it('is refused when a title is longer than the back end writes', () => {
    expect(refused(withSpec(barChart(), (spec) => {
      ((spec.encoding as Record<string, Record<string, unknown>>).y as Record<string, unknown>).title = 'x'.repeat(61)
    }))).toBe(true)
  })

  it('has the control characters taken out of a title instead of being refused for them', () => {
    const checked = checkChart(withSpec(barChart(), (spec) => {
      ((spec.encoding as Record<string, Record<string, unknown>>).y as Record<string, unknown>).title = `revenue${String.fromCharCode(10)}in CZK`
    }))
    expect(checked.ok && checked.spec.encoding.y.title).toBe('revenue in CZK')
  })
})

describe('what a chart says in words', () => {
  it('counts its points and series, and names its highest and lowest', () => {
    const checked = checkChart(barChart())
    const facts = checked.ok ? chartFacts(checked.spec) : undefined
    expect(facts).toMatchObject({ kind: 'bar', count: 3, seriesCount: 0, xTitle: 'product', yTitle: 'revenue' })
    expect(facts?.extremes?.highest).toMatchObject({ x: 'Basalt Blend', y: 182400 })
    expect(facts?.extremes?.lowest).toMatchObject({ x: 'Kenya Nyeri', y: 96300 })
  })

  it('counts the series of a chart that has them', () => {
    const checked = checkChart(lineChart())
    expect(checked.ok && chartFacts(checked.spec).seriesCount).toBe(2)
    expect(checked.ok && chartFacts(checked.spec).seriesTitle).toBe('country')
  })

  it('has no extremes when no point has a quantity', () => {
    const checked = checkChart(withSpec(barChart(), (spec) => {
      (spec.data as { values: Record<string, unknown>[] }).values.forEach((point) => {
        point.y = null
      })
    }))
    expect(checked.ok && chartFacts(checked.spec).extremes).toBeUndefined()
  })
})
