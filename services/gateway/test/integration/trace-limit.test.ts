// Integration tests for how often one run's trace may be read (GET /v1/runs/{runId}/spans), on a real
// Redis. The route needs no visitor, and a full page costs the gateway about 10 ms of CPU, so a flood of
// reads of one run must not get past a bucket of reads that refills at a steady rate. The clock stands
// still unless the test moves it, so the counts are exact.
import { randomBytes } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TRACE_READ_LIMIT } from '../../src/read-limit.ts'
import { RedisSpanSink } from '../../src/spans.ts'
import type { Span } from '../../src/spans.ts'
import { startGateway } from '../support/gateway.ts'
import type { TestGateway } from '../support/gateway.ts'

const START = 1_790_000_000_000

let gw: TestGateway
let sink: RedisSpanSink

beforeEach(async () => {
  gw = await startGateway({ frozenClock: true })
  sink = new RedisSpanSink(gw.redis, gw.prefix, { warn: () => undefined })
})

afterEach(async () => {
  await gw.close()
})

/** Makes a run ID of the right shape that no other test uses. */
function newRunId(): string {
  return `run-${randomBytes(6).toString('hex')}`
}

/** Asks for a run's spans as `service` (the site's server by default). `query` is the text after the `?`. */
async function readSpans(runId: string, query = '', service = 'web') {
  const url = `/v1/runs/${encodeURIComponent(runId)}/spans${query === '' ? '' : `?${query}`}`
  return gw.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${await gw.token(service)}` } })
}

/** Builds a valid span of a run, number `index`. */
function systemSpan(runId: string, index: number): Span {
  return {
    v: 1,
    runId,
    system: 'lb-01',
    spanId: index.toString(16).padStart(16, '0'),
    parentId: undefined,
    kind: 'system.step',
    name: `step ${index}`,
    status: 'ok',
    startMs: START + index * 10,
    endMs: START + index * 10 + 5,
    attrs: { chunks: index },
  }
}

describe('how often a run may be read', () => {
  it('lets a run be read in a burst, then answers 429 for the rest of a flood, and does not read for those', async () => {
    const runId = newRunId()
    await sink.emit([systemSpan(runId, 1)])
    const reads = TRACE_READ_LIMIT.burst + 30

    const statuses: number[] = []
    for (let read = 0; read < reads; read += 1) statuses.push((await readSpans(runId)).statusCode)

    // Only the burst got through; however long the flood goes on, no more than that reads a trace.
    expect(statuses.filter(status => status === 200)).toHaveLength(TRACE_READ_LIMIT.burst)
    expect(statuses.filter(status => status === 429)).toHaveLength(30)
    expect(statuses.slice(0, TRACE_READ_LIMIT.burst).every(status => status === 200)).toBe(true)
  })

  it('says it is too often in the platform\'s error shape, and how long to wait', async () => {
    const runId = newRunId()
    for (let read = 0; read < TRACE_READ_LIMIT.burst; read += 1) await readSpans(runId)

    const refused = await readSpans(runId)

    expect(refused.statusCode).toBe(429)
    expect(refused.json()).toEqual({ error: { message: expect.any(String), type: 'rate_limit_error', code: 'rate_limited' } })
    expect(refused.headers['retry-after']).toBe('1')
    expect(refused.headers['cache-control']).toBe('no-store')
    expect(refused.body).not.toContain(runId)
  })

  it('lets reads back at the steady rate, and each run is counted on its own', async () => {
    const busy = newRunId()
    const quiet = newRunId()
    await sink.emit([systemSpan(busy, 1), systemSpan(quiet, 1)])
    for (let read = 0; read < TRACE_READ_LIMIT.burst; read += 1) await readSpans(busy)
    expect((await readSpans(busy)).statusCode).toBe(429)

    expect((await readSpans(quiet)).statusCode).toBe(200)
    gw.advance(1_000)
    const afterASecond: number[] = []
    for (let read = 0; read < TRACE_READ_LIMIT.perSecond + 2; read += 1) afterASecond.push((await readSpans(busy)).statusCode)

    expect(afterASecond.filter(status => status === 200)).toHaveLength(TRACE_READ_LIMIT.perSecond)
    expect(afterASecond.at(-1)).toBe(429)
  })

  it('never refuses a Scope that polls at its own pace, a read every 600 milliseconds for a minute and a half', async () => {
    const runId = newRunId()
    await sink.emit([systemSpan(runId, 1)])

    for (let poll = 0; poll < 150; poll += 1) {
      expect((await readSpans(runId, 'limit=200')).statusCode, `poll ${poll}`).toBe(200)
      gw.advance(600)
    }
  })

  it('does not count a request that is refused for something else: another service, a bad run ID or a bad query', async () => {
    const runId = newRunId()
    await sink.emit([systemSpan(runId, 1)])

    for (let attempt = 0; attempt < TRACE_READ_LIMIT.burst * 2; attempt += 1) {
      expect((await readSpans(runId, '', 'django-systems')).statusCode).toBe(403)
      expect((await readSpans(runId, 'limit=0')).statusCode).toBe(400)
      expect((await readSpans('short')).statusCode).toBe(400)
    }

    expect((await readSpans(runId)).statusCode).toBe(200)
  })
})
