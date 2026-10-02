// Integration test of what the gateway logs, on a real Redis: a run's ID is the only key to its trace
// (routes/runs.ts says the route never logs it), so no line of the request log may carry the ID of a
// run whose trace is read, whether the trace is there, is missing, or the request is refused. The
// log is read from the stream the gateway writes to, not from the code's comments.
import { randomBytes } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RedisSpanSink } from '../../src/spans.ts'
import type { Span } from '../../src/spans.ts'
import { startGateway } from '../support/gateway.ts'
import type { TestGateway } from '../support/gateway.ts'

const START = 1_790_000_000_000

let gw: TestGateway
// Every line the gateway wrote, as the text it wrote.
let lines: string[]

beforeEach(async () => {
  lines = []
  gw = await startGateway({ logger: { level: 'info', stream: { write: (line: string) => void lines.push(line) } } })
})

afterEach(async () => {
  await gw.close()
})

/** Makes a run ID of the right shape that no other test uses. */
function newRunId(): string {
  return `run-${randomBytes(6).toString('hex')}`
}

/** Writes a finished one-span run, so a read of it is a success. */
async function writeRun(runId: string): Promise<void> {
  const sink = new RedisSpanSink(gw.redis, gw.prefix, { warn: () => undefined })
  const span: Span = { v: 1, runId, system: 'lb-01', spanId: '0000000000000001', parentId: undefined, kind: 'system.run', name: 'support ticket', status: 'ok', startMs: START, endMs: START + 5, attrs: {} }
  await sink.emit([span])
}

/** Reads a path as the site's server, which may read traces. */
async function read(path: string) {
  return gw.app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${await gw.token('web')}` } })
}

describe('the request log of a trace read', () => {
  it('does not hold the ID of a run whose trace is read, with a cursor or without', async () => {
    const runId = newRunId()
    await writeRun(runId)

    const first = await read(`/v1/runs/${runId}/spans`)
    const cursor = first.json<{ cursor: string }>().cursor
    await read(`/v1/runs/${runId}/spans?after=${cursor}&limit=5`)

    expect(first.statusCode).toBe(200)
    expect(lines.join('')).not.toContain(runId)
  })

  it('does not hold the ID of a run that is not there, or of one the route refuses', async () => {
    const missing = newRunId()
    const refused = 'not~a~run~id-0123456789'

    expect((await read(`/v1/runs/${missing}/spans`)).statusCode).toBe(404)
    expect((await read(`/v1/runs/${refused}/spans`)).statusCode).toBe(400)

    const log = lines.join('')
    expect(log).not.toContain(missing)
    expect(log).not.toContain(refused)
  })

  it('does not hold it when the service may not read traces, or when the path goes on past the ID', async () => {
    const runId = newRunId()

    const forbidden = await gw.app.inject({ method: 'GET', url: `/v1/runs/${runId}/spans`, headers: { authorization: `Bearer ${await gw.token('django-systems')}` } })
    const beyond = await read(`/v1/runs/${runId}/spans/extra`)

    expect(forbidden.statusCode).toBe(403)
    expect(beyond.statusCode).toBe(404)
    expect(lines.join('')).not.toContain(runId)
  })

  it('still logs that a trace was read: the route, the method and who asked from where', async () => {
    const runId = newRunId()
    await writeRun(runId)

    await read(`/v1/runs/${runId}/spans?limit=5`)

    const incoming = lines.map(line => JSON.parse(line) as { msg?: string, req?: { method: string, url: string, host?: string, remoteAddress?: string } }).find(entry => entry.msg === 'incoming request')
    expect(incoming?.req).toMatchObject({ method: 'GET', url: '/v1/runs/:runId/spans?limit=5' })
    expect(incoming?.req?.remoteAddress).toBeDefined()
  })

  it('logs every other route as it always did', async () => {
    await gw.app.inject({ method: 'GET', url: '/healthz' })

    const incoming = lines.map(line => JSON.parse(line) as { msg?: string, req?: { url: string } }).find(entry => entry.msg === 'incoming request')
    expect(incoming?.req?.url).toBe('/healthz')
  })
})
