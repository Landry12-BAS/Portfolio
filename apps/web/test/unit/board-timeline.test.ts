// Unit tests for the Scope's timeline: nesting, order, the bar geometry, and a run that is
// still going (its steps arrive before the root span that holds them).
import type { Span } from '@lb/contracts'
import { mockSpans } from '@lb/api-clients/testing'
import { describe, expect, it } from 'vitest'

import { buildTimeline, kindOf } from '~/board-kit/timeline'

const RUN = 'run-0123456789abcdef'

/** A mock run of a ticket that gets a cited draft, as the gateway's stream holds it. */
function draftRun(): Span[] {
  return mockSpans(RUN, 1_000_000, undefined, 3) as Span[]
}

/** Makes one span with the fields a test cares about. */
function span(fields: Partial<Span> & Pick<Span, 'spanId' | 'startMs' | 'endMs'>): Span {
  return { v: 1, runId: RUN, system: 'lb-01', kind: 'system.step', name: 'step', status: 'ok', attrs: {}, ...fields }
}

describe('buildTimeline', () => {
  it('puts the run first and nests steps, model calls and attempts under their parents', () => {
    const timeline = buildTimeline(draftRun())
    const first = timeline.rows[0]
    expect(first?.span.name).toBe('support ticket')
    expect(first?.depth).toBe(0)
    expect(timeline.open).toBe(false)
    const depthByName = new Map(timeline.rows.map(row => [row.span.name, row.depth]))
    expect(depthByName.get('redact PII')).toBe(1)
    expect(depthByName.get('lb-guard')).toBe(2)
    expect(depthByName.get('groq/llama-prompt-guard-2-86m')).toBe(3)
  })

  it('orders siblings by when they started and puts a child right after its parent', () => {
    const names = buildTimeline(draftRun()).rows.map(row => row.span.name)
    expect(names.slice(0, 6)).toEqual(['support ticket', 'redact PII', 'screen for injection', 'lb-guard', 'groq/llama-prompt-guard-2-86m', 'classify'])
    expect(names.at(-1)).toBe('route')
  })

  it('measures each row from the start of the run', () => {
    const timeline = buildTimeline(draftRun())
    expect(timeline.totalMs).toBe(2_675)
    const classify = timeline.rows.find(row => row.span.name === 'classify')
    expect(classify?.offsetMs).toBe(190)
    expect(classify?.durationMs).toBe(530)
    expect(classify?.left).toBeCloseTo(190 / 2_675, 5)
    expect(classify?.width).toBeCloseTo(530 / 2_675, 5)
  })

  it('reads a model call\'s alias, provider, model and tokens, and names the parent of each row', () => {
    const timeline = buildTimeline(draftRun())
    const call = timeline.rows.find(row => row.span.name === 'lb-fast')
    expect(call).toMatchObject({ kind: 'model', alias: 'lb-fast', provider: 'groq', model: 'groq/gpt-oss-20b', inputTokens: 410, parentName: 'classify' })
    expect(call?.outputTokens).toBe(51)
    expect(timeline.rows[0]?.parentName).toBeUndefined()
  })

  it('counts what the run came to', () => {
    const { summary } = buildTimeline(draftRun())
    expect(summary).toEqual({ steps: 9, modelCalls: 5, durationMs: 2_675 })
  })

  it('shows steps at the top level while the root span has not arrived, and says the run is open', () => {
    const withoutRoot = draftRun().filter(item => item.kind !== 'system.run')
    const timeline = buildTimeline(withoutRoot)
    expect(timeline.open).toBe(true)
    const steps = timeline.rows.filter(row => row.kind === 'step' || row.kind === 'tool')
    expect(steps.every(row => row.depth === 0)).toBe(true)
    expect(timeline.totalMs).toBe(2_670)
  })

  it('is an open, empty timeline for no spans', () => {
    expect(buildTimeline([])).toEqual({ rows: [], totalMs: 0, summary: { steps: 0, modelCalls: 0, durationMs: 0 }, open: true })
  })

  it('keeps a bar visible for a span that took no time, even at the very end', () => {
    const run = [
      span({ spanId: '0000000000000001', kind: 'system.run', name: 'run', startMs: 0, endMs: 100 }),
      span({ spanId: '0000000000000002', parentId: '0000000000000001', startMs: 100, endMs: 100, name: 'last' }),
    ]
    const last = buildTimeline(run).rows.find(row => row.span.name === 'last')
    expect(last?.width).toBeGreaterThan(0)
    expect((last?.left ?? 0) + (last?.width ?? 0)).toBeLessThanOrEqual(1)
  })

  it('does not lose spans whose parents point at each other', () => {
    const loop = [
      span({ spanId: '000000000000000a', parentId: '000000000000000b', startMs: 0, endMs: 5, name: 'a' }),
      span({ spanId: '000000000000000b', parentId: '000000000000000a', startMs: 1, endMs: 4, name: 'b' }),
    ]
    expect(buildTimeline(loop).rows.map(row => row.span.name).sort()).toEqual(['a', 'b'])
  })

  it('does not scale a run that took no time by zero', () => {
    const instant = [span({ spanId: '0000000000000001', kind: 'system.run', name: 'run', startMs: 50, endMs: 50 })]
    const [row] = buildTimeline(instant).rows
    expect(row?.left).toBe(0)
    expect(row?.width).toBeGreaterThan(0)
  })
})

describe('kindOf', () => {
  it('maps the gateway\'s kinds to the legend\'s', () => {
    const kinds = ['system.run', 'system.step', 'system.tool', 'gateway.call', 'gateway.attempt', 'other.thing']
    expect(kinds.map(kind => kindOf(span({ spanId: '0000000000000001', startMs: 0, endMs: 1, kind })))).toEqual(['run', 'step', 'tool', 'model', 'attempt', 'other'])
  })
})
