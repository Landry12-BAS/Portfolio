// Tests of `just record-sample lb-05 <sample>`: against the test mock (a real HTTP server that plays
// LB-05 and the gateway's trace route) it records a curated question or an attack as the one exchange the
// board's replay hands back, labels the recording as the mock's, checks it with the recording schema and
// writes it where the end-to-end build reads it; it refuses what it cannot record honestly; and the
// written file is one the site then serves in the test build. Against a live back end with a real model
// it has never run, and this file says so by running nowhere but on the mock.
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { MOCK_IDENTITY_PATH, startMockBackend } from '@lb/api-clients/testing'
import type { MockBackend } from '@lb/api-clients/testing'
import { ServiceTokens, privateKeyFromJwk } from '@lb/common/tokens'
import { recordingSchema } from '@lb/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { LB05_ATTACKS, LB05_SAMPLES } from '../../shared/data/samples/lb05.ts'
import { Backend } from '../../scripts/record/backend.ts'
import type { BackendTarget } from '../../scripts/record/backend.ts'
import { recordSample, recordingFile, writeRecording } from '../../scripts/record/record.ts'
import { answered, refused, unavailable } from '../support/lb05.ts'
import { Browser } from '../support/browser.ts'
import { makeTestKeys, startTestSite } from '../support/site-app.ts'

const run = promisify(execFile)
const keys = makeTestKeys()
let mock: MockBackend
let folder: string

/** A clock that never waits: the mock answers at once. */
const instantClock = { now: () => Date.now(), sleep: () => Promise.resolve() }

/** The curated question the tests record, which has a table and a bar chart. */
const PRODUCT_SAMPLE = 'revenue-by-product-last-quarter'

/** Builds a recorder's target against the mock, signed with the test keys. */
function targetFor(url: string, overrides: Partial<BackendTarget> = {}): BackendTarget {
  return {
    apiUrl: new URL(url),
    gatewayUrl: new URL(url),
    signingKey: privateKeyFromJwk(JSON.parse(keys.siteJwk)),
    gatewayTokens: new ServiceTokens('web', privateKeyFromJwk(JSON.parse(keys.webJwk)), () => Date.now() / 1_000),
    fetch,
    clock: instantClock,
    ...overrides,
  }
}

beforeAll(async () => {
  mock = await startMockBackend({ siteKey: keys.sitePublic, webKey: keys.webPublic })
  folder = mkdtempSync(join(tmpdir(), 'lb-recordings-05-'))
})

afterAll(async () => {
  await mock.close()
  rmSync(folder, { recursive: true, force: true })
})

describe('recording an LB-05 question against the mock', () => {
  it('asks the curated question as the board does and records the one exchange, with the run\'s whole trace', async () => {
    const recording = await recordSample(new Backend(targetFor(mock.url)), 'lb-05', PRODUCT_SAMPLE)

    expect(recording).toMatchObject({ v: 1, system: 'lb-05', sample: PRODUCT_SAMPLE, language: 'en', origin: 'mock' })
    expect(recording.exchanges).toHaveLength(1)
    expect(recording.exchanges[0]?.request).toEqual({ method: 'POST', path: '/api/lb05/ask', body: { question: LB05_SAMPLES.find(sample => sample.id === PRODUCT_SAMPLE)?.question } })
    expect(recording.exchanges[0]?.response.status).toBe(200)
    const answer = recording.exchanges[0]?.response.body as { outcome: string, run_id: string, result: { rows: unknown[] } }
    expect(answer.outcome).toBe('answered')
    expect(answer.result.rows.length).toBeGreaterThan(1)
    expect(recording.trace.runId).toBe(answer.run_id)
    expect(recording.trace.spans.at(-1)).toMatchObject({ kind: 'system.run', name: 'data question' })
    expect(recording.stats.modelCalls).toBeGreaterThanOrEqual(2)
    expect(recording.stats.steps).toBeGreaterThanOrEqual(7)
  })

  it('records an attack that a layer stopped, with the layer named in the answer', async () => {
    const recording = await recordSample(new Backend(targetFor(mock.url)), 'lb-05', 'drop-orders-table')

    const answer = recording.exchanges[0]?.response.body as { outcome: string, attempts: { stopped_by: string, rule: string }[], result: unknown }
    expect(answer.outcome).toBe('refused')
    expect(answer.attempts.at(-1)).toMatchObject({ stopped_by: 'parse', rule: 'not_select' })
    expect(answer.result).toBeNull()
    expect(recording.sample).toBe('drop-orders-table')
  })

  it('records every curated question and every attack the board lists, so no sample is one the recorder cannot run', async () => {
    const backend = new Backend(targetFor(mock.url))
    for (const sample of [...LB05_SAMPLES, ...LB05_ATTACKS]) {
      const recording = await recordSample(backend, 'lb-05', sample.id)
      expect(recordingSchema.safeParse(recording).success).toBe(true)
      expect(recording.sample).toBe(sample.id)
    }
  })

  it('labels a recording made on a back end that does not say it is the mock as live', async () => {
    const real: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.pathname === MOCK_IDENTITY_PATH) return Response.json({ error: { code: 'not_found', message: 'There is nothing at this address.' } }, { status: 404 })
      return fetch(input, init)
    }

    const recording = await recordSample(new Backend(targetFor(mock.url, { fetch: real })), 'lb-05', PRODUCT_SAMPLE)

    expect(recording.origin).toBe('live')
  })

  it('refuses a sample that does not exist, naming the questions and the attacks that do', async () => {
    await expect(recordSample(new Backend(targetFor(mock.url)), 'lb-05', 'no-such-sample')).rejects.toThrow(/no sample called "no-such-sample".*revenue-last-quarter.*drop-orders-table/s)
  })

  it('does not record an answer that says the service could not answer, which was not counted', async () => {
    mock.script({ method: 'POST', path: '/api/lb05/ask', status: 200, json: unavailable() })

    await expect(recordSample(new Backend(targetFor(mock.url)), 'lb-05', PRODUCT_SAMPLE)).rejects.toThrow('could not answer')
  })

  it('does not record a curated question that did not come out answered, but would record an attack that did not', async () => {
    mock.script({ method: 'POST', path: '/api/lb05/ask', status: 200, json: refused() })
    await expect(recordSample(new Backend(targetFor(mock.url)), 'lb-05', PRODUCT_SAMPLE)).rejects.toThrow(`"${PRODUCT_SAMPLE}" came out refused`)

    // An attack the model answered with a harmless query: the mock is made to be asked a curated question instead.
    const harmless: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (init?.method !== 'POST' || url.pathname !== '/api/lb05/ask') return fetch(input, init)
      return fetch(input, { ...init, body: JSON.stringify({ question: LB05_SAMPLES.find(sample => sample.id === PRODUCT_SAMPLE)?.question }) })
    }
    const recording = await recordSample(new Backend(targetFor(mock.url, { fetch: harmless })), 'lb-05', 'drop-orders-table')
    expect((recording.exchanges[0]?.response.body as { outcome: string }).outcome).toBe('answered')
  })

  it('does not record an answer that names no run, since there is no trace to replay', async () => {
    mock.script({ method: 'POST', path: '/api/lb05/ask', status: 200, json: answered({ with: { run_id: '' } }) })

    await expect(recordSample(new Backend(targetFor(mock.url)), 'lb-05', PRODUCT_SAMPLE)).rejects.toThrow('without naming its run')
  })

  it('does not record an answer that is not the shape the board reads, or a question the back end refused', async () => {
    mock.script({ method: 'POST', path: '/api/lb05/ask', status: 200, json: { outcome: 'answered', run_id: 'x' } })
    await expect(recordSample(new Backend(targetFor(mock.url)), 'lb-05', PRODUCT_SAMPLE)).rejects.toThrow('not the shape the board reads')

    mock.script({ method: 'POST', path: '/api/lb05/ask', status: 429, json: { error: { code: 'daily_limit', message: 'x' } } })
    await expect(recordSample(new Backend(targetFor(mock.url)), 'lb-05', PRODUCT_SAMPLE)).rejects.toThrow(/did not answer the question \(status 429\)/)
  })
})

