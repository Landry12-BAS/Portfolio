// Tests for what the site shows of any system: the platform's error body, a run's spans and
// pages of them, and the recording of a curated sample. The span schema here and the gateway's
// own accept and refuse the same spans, so the browser and the route that feeds it agree.
import { describe, expect, it } from 'vitest'

import { isShowable, platformErrorSchema, recordingSchema, spanSchema, summariseTrace, tracePageSchema } from '../src/index.ts'
import type { Recording, Span } from '../src/index.ts'
import { spanSchema as gatewaySpanSchema } from '../../../services/gateway/src/spans.ts'

const RUN = 'run-0123456789'

/** Makes a valid span with any field replaced. */
function span(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    runId: RUN,
    system: 'lb-01',
    spanId: '00000000000000a1',
    kind: 'system.step',
    name: 'hybrid search',
    status: 'ok',
    startMs: 1_790_000_000_000,
    endMs: 1_790_000_000_020,
    attrs: { chunks: 6, reranked: true, model: 'groq/gpt-oss-120b' },
    ...overrides,
  }
}

/** Makes the spans of a small run: a root, a step under it, and a model call under the step. */
function run(): Span[] {
  return [
    span({ spanId: '00000000000000b2', parentId: '00000000000000b1', kind: 'gateway.call', name: 'lb-fast', startMs: 1_790_000_000_010, endMs: 1_790_000_000_300 }),
    span({ spanId: '00000000000000b1', parentId: '00000000000000b0', name: 'classify', startMs: 1_790_000_000_005, endMs: 1_790_000_000_320 }),
    span({ spanId: '00000000000000b0', kind: 'system.run', name: 'support ticket', startMs: 1_790_000_000_000, endMs: 1_790_000_000_400 }),
  ].map(item => spanSchema.parse(item))
}

describe('a span', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['an extra field', { prompt: 'my words' }],
    ['a long detail', { attrs: { note: 'x'.repeat(201) } }],
    ['a nested detail', { attrs: { nested: { a: 1 } } }],
    ['a bad detail name', { attrs: { 'bad name': 1 } }],
    ['a short run ID', { runId: 'short' }],
    ['a system in capitals', { system: 'LB-01' }],
    ['a span ID that is not hex', { spanId: 'xyz' }],
    ['a name with a line break', { name: 'a\nb' }],
    ['a name that is too long', { name: 'a'.repeat(101) }],
    ['a kind without a dot', { kind: 'system' }],
    ['an unknown status', { status: 'done' }],
    ['a fractional time', { startMs: 1.5 }],
    ['a negative time', { endMs: -1 }],
    ['another version', { v: 2 }],
    ['a null parent', { parentId: null }],
  ]

  it('is accepted when it is what the writers produce, and carries nothing but metadata', () => {
    expect(spanSchema.parse(span())).toMatchObject({ name: 'hybrid search', attrs: { chunks: 6 } })
    expect(spanSchema.parse(span({ kind: 'gateway.attempt', parentId: '00000000000000b2', name: 'groq/gpt-oss-120b' }))).toBeDefined()
  })

  it.each(cases)('is refused with %s', (_name, overrides) => {
    expect(spanSchema.safeParse(span(overrides)).success).toBe(false)
  })

  it('is accepted or refused exactly as the gateway accepts or refuses it', () => {
    for (const [, overrides] of [['valid', {}] as [string, Record<string, unknown>], ...cases, ['at the limit', { attrs: { note: 'x'.repeat(200) } }] as [string, Record<string, unknown>]]) {
      const candidate = span(overrides)
      expect(spanSchema.safeParse(candidate).success, JSON.stringify(overrides)).toBe(gatewaySpanSchema.safeParse(candidate).success)
    }
  })
})

describe('a page of a trace', () => {
  const page = { runId: RUN, spans: run(), cursor: '1790000000400-2', more: false, finished: true }

  it('is accepted as the route sends it', () => {
    expect(tracePageSchema.parse(page).spans).toHaveLength(3)
  })

  it('is refused with a field nobody planned for, a bad cursor, too many spans or an invalid span', () => {
    expect(tracePageSchema.safeParse({ ...page, extra: 1 }).success).toBe(false)
    expect(tracePageSchema.safeParse({ ...page, cursor: 'abc' }).success).toBe(false)
    expect(tracePageSchema.safeParse({ ...page, spans: Array.from({ length: 501 }, () => run()[0]) }).success).toBe(false)
    expect(tracePageSchema.safeParse({ ...page, spans: [{ ...run()[0], prompt: 'x' }] }).success).toBe(false)
  })
})

