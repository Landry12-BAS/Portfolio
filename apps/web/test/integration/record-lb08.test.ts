// Tests of recording LB-08's samples: against the test mock (a real HTTP server that plays the
// automation service and the gateway's trace route, on a clock the recorder moves by waiting) the
// recorder opens a sample, runs it with its test order and, for the samples that are about a
// failure, makes a step fail and replays the dead letter. What it keeps is what the board's replay
// hands back, one answer after another, so every kept answer must be one the board reads. They run
// on the mock and say so: a recording made here is labelled the mock's and is never shown to a
// visitor of the real site.
import { MOCK_IDENTITY_PATH, startMockBackend } from '@lb/api-clients/testing'
import type { MockBackend } from '@lb/api-clients/testing'
import { ServiceTokens, privateKeyFromJwk } from '@lb/common/tokens'
import { recordingSchema } from '@lb/contracts'
import type { Recording } from '@lb/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { factOf } from '../../app/boards/lb-08/exchange.ts'
import { Backend } from '../../scripts/record/backend.ts'
import type { Clock } from '../../scripts/record/backend.ts'
import { recordSample } from '../../scripts/record/record.ts'
import { makeTestKeys } from '../support/site-app.ts'

const keys = makeTestKeys()
let now = Date.now()
let mock: MockBackend

/** A clock that moves only when the recorder waits, shared by the recorder, its tokens and the mock. */
const clock: Clock = {
  now: () => now,
  sleep: (ms) => {
    now += ms
    return Promise.resolve()
  },
}

/** A recorder pointed at the mock, optionally through a different `fetch`. */
function backend(fetchThrough: typeof fetch = fetch): Backend {
  return new Backend({
    apiUrl: new URL(mock.url),
    gatewayUrl: new URL(mock.url),
    signingKey: privateKeyFromJwk(JSON.parse(keys.siteJwk)),
    gatewayTokens: new ServiceTokens('web', privateKeyFromJwk(JSON.parse(keys.webJwk)), () => now / 1_000),
    fetch: fetchThrough,
    clock,
  })
}

/** Shortens a recording's exchanges to `GET /runs/<id>/events` and so on, to compare them at a glance. */
function outline(recording: Recording): string[] {
  return recording.exchanges.map(exchange => `${exchange.request.method} ${exchange.request.path.replace('/api/lb08', '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>')} ${exchange.response.status}`)
}

beforeAll(async () => {
  mock = await startMockBackend({ siteKey: keys.sitePublic, webKey: keys.webPublic, now: clock.now })
})

afterAll(async () => {
  await mock.close()
})