describe('where an LB-05 recording goes, and what the site does with it', () => {
  it('is written as readable JSON at <folder>/lb-05/<sample>.json, and reads back as the same recording', async () => {
    const recording = await recordSample(new Backend(targetFor(mock.url)), 'lb-05', 'monthly-revenue-last-year')

    const file = writeRecording(folder, recording)

    expect(file).toBe(recordingFile(folder, recording))
    expect(file.endsWith(join('lb-05', 'monthly-revenue-last-year.json'))).toBe(true)
    expect(recordingSchema.parse(JSON.parse(readFileSync(file, 'utf8')))).toEqual(recording)
  })

  it('is served by the test build of the site, which is the one place a mock recording is shown', async () => {
    const recording = await recordSample(new Backend(targetFor(mock.url)), 'lb-05', PRODUCT_SAMPLE)
    const site = await startTestSite({ keys, backendUrl: mock.url, recordings: { [`lb-05/${PRODUCT_SAMPLE}`]: recording } })
    try {
      const browser = new Browser(site)

      expect((await browser.request('GET', '/api/recordings/lb-05')).json).toEqual({ system: 'lb-05', samples: [PRODUCT_SAMPLE] })
      expect((await browser.request('GET', `/api/recordings/lb-05/${PRODUCT_SAMPLE}`)).json).toEqual(recording)
    }
    finally {
      await site.close()
    }
  })
})

describe('the command', () => {
  it('records an LB-05 sample, writes it, and says plainly that it came from the mock', async () => {
    const siteKey = join(folder, 'site.jwk.json')
    const webKey = join(folder, 'web.jwk.json')
    writeFileSync(siteKey, keys.siteJwk)
    writeFileSync(webKey, keys.webJwk)
    const env = { PATH: process.env.PATH ?? '', LB_API_URL: mock.url, LB_GATEWAY_URL: mock.url, LB_WEB_SIGNING_KEY_FILE: siteKey, LB_GATEWAY_SERVICE_KEY_FILE: webKey }
    const out = join(folder, 'command')

    const { stdout } = await run('node', ['scripts/record-sample.ts', 'lb-05', 'cancellation-rate-last-quarter', '--out', out], { cwd: join(import.meta.dirname, '../..'), env })

    expect(stdout).toContain('Wrote ')
    expect(stdout).toContain('Made on the test mock')
    const written = recordingSchema.parse(JSON.parse(readFileSync(join(out, 'lb-05', 'cancellation-rate-last-quarter.json'), 'utf8')))
    expect(written).toMatchObject({ system: 'lb-05', sample: 'cancellation-rate-last-quarter', origin: 'mock' })
  })
})
