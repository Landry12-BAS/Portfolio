// Tests of `just record-sample lb-03 <sample>`: against the test mock (a real HTTP server that plays LB-03 and
// the gateway's trace route) it uploads a curated sample's own file as the board does, reads the document as it
// moves through its states, records the upload and each answer that shows something new with the run's whole
// trace, labels the recording as the mock's, checks it with the recording schema and writes it where the
// end-to-end build reads it; it refuses what it cannot record honestly; and the written file is one the site
// then serves in the test build. Against a live back end with a real model it has never run, and this file
// says so by running nowhere but on the mock.
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { MOCK_IDENTITY_PATH, startMockBackend } from '@lb/api-clients/testing'
import type { MockBackend } from '@lb/api-clients/testing'
import { ServiceTokens, privateKeyFromJwk } from '@lb/common/tokens'
import { recordingSchema } from '@lb/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { LB03_SAMPLES } from '../../shared/data/samples/lb03.ts'
import { Backend } from '../../scripts/record/backend.ts'
import type { BackendTarget } from '../../scripts/record/backend.ts'
import { recordSample, recordingFile, writeRecording } from '../../scripts/record/record.ts'
import { Browser } from '../support/browser.ts'
import { makeTestKeys, startTestSite } from '../support/site-app.ts'

const run = promisify(execFile)
const keys = makeTestKeys()
let mock: MockBackend
let folder: string

/** A clock that never waits: the mock answers at once. */
const instantClock = { now: () => Date.now(), sleep: () => Promise.resolve() }

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
  folder = mkdtempSync(join(tmpdir(), 'lb-recordings-03-'))
})

beforeEach(() => {
  mock.reset()
})

afterAll(async () => {
  await mock.close()
  rmSync(folder, { recursive: true, force: true })
})