describe('recording LB-08 samples against the mock', () => {
  it('opens the sample, runs it with its own test order and keeps what the board would have been told', async () => {
    const recording = await recordSample(backend(), 'lb-08', 'wholesale-order')

    expect(recordingSchema.safeParse(recording).success).toBe(true)
    expect(recording).toMatchObject({ system: 'lb-08', sample: 'wholesale-order', origin: 'mock', language: 'en' })
    expect(outline(recording).slice(0, 2)).toEqual(['POST /workflows 201', 'POST /workflows/<id>/runs 202'])
    expect(recording.exchanges[0]?.request.body).toEqual({ from: 'sample', sampleId: 'wholesale-order' })
    expect(outline(recording).slice(-3)).toEqual(['GET /runs/<id> 200', 'GET /sent 200', 'GET /dead-letters 200'])
  })

  it('makes the sample\'s Slack step fail once, so the recording shows a retry that then works', async () => {
    const recording = await recordSample(backend(), 'lb-08', 'wholesale-order')

    const start = recording.exchanges[1]?.request.body as { input: object, failures: { nodeId: string, times: number }[] }
    expect(start.failures).toHaveLength(1)
    expect(start.failures[0]?.times).toBe(1)
    const events = recording.exchanges.flatMap(exchange => ((exchange.response.body as { events?: { type: string }[] }).events ?? []).map(event => event.type))
    expect(events).toContain('step.failed')
    expect(events.at(-1)).toBe('run.succeeded')
    expect(events).not.toContain('step.dead_lettered')
  })

  it('records a step that uses all its attempts, then the replay of its dead letter, which sends nothing twice', async () => {
    const recording = await recordSample(backend(), 'lb-08', 'low-stock-reorder')

    const paths = outline(recording)
    expect(paths.some(path => path.startsWith('POST /dead-letters/<id>/replay 202'))).toBe(true)
    const events = recording.exchanges.flatMap(exchange => ((exchange.response.body as { events?: { type: string }[] }).events ?? []).map(event => event.type))
    expect(events).toContain('step.dead_lettered')
    expect(events).toContain('run.failed')
    expect(events).toContain('effect.duplicate_suppressed')
    expect(events.at(-1)).toBe('run.succeeded')
  })

  it('answers the approval a run waits for, in the order the board would', async () => {
    const recording = await recordSample(backend(), 'lb-08', 'refund-approval')

    const paths = outline(recording)
    const decision = paths.findIndex(path => path.includes('/decision'))
    expect(decision).toBeGreaterThan(1)
    expect(recording.exchanges[decision]?.request.body).toEqual({ decision: 'approved' })
    expect(paths[decision - 1]).toBe('GET /runs/<id> 200')
  })

  it('records the Czech sample in its language', async () => {
    const recording = await recordSample(backend(), 'lb-08', 'wholesale-order-cs')

    expect(recording.language).toBe('cs')
    expect(recordingSchema.safeParse(recording).success).toBe(true)
  })

  it('keeps only answers the board accepts, and no query string in any path', async () => {
    const recording = await recordSample(backend(), 'lb-08', 'low-stock-reorder')

    for (const exchange of recording.exchanges) {
      expect(factOf(exchange), `${exchange.request.method} ${exchange.request.path}`).toBeDefined()
      expect(exchange.request.path).not.toContain('?')
    }
  })

  it('keeps the log in unbroken pages: each page of a run starts where the one before it ended', async () => {
    const recording = await recordSample(backend(), 'lb-08', 'low-stock-reorder')

    const seen = new Map<string, number>()
    for (const exchange of recording.exchanges) {
      const fact = factOf(exchange)
      if (fact?.kind === 'run-started') seen.set(fact.view.id, fact.view.events.at(-1)?.seq ?? 0)
      if (fact?.kind !== 'events') continue
      const first = fact.page.events[0]?.seq
      expect(first).toBe((seen.get(fact.runId) ?? 0) + 1)
      seen.set(fact.runId, fact.page.events.at(-1)?.seq ?? 0)
    }
    expect(seen.size).toBe(2)
  })

  it('ends a trace that has no root span when it has stopped growing, and counts what it holds', async () => {
    const recording = await recordSample(backend(), 'lb-08', 'wholesale-order')

    expect(recording.trace.spans.some(span => span.kind === 'system.run' && span.parentId === undefined)).toBe(false)
    expect(recording.stats.modelCalls).toBe(0)
    expect(recording.stats.steps).toBe(recording.trace.spans.filter(span => span.kind === 'system.step' || span.kind === 'system.tool').length)
  })

  it('labels a recording made on a back end that does not say it is the mock as live', async () => {
    const real: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.pathname === MOCK_IDENTITY_PATH) return Response.json({ error: { code: 'not_found', message: 'There is nothing at this address.' } }, { status: 404 })
      return fetch(input, init)
    }

    const recording = await recordSample(backend(real), 'lb-08', 'wholesale-order-cs')

    expect(recording.origin).toBe('live')
  })

  it('refuses a sample that does not exist, naming the samples there are', async () => {
    await expect(recordSample(backend(), 'lb-08', 'no-such-sample')).rejects.toThrow(/no sample called "no-such-sample".*wholesale-order/)
  })

  it('does not record a sample the back end refused to open', async () => {
    mock.script({ method: 'POST', path: '/api/lb08/workflows', status: 429, json: { error: { code: 'daily_limit', message: 'x' } } })

    await expect(recordSample(backend(), 'lb-08', 'wholesale-order')).rejects.toThrow(/did not open the sample \(status 429\)/)
  })

  it('gives up on a run that never finishes instead of recording half of it', async () => {
    const stuck: typeof fetch = async (input, init) => {
      const response = await fetch(input, init)
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (init?.method !== 'GET' || !/\/runs\/[^/]+\/events$/.test(url.pathname)) return response
      return Response.json({ status: 'running', events: [] })
    }

    await expect(recordSample(backend(stuck), 'lb-08', 'wholesale-order')).rejects.toThrow('did not finish within two minutes')
  })
})
