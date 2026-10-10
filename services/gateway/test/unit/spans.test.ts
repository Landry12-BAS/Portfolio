// Unit tests for reading a span back from a stream entry: only a strict, small, metadata-only
// span gets through, and the root of a run is told apart from a nested whole-run span.
import { describe, expect, it } from 'vitest'

import { isRunRoot, parseSpanEntry } from '../../src/spans.ts'

/** A valid span as the writers produce it, with any field replaced. */
function span(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    runId: 'run-0123456789',
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

/** Wraps a span the way the writers put it in a stream: the field name, then its JSON. */
function entry(value: unknown): string[] {
  return ['span', typeof value === 'string' ? value : JSON.stringify(value)]
}

describe('reading a span from a stream entry', () => {
  it('accepts what the gateway and the systems write', () => {
    expect(parseSpanEntry(entry(span()))).toMatchObject({ name: 'hybrid search', attrs: { chunks: 6 } })
    expect(parseSpanEntry(entry(span({ kind: 'gateway.attempt', name: 'groq/gpt-oss-120b', parentId: '00000000000000b2' })))).toBeDefined()
  })

  it('finds the span among other fields, and refuses an entry without one', () => {
    expect(parseSpanEntry(['other', 'x', ...entry(span())])).toBeDefined()
    expect(parseSpanEntry(['other', 'x'])).toBeUndefined()
    expect(parseSpanEntry([])).toBeUndefined()
  })

  it('refuses what is not a span', () => {
    for (const bad of ['', 'not json', '[]', 'null', '42', '{}', '"text"']) expect(parseSpanEntry(entry(bad)), bad).toBeUndefined()
  })

  it('refuses a field nobody planned for, whatever it holds', () => {
    expect(parseSpanEntry(entry(span({ prompt: 'my words' })))).toBeUndefined()
    expect(parseSpanEntry(entry(span({ messages: [{ role: 'user', content: 'my words' }] })))).toBeUndefined()
  })

  it('refuses a detail that is not a short label, a number or a flag', () => {
    for (const attrs of [{ text: 'x'.repeat(201) }, { nested: { a: 1 } }, { list: [1] }, { empty: null }, { 'bad name': 1 }, { '': 1 }]) {
      expect(parseSpanEntry(entry(span({ attrs }))), JSON.stringify(attrs).slice(0, 40)).toBeUndefined()
    }
    expect(parseSpanEntry(entry(span({ attrs: { text: 'x'.repeat(200) } })))).toBeDefined()
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`d${index}`, index]))
    expect(parseSpanEntry(entry(span({ attrs: many })))).toBeUndefined()
  })

  it('refuses identifiers, names and kinds of the wrong shape', () => {
    for (const bad of [{ runId: 'short' }, { system: 'LB-01' }, { spanId: 'xyz' }, { parentId: 'not hex' }, { name: '' }, { name: 'line\nbreak' }, { name: 'a'.repeat(101) }, { kind: 'system' }, { kind: 'System.Step' }, { status: 'done' }, { startMs: 1.5 }, { endMs: -1 }, { v: 2 }]) {
      expect(parseSpanEntry(entry(span(bad))), JSON.stringify(bad)).toBeUndefined()
    }
  })

  it('refuses an entry too big to be metadata, before it parses it', () => {
    const big = JSON.stringify(span({ attrs: Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`d${index}`, 'x'.repeat(200)])) }))

    expect(big.length).toBeGreaterThan(8_192)
    expect(parseSpanEntry(entry(big))).toBeUndefined()
  })
})

describe('the root of a run', () => {
  it('is the whole-run span without a parent', () => {
    expect(isRunRoot(parseSpanEntry(entry(span({ kind: 'system.run', name: 'support ticket' })))!)).toBe(true)
  })

  it('is not a step, a tool, a gateway span, or a whole-run span nested in another', () => {
    for (const overrides of [{ kind: 'system.step' }, { kind: 'system.tool' }, { kind: 'gateway.call' }, { kind: 'system.run', parentId: '00000000000000b2' }]) {
      expect(isRunRoot(parseSpanEntry(entry(span(overrides)))!), JSON.stringify(overrides)).toBe(false)
    }
  })
})