describe('recording an LB-03 sample against the mock', () => {
  it('uploads the sample\'s file as the board does, reads the document through its states, and records each with the run\'s whole trace', async () => {
    const recording = await recordSample(new Backend(targetFor(mock.url)), 'lb-03', 'planted-total')

    expect(recording).toMatchObject({ v: 1, system: 'lb-03', sample: 'planted-total', language: 'en', origin: 'mock' })
    expect(recording.exchanges[0]?.request).toEqual({ method: 'POST', path: '/api/lb03/documents', body: { file: 'planted-total-hanse-2026-4700.pdf' } })
    expect(recording.exchanges[0]?.response.status).toBe(202)
    const states = recording.exchanges.map(exchange => (exchange.response.body as { state: string }).state)
    expect(states).toEqual(['uploaded', 'ocr', 'extract', 'validate', 'repair', 'ready'])
    expect(recording.exchanges.slice(1).every(exchange => exchange.request.method === 'GET' && exchange.request.path.startsWith('/api/lb03/documents/'))).toBe(true)
    const last = recording.exchanges.at(-1)?.response.body as { run_id: string, checks: { id: string, status: string }[], can_export: boolean }
    expect(last.checks.find(check => check.id === 'total_reconciles')?.status).toBe('failed')
    expect(last.can_export).toBe(false)
    expect(recording.trace.runId).toBe(last.run_id)
    expect(recording.trace.spans.at(-1)).toMatchObject({ kind: 'system.run', name: 'invoice reading' })
    expect(recording.stats.modelCalls).toBeGreaterThanOrEqual(2)
    expect(mock.violations).toEqual([])
  })

  it('sends the file as one multipart part named file, byte for byte what the seed holds, as a signed visitor', async () => {
    await recordSample(new Backend(targetFor(mock.url)), 'lb-03', 'clean-pdf')
    const upload = mock.requests.find(request => request.method === 'POST' && request.path === '/api/lb03/documents')
    expect(upload?.headers['content-type']).toMatch(/^multipart\/form-data; boundary=----lbrecorder[0-9a-f]{24}$/)
    expect(upload?.headers.authorization).toMatch(/^Bearer /)
    expect(upload?.body.startsWith('------lbrecorder')).toBe(true)
    expect(upload?.body).toContain('Content-Disposition: form-data; name="file"; filename="bohemia-packaging-2026-0412.pdf"')
    expect(upload?.body).toContain('Content-Type: application/pdf')
    expect(upload?.body).toContain('%PDF-')
    expect(upload?.body.length).toBeGreaterThan(LB03_SAMPLES[0].bytes)
  })

  it('records a hostile invoice the injection check stopped, with the reason in the answer', async () => {
    const recording = await recordSample(new Backend(targetFor(mock.url)), 'lb-03', 'prompt-injection')
    const last = recording.exchanges.at(-1)?.response.body as { state: string, failure: { code: string }, fields: unknown }
    expect(last.state).toBe('failed')
    expect(last.failure.code).toBe('injection_suspected')
    expect(last.fields).toBeNull()
    expect(recording.exchanges.map(exchange => (exchange.response.body as { state: string }).state)).toEqual(['uploaded', 'ocr', 'extract', 'failed'])
  })

  it('records every sample the board lists, so no sample is one the recorder cannot run', async () => {
    const backend = new Backend(targetFor(mock.url))
    for (const sample of LB03_SAMPLES) {
      mock.reset()
      const recording = await recordSample(backend, 'lb-03', sample.id)
      expect(recordingSchema.safeParse(recording).success, sample.id).toBe(true)
      expect(recording.sample).toBe(sample.id)
    }
  })

  it('labels a recording made on a back end that does not say it is the mock as live', async () => {
    const real: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.pathname === MOCK_IDENTITY_PATH) return Response.json({ error: { code: 'not_found', message: 'There is nothing at this address.' } }, { status: 404 })
      return fetch(input, init)
    }
    const recording = await recordSample(new Backend(targetFor(mock.url, { fetch: real })), 'lb-03', 'clean-pdf')
    expect(recording.origin).toBe('live')
  })

  it('refuses a sample that does not exist, naming the ones that do', async () => {
    await expect(recordSample(new Backend(targetFor(mock.url)), 'lb-03', 'no-such-sample')).rejects.toThrow(/no sample called "no-such-sample".*clean-pdf.*planted-total/s)
  })

  it('does not record a document the back end would not take, or a form the back end would not read', async () => {
    mock.script({ method: 'POST', path: '/api/lb03/documents', status: 429, json: { error: { code: 'daily_limit', message: 'x' } } })
    await expect(recordSample(new Backend(targetFor(mock.url)), 'lb-03', 'clean-pdf')).rejects.toThrow(/did not take the document \(status 429\)/)
    mock.script({ method: 'POST', path: '/api/lb03/documents', status: 202, json: { id: 'x' } })
    await expect(recordSample(new Backend(targetFor(mock.url)), 'lb-03', 'clean-pdf')).rejects.toThrow()
  })

  it('does not record a document that failed because the service did, when the golden set says it is read', async () => {
    const failed = { ...(await recordSample(new Backend(targetFor(mock.url)), 'lb-03', 'clean-pdf')).exchanges.at(-1)?.response.body as object, id: 'fixeddocumentid', state: 'failed', failure: { code: 'model_failed', message: 'x' }, fields: null, checks: null, journal: null, journal_status: null, duplicate: null, can_export: false, pages: null }
    mock.reset()
    mock.script({ method: 'POST', path: '/api/lb03/documents', status: 202, json: { ...failed, state: 'uploaded', failure: null } })
    mock.script({ method: 'GET', path: '/api/lb03/documents/fixeddocumentid', status: 200, json: failed })
    await expect(recordSample(new Backend(targetFor(mock.url)), 'lb-03', 'clean-pdf')).rejects.toThrow('came out failed (model_failed), and the golden set expects ready')
  })

  it('does not record a hostile invoice that was read instead of stopped, or a document that names no run', async () => {
    const ready = (await recordSample(new Backend(targetFor(mock.url)), 'lb-03', 'clean-pdf')).exchanges.at(-1)?.response.body as object
    mock.reset()
    mock.script({ method: 'POST', path: '/api/lb03/documents', status: 202, json: { ...ready, id: 'fixeddocumentid', state: 'uploaded', failure: null } })
    mock.script({ method: 'GET', path: '/api/lb03/documents/fixeddocumentid', status: 200, json: { ...ready, id: 'fixeddocumentid' } })
    await expect(recordSample(new Backend(targetFor(mock.url)), 'lb-03', 'prompt-injection')).rejects.toThrow('golden set expects failed')

    mock.reset()
    mock.script({ method: 'POST', path: '/api/lb03/documents', status: 202, json: { ...ready, id: 'fixeddocumentid', state: 'uploaded', failure: null } })
    mock.script({ method: 'GET', path: '/api/lb03/documents/fixeddocumentid', status: 200, json: { ...ready, id: 'fixeddocumentid', run_id: null } })
    await expect(recordSample(new Backend(targetFor(mock.url)), 'lb-03', 'clean-pdf')).rejects.toThrow('without naming its run')
  })

  it('does not record a reading that never ends', async () => {
    let now = Date.now()
    const slow = {
      now: () => now,
      sleep: (ms: number) => {
        now += ms
        return Promise.resolve()
      },
    }
    const waiting = { id: 'fixeddocumentid', state: 'uploaded' }
    const first = (await recordSample(new Backend(targetFor(mock.url)), 'lb-03', 'clean-pdf')).exchanges[0]?.response.body as object
    mock.reset()
    mock.script({ method: 'POST', path: '/api/lb03/documents', status: 202, json: { ...first, ...waiting } })
    mock.script({ method: 'GET', path: '/api/lb03/documents/fixeddocumentid', status: 200, json: { ...first, ...waiting }, times: 1_000 })
    await expect(recordSample(new Backend(targetFor(mock.url, { clock: slow })), 'lb-03', 'clean-pdf')).rejects.toThrow('did not finish within five minutes')
  })
})