describe('what a trace comes to', () => {
  it('counts the steps, the model calls and the time of the root span', () => {
    expect(summariseTrace(run())).toEqual({ steps: 1, modelCalls: 1, durationMs: 400 })
  })

  it('takes the first start to the last end when there is no root yet', () => {
    expect(summariseTrace(run().slice(0, 2))).toEqual({ steps: 1, modelCalls: 1, durationMs: 315 })
  })

  it('comes to nothing for no spans', () => {
    expect(summariseTrace([])).toEqual({ steps: 0, modelCalls: 0, durationMs: 0 })
  })
})

describe('a recording', () => {
  /** Makes a valid recording of a sample, with any part replaced. */
  function recording(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      v: 1,
      system: 'lb-01',
      sample: 'torn-bag',
      origin: 'live',
      recordedAt: '2026-10-04T09:30:00Z',
      language: 'en',
      exchanges: [
        { request: { method: 'POST', path: '/api/lb01/tickets', body: { customer: 'cus-0001', language: 'en', body: 'Hello' } }, response: { status: 202, body: { status: 'received' } } },
        { request: { method: 'GET', path: '/api/lb01/tickets/tk1' }, response: { status: 200, body: { status: 'awaiting_approval' } } },
      ],
      trace: { runId: RUN, spans: run() },
      stats: { modelCalls: 1, steps: 1, durationMs: 400 },
      ...overrides,
    }
  }

  it('is accepted, and only a live one may be shown to a visitor', () => {
    const live = recordingSchema.parse(recording()) satisfies Recording
    const mock = recordingSchema.parse(recording({ origin: 'mock' }))

    expect(isShowable(live)).toBe(true)
    expect(isShowable(mock)).toBe(false)
  })

  it('is refused when it is not shaped like one', () => {
    const bad: Record<string, unknown>[] = [
      { v: 2 },
      { system: 'lb-1' },
      { sample: 'Torn Bag' },
      { origin: 'invented' },
      { recordedAt: 'yesterday' },
      { language: 'de' },
      { exchanges: [] },
      { exchanges: [{ request: { method: 'PATCH', path: '/api/lb01/tickets' }, response: { status: 200 } }] },
      { exchanges: [{ request: { method: 'GET', path: '/etc/passwd' }, response: { status: 200 } }] },
      { exchanges: [{ request: { method: 'GET', path: '/api/lb01/tickets' }, response: { status: 200, body: undefined, extra: 1 } }] },
      { trace: { runId: RUN, spans: [] } },
      { extra: 'field' },
    ]
    for (const overrides of bad) expect(recordingSchema.safeParse(recording(overrides)).success, JSON.stringify(overrides).slice(0, 60)).toBe(false)
  })

  it('is refused when its spans are another run\'s or another system\'s, or its stats are not what the trace comes to', () => {
    expect(recordingSchema.safeParse(recording({ trace: { runId: 'run-9999999999', spans: run() } })).success).toBe(false)
    expect(recordingSchema.safeParse(recording({ system: 'lb-05' })).success).toBe(false)
    expect(recordingSchema.safeParse(recording({ stats: { modelCalls: 5, steps: 1, durationMs: 400 } })).success).toBe(false)
    expect(recordingSchema.safeParse(recording({ stats: { modelCalls: 1, steps: 1, durationMs: 401 } })).success).toBe(false)
  })
})

describe('the platform error', () => {
  it('keeps what a back end adds for a case and drops the rest', () => {
    const parsed = platformErrorSchema.parse({ error: { code: 'daily_limit', message: 'Come back tomorrow.', resets_at: '2026-10-06T00:00:00Z', fields: null, trace: 'Traceback (most recent call last)', server: 'db-1' }, debug: true })

    expect(parsed).toEqual({ error: { code: 'daily_limit', message: 'Come back tomorrow.', resets_at: '2026-10-06T00:00:00Z', fields: null } })
  })

  it('refuses an answer that is not the platform\'s shape', () => {
    for (const body of [{}, { error: 'text' }, { error: { code: '', message: 'x' } }, { error: { code: 'x' } }, { error: { code: 'x', message: 'y'.repeat(501) } }, 'nope', null, []]) {
      expect(platformErrorSchema.safeParse(body).success, JSON.stringify(body)).toBe(false)
    }
  })
})
