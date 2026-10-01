// Integration tests for the Redis span writer, against a real Redis: what it writes, where,
// with which caps, and that an outage costs spans but never a run.
import { randomBytes } from 'node:crypto'

import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { createRun, newRunId, runScope } from '../../src/run.ts'
import { RedisSpanWriter, spanSchema, Tracer } from '../../src/tracing.ts'

const prefix = `lbtest-${randomBytes(6).toString('hex')}:`
let redis: Redis

beforeAll(async () => {
  redis = new Redis(inject('redisUrl'), { enableOfflineQueue: false, maxRetriesPerRequest: 1, lazyConnect: true })
  await redis.connect()
})

afterAll(async () => {
  const keys = await redis.keys(`${prefix}*`)
  if (keys.length > 0) await redis.del(...keys)
  redis.disconnect()
})

describe('the Redis span writer', () => {
  it('writes a span to its run\'s stream and to the stream of every run, and gives the run\'s stream a day to live', async () => {
    const run = createRun({ system: 'lb-08', runId: newRunId(), session: 'session-0123456789abcdef' })
    const tracer = new Tracer(new RedisSpanWriter(redis, prefix))

    await runScope(run, () => tracer.span('check stock', (span) => {
      span.set('found', true)
    }))

    const [entry] = await redis.xrange(`${prefix}run:${run.runId}:spans`, '-', '+')
    const span = spanSchema.parse(JSON.parse(entry?.[1][1] ?? '{}'))
    expect(span).toMatchObject({ name: 'check stock', attrs: { found: true } })
    const everyRun = await redis.xrange(`${prefix}spans`, '-', '+')
    expect(everyRun.some(([, entry]) => (entry[1] ?? '').includes(run.runId))).toBe(true)
    expect(await redis.ttl(`${prefix}run:${run.runId}:spans`)).toBeGreaterThan(86_000)
  })

  it('keeps a run\'s spans in the order they finished', async () => {
    const run = createRun({ system: 'lb-08', runId: newRunId(), session: 'session-0123456789abcdef' })
    const tracer = new Tracer(new RedisSpanWriter(redis, prefix))

    await runScope(run, () => tracer.span('outer', async () => {
      await tracer.span('first', () => 1)
      await tracer.span('second', () => 2)
    }))

    const names = (await redis.xrange(`${prefix}run:${run.runId}:spans`, '-', '+')).map(([, fields]) => (JSON.parse(fields[1] ?? '{}') as { name: string }).name)
    expect(names).toEqual(['first', 'second', 'outer'])
  })

  it('costs the spans and not the run when Redis is unreachable', async () => {
    const warnings: object[] = []
    const down = new Redis('redis://127.0.0.1:1', { enableOfflineQueue: false, maxRetriesPerRequest: 0, lazyConnect: true, retryStrategy: () => null })
    down.on('error', () => {})
    const run = createRun({ system: 'lb-08', runId: newRunId(), session: 'session-0123456789abcdef' })
    const tracer = new Tracer(new RedisSpanWriter(down, prefix, { warn: details => warnings.push(details) }))

    const result = await runScope(run, () => tracer.span('step', () => 'the work still finishes'))

    expect(result).toBe('the work still finishes')
    expect(warnings).toHaveLength(1)
    down.disconnect()
  })
})