describe('where an LB-03 recording goes, and what the site does with it', () => {
  it('is written as readable JSON at <folder>/lb-03/<sample>.json, and reads back as the same recording', async () => {
    const recording = await recordSample(new Backend(targetFor(mock.url)), 'lb-03', 'clean-pdf')
    const file = writeRecording(folder, recording)
    expect(file).toBe(recordingFile(folder, recording))
    expect(file.endsWith(join('lb-03', 'clean-pdf.json'))).toBe(true)
    expect(recordingSchema.parse(JSON.parse(readFileSync(file, 'utf8')))).toEqual(recording)
  })

  it('is served by the test build of the site, which is the one place a mock recording is shown', async () => {
    const recording = await recordSample(new Backend(targetFor(mock.url)), 'lb-03', 'planted-total')
    const site = await startTestSite({ keys, backendUrl: mock.url, recordings: { 'lb-03/planted-total': recording } })
    try {
      const browser = new Browser(site)
      expect((await browser.request('GET', '/api/recordings/lb-03')).json).toEqual({ system: 'lb-03', samples: ['planted-total'] })
      expect((await browser.request('GET', '/api/recordings/lb-03/planted-total')).json).toEqual(recording)
    }
    finally {
      await site.close()
    }
  })
})

describe('the command', () => {
  it('records an LB-03 sample, writes it, and says plainly that it came from the mock', async () => {
    const siteKey = join(folder, 'site.jwk.json')
    const webKey = join(folder, 'web.jwk.json')
    writeFileSync(siteKey, keys.siteJwk)
    writeFileSync(webKey, keys.webJwk)
    const env = { PATH: process.env.PATH ?? '', LB_API_URL: mock.url, LB_GATEWAY_URL: mock.url, LB_WEB_SIGNING_KEY_FILE: siteKey, LB_GATEWAY_SERVICE_KEY_FILE: webKey }
    const out = join(folder, 'command')

    const { stdout } = await run('node', ['scripts/record-sample.ts', 'lb-03', 'euro-vat', '--out', out], { cwd: join(import.meta.dirname, '../..'), env })

    expect(stdout).toContain('Wrote ')
    expect(stdout).toContain('Made on the test mock')
    const written = recordingSchema.parse(JSON.parse(readFileSync(join(out, 'lb-03', 'euro-vat.json'), 'utf8')))
    expect(written).toMatchObject({ system: 'lb-03', sample: 'euro-vat', origin: 'mock' })
  })
})
