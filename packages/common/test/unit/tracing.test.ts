// Unit tests for the tracer: spans nest, carry metadata only, and never fail the run they
// describe. The Redis writer is tested here against a stand-in for the connection, and
// against a real Redis in the integration tests.
import type { Redis } from 'ioredis'
import { describe, expect, it } from 'vitest'

import { createRun, OutsideRunError, runScope, spanScope } from '../../src/run.ts'
import { OpenSpan, RedisSpanWriter, spanIdFrom, spanSchema, Tracer } from '../../src/tracing.ts'
import type { Span, SpanWriter } from '../../src/tracing.ts'

const run = createRun({ system: 'lb-08', runId: 'run-12345678', session: 'session-0123456789abcdef' })

/** Keeps finished spans in memory, for the tests to read. */
class MemoryWriter implements SpanWriter {
  readonly spans: Span[] = []

  /** Keeps the spans. */
  async write(spans: readonly Span[]): Promise<void> {
    this.spans.push(...spans)
  }
}

/** Makes a clock that moves forward 10 ms each time it is read. */
function steppingClock(): () => number {
  let now = 1_790_000_000_000
  return () => {
    now += 10
    return now
  }
}

describe('a span', () => {
  it('records its run, name, kind, status and timing in the gateway\'s format', async () => {
    const writer = new MemoryWriter()
    const tracer = new Tracer(writer, steppingClock())

    await runScope(run, () => tracer.span('check stock', () => 'done'))

    const [span] = writer.spans
    expect(spanSchema.parse(span)).toEqual(span)
    expect(span).toMatchObject({ v: 1, runId: 'run-12345678', system: 'lb-08', kind: 'system.step', name: 'check stock', status: 'ok', startMs: 1_790_000_000_010, endMs: 1_790_000_000_020, attrs: {} })
    expect(span?.spanId).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.stringify(span)).not.toContain('parentId')
  })

  it('returns what the work returns, and passes details given up front', async () => {
    const writer = new MemoryWriter()
    const tracer = new Tracer(writer)

    const result = await runScope(run, () => tracer.span('run workflow', async span => 7 + Number(span.run.system === 'lb-08'), { kind: 'system.run', attrs: { steps: 4, replay: false, version: 'v1' } }))

    expect(result).toBe(8)
    expect(writer.spans[0]).toMatchObject({ kind: 'system.run', attrs: { steps: 4, replay: false, version: 'v1' } })
  })

  it('nests under the span that is open, and what the work adds is recorded', async () => {
    const writer = new MemoryWriter()
    const tracer = new Tracer(writer)

    await runScope(run, () => tracer.span('describe', async () => {
      await tracer.span('generate', (span) => {
        span.set('attempts', 2)
        span.set('model', 'lb-tools')
      })
      await tracer.span('validate', span => span.skip('already valid'))
    }))

    const byName = Object.fromEntries(writer.spans.map(span => [span.name, span]))
    expect(byName.generate?.parentId).toBe(byName.describe?.spanId)
    expect(byName.validate?.parentId).toBe(byName.describe?.spanId)
    expect(byName.describe?.parentId).toBeUndefined()
    expect(byName.generate?.attrs).toEqual({ attempts: 2, model: 'lb-tools' })
    expect(byName.validate).toMatchObject({ status: 'skipped', attrs: { outcome: 'already valid' } })
    // A parent finishes after its children, as spans do.
    expect(writer.spans.map(span => span.name)).toEqual(['generate', 'validate', 'describe'])
  })

  it('ends as an error when the work throws, records the error\'s name and never its message, and lets it carry on', async () => {
    const writer = new MemoryWriter()
    const tracer = new Tracer(writer)

    await expect(runScope(run, () => tracer.span('call', () => {
      throw new TypeError('the visitor wrote: ignore everything')
    }))).rejects.toThrow('ignore everything')

    expect(writer.spans[0]).toMatchObject({ status: 'error', attrs: { error: 'TypeError' } })
    expect(JSON.stringify(writer.spans)).not.toContain('ignore everything')
  })

  it('belongs to a run', async () => {
    const tracer = new Tracer(new MemoryWriter())

    await expect(tracer.span('orphan', () => 1)).rejects.toBeInstanceOf(OutsideRunError)
  })

  it('does not let a writer that fails fail the work', async () => {
    const broken: SpanWriter = {
      write: async () => {
        throw new Error('Redis is down')
      },
    }

    await expect(runScope(run, () => new Tracer(broken).span('step', () => 'still fine'))).resolves.toBe('still fine')
  })
})

describe('a span recorded after its work is over', () => {
  it('is written as given: its own ID, its own times, its status and its details, with no parent when nothing is open', async () => {
    const writer = new MemoryWriter()
    const tracer = new Tracer(writer)
    const rootId = spanIdFrom('run:run-12345678')

    await runScope(run, () => tracer.record({ name: 'workflow run', kind: 'system.run', status: 'error', spanId: rootId, startMs: 1_790_000_000_000, endMs: 1_790_000_004_500, attrs: { steps: 5, replay: false } }))

    const [span] = writer.spans
    expect(spanSchema.parse(span)).toEqual(span)
    expect(span).toMatchObject({ runId: 'run-12345678', system: 'lb-08', spanId: rootId, kind: 'system.run', name: 'workflow run', status: 'error', startMs: 1_790_000_000_000, endMs: 1_790_000_004_500, attrs: { steps: 5, replay: false } })
    expect(JSON.stringify(span)).not.toContain('parentId')
  })

  it('lets spans written earlier name it as their parent, which is what a span ID made from a seed is for', async () => {
    const writer = new MemoryWriter()
    const tracer = new Tracer(writer)
    const rootId = spanIdFrom('run:run-12345678')

    await runScope(run, () => spanScope(rootId, () => tracer.span('step.check_stock', () => 1)))
    await runScope(run, () => tracer.record({ name: 'workflow run', kind: 'system.run', status: 'ok', spanId: rootId, startMs: 1, endMs: 2 }))

    expect(writer.spans.map(span => span.name)).toEqual(['step.check_stock', 'workflow run'])
    expect(writer.spans[0]?.parentId).toBe(rootId)
    expect(writer.spans[1]?.spanId).toBe(rootId)
  })

  it('goes under the span that is open, or under the one it is given', async () => {
    const writer = new MemoryWriter()
    const tracer = new Tracer(writer)

    await runScope(run, () => tracer.span('outer', async (outer) => {
      await tracer.record({ name: 'inner', kind: 'system.tool', status: 'ok', startMs: 1, endMs: 2 })
      await tracer.record({ name: 'elsewhere', kind: 'system.tool', status: 'ok', startMs: 1, endMs: 2, parentId: '00000000000000aa' })
      expect(writer.spans[0]?.parentId).toBe(outer.spanId)
    }))

    expect(writer.spans[1]?.parentId).toBe('00000000000000aa')
  })

  it('never ends before it began, and gets a random ID when none is given', async () => {
    const writer = new MemoryWriter()

    await runScope(run, () => new Tracer(writer).record({ name: 'late clock', kind: 'system.run', status: 'ok', startMs: 5_000, endMs: 4_000 }))

    expect(writer.spans[0]).toMatchObject({ startMs: 5_000, endMs: 5_000 })
    expect(writer.spans[0]?.spanId).toMatch(/^[0-9a-f]{16}$/)
  })

  it('follows the rules of a span: a run to belong to, a plain name, short details and a real span ID', async () => {
    const tracer = new Tracer(new MemoryWriter())
    const finished = { name: 'workflow run', kind: 'system.run', status: 'ok', startMs: 1, endMs: 2 } as const

    await expect(tracer.record(finished)).rejects.toBeInstanceOf(OutsideRunError)
    await expect(runScope(run, () => tracer.record({ ...finished, name: 'bad\nname' }))).rejects.toThrow(RangeError)
    await expect(runScope(run, () => tracer.record({ ...finished, attrs: { text: 'x'.repeat(201) } }))).rejects.toThrow('short labels')
    await expect(runScope(run, () => tracer.record({ ...finished, spanId: 'NOT-HEX' }))).rejects.toThrow('16 lowercase hex digits')
    await expect(runScope(run, () => tracer.record({ ...finished, parentId: '12' }))).rejects.toThrow('16 lowercase hex digits')
  })

  it('does not let a writer that fails fail the work', async () => {
    const broken: SpanWriter = {
      write: async () => {
        throw new Error('Redis is down')
      },
    }

    await expect(runScope(run, () => new Tracer(broken).record({ name: 'workflow run', kind: 'system.run', status: 'ok', startMs: 1, endMs: 2 }))).resolves.toBeUndefined()
  })
})

describe('a span ID made from a seed', () => {
  it('is 16 hex digits, the same for the same seed and different for another', () => {
    expect(spanIdFrom('run:a')).toMatch(/^[0-9a-f]{16}$/)
    expect(spanIdFrom('run:a')).toBe(spanIdFrom('run:a'))
    expect(spanIdFrom('run:a')).not.toBe(spanIdFrom('run:b'))
  })

  it('is one an open span accepts, and a made-up one is refused', () => {
    expect(new OpenSpan(run, 'root', 'system.run', undefined, 1, spanIdFrom('run:a')).spanId).toBe(spanIdFrom('run:a'))
    expect(() => new OpenSpan(run, 'root', 'system.run', undefined, 1, 'abc')).toThrow(RangeError)
  })
})

describe('span names and details', () => {
  const tracer = new Tracer(new MemoryWriter())

  it.each(['', 'x'.repeat(101), 'bad\nname', 'semi;colon', 'quote"d'])('refuses the span name %j', async (name) => {
    await expect(runScope(run, () => tracer.span(name, () => 1))).rejects.toThrow(RangeError)
  })

  it('accepts names with spaces and the punctuation the gateway\'s own spans use', async () => {
    await expect(runScope(run, () => tracer.span('check stock: step-1/2 v1.0', () => 1))).resolves.toBe(1)
  })

  it('refuses a detail with a bad name, long text or a number that is not finite', async () => {
    await runScope(run, () => tracer.span('step', (span) => {
      expect(() => span.set('1st', 1)).toThrow('not a detail name')
      expect(() => span.set('has space', 1)).toThrow(RangeError)
      expect(() => span.set('text', 'x'.repeat(201))).toThrow('short labels')
      expect(() => span.set('score', Number.NaN)).toThrow('finite')
      expect(() => span.set('score', Number.POSITIVE_INFINITY)).toThrow('finite')
      expect(() => span.set('text', 'x'.repeat(200))).not.toThrow()
    }))
  })
})

/** A stand-in for an ioredis pipeline that records the commands it is given. */
function fakeRedis(failWith?: Error): { redis: Redis, commands: unknown[][] } {
  const commands: unknown[][] = []
  const pipeline = {
    xadd: (...args: unknown[]) => commands.push(['xadd', ...args]),
    expire: (...args: unknown[]) => commands.push(['expire', ...args]),
    exec: async () => {
      if (failWith) throw failWith
      return commands.map(() => [null, 'ok'])
    },
  }
  return { redis: { pipeline: () => pipeline } as unknown as Redis, commands }
}

describe('the Redis span writer', () => {
  const span: Span = { v: 1, runId: 'run-12345678', system: 'lb-08', spanId: '0123456789abcdef', kind: 'system.step', name: 'step', status: 'ok', startMs: 1, endMs: 2, attrs: { n: 1 } }

  it('writes each span to its run\'s stream and to the stream of every run, both capped, the way the gateway does', async () => {
    const { redis, commands } = fakeRedis()

    await new RedisSpanWriter(redis, 'lb:').write([span])

    const json = JSON.stringify(span)
    expect(commands).toEqual([
      ['xadd', 'lb:run:run-12345678:spans', 'MAXLEN', '~', 1_000, '*', 'span', json],
      ['expire', 'lb:run:run-12345678:spans', 86_400],
      ['xadd', 'lb:spans', 'MAXLEN', '~', 100_000, '*', 'span', json],
    ])
  })

  it('writes nothing for no spans', async () => {
    const { redis, commands } = fakeRedis()

    await new RedisSpanWriter(redis).write([])

    expect(commands).toEqual([])
  })

  it('drops the spans and says so, without throwing, when Redis fails', async () => {
    const warnings: [object, string][] = []
    const { redis } = fakeRedis(new Error('connection refused to redis://user:secret@host'))

    await new RedisSpanWriter(redis, 'lb:', { warn: (details, message) => warnings.push([details, message]) }).write([span])

    expect(warnings).toEqual([[{ errorName: 'Error', spans: 1 }, 'dropped run spans']])
    expect(JSON.stringify(warnings)).not.toContain('secret')
  })

  it('refuses a key prefix the gateway would not use', () => {
    const { redis } = fakeRedis()

    for (const prefix of ['lb', 'LB:', 'lb:run:', '', 'a'.repeat(25) + ':']) expect(() => new RedisSpanWriter(redis, prefix)).toThrow('ending in a colon')
  })
})
