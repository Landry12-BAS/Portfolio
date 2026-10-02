// Tests of `just record-sample`: against the test mock (a real HTTP server that plays LB-01 and the
// gateway's trace route) it records a sample, labels the recording as the mock's, checks it with the
// recording schema and writes it where the end-to-end build reads it; it refuses what it cannot
// record honestly; and the written file is one the site then serves in the test build. Against a
// live back end it has never run, and this file says so by running nowhere but on the mock.
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

import { LB01_SAMPLES } from '../../shared/data/samples/lb01.ts'
import { Backend } from '../../scripts/record/backend.ts'
import type { BackendTarget } from '../../scripts/record/backend.ts'
import { recordSample, recordingFile, writeRecording } from '../../scripts/record/record.ts'
import { Browser } from '../support/browser.ts'
import { makeTestKeys, startTestSite } from '../support/site-app.ts'

const run = promisify(execFile)
const keys = makeTestKeys()
let mock: MockBackend
let folder: string

/** A clock that never waits: the mock's pipeline moves on as it is read, not as time passes. */
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
  folder = mkdtempSync(join(tmpdir(), 'lb-recordings-'))
})

afterAll(async () => {
  await mock.close()
  rmSync(folder, { recursive: true, force: true })
})

describe('recording a sample against the mock', () => {
  it('runs the sample as its customer and records the answers, one for each new state of the ticket', async () => {
    const recording = await recordSample(new Backend(targetFor(mock.url)), 'lb-01', 'torn-bag')

    expect(recording).toMatchObject({ v: 1, system: 'lb-01', sample: 'torn-bag', language: 'en' })
    expect(recording.exchanges.map(exchange => `${exchange.request.method} ${exchange.response.status}`)).toEqual(['POST 202', 'GET 200', 'GET 200'])
    expect(recording.exchanges[0]?.request.body).toEqual({ customer: LB01_SAMPLES[0].customer, language: 'en', body: LB01_SAMPLES[0].body })
    const statuses = recording.exchanges.map(exchange => (exchange.response.body as { status: string }).status)
    expect(statuses).toEqual(['received', 'processing', 'awaiting_approval'])
  })

  it('records the run\'s whole trace, root span included, and the numbers it comes to', async () => {
    const recording = await recordSample(new Backend(targetFor(mock.url)), 'lb-01', 'torn-bag')

    expect(recording.trace.spans.at(-1)).toMatchObject({ kind: 'system.run', name: 'support ticket' })
    expect(recording.stats).toEqual({ modelCalls: 5, steps: 9, durationMs: 2_675 })
    expect(recordingSchema.safeParse(recording).success).toBe(true)
  })

  it('takes the run from the answer that names it: Django names a run only when its pipeline has finished', async () => {
    const recording = await recordSample(new Backend(targetFor(mock.url)), 'lb-01', 'torn-bag')

    const runIds = recording.exchanges.map(exchange => (exchange.response.body as { run_id: string }).run_id)
    expect(runIds).toEqual(['', '', recording.trace.runId])
    expect(recording.trace.runId).toMatch(/^run-[0-9a-f]{20}$/)
    expect(recording.trace.spans.every(span => span.runId === recording.trace.runId)).toBe(true)
  })

  it('refuses to record a run the back end finished without ever naming, since it has no trace', async () => {
    const nameless: typeof fetch = async (input, init) => {
      const response = await fetch(input, init)
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (init?.method !== 'GET' || !/^\/api\/lb01\/tickets\/tk/.test(url.pathname)) return response
      return Response.json({ ...(await response.json() as object), run_id: '' })
    }

    await expect(recordSample(new Backend(targetFor(mock.url, { fetch: nameless })), 'lb-01', 'torn-bag')).rejects.toThrow('finished the ticket without naming its run')
  })

  it('labels a recording made on the mock as the mock\'s, whatever else is true', async () => {
    const recording = await recordSample(new Backend(targetFor(mock.url)), 'lb-01', 'torn-bag')

    expect(recording.origin).toBe('mock')
  })

  it('labels a recording made on a back end that does not say it is the mock as live', async () => {
    const real: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.pathname === MOCK_IDENTITY_PATH) return Response.json({ error: { code: 'not_found', message: 'There is nothing at this address.' } }, { status: 404 })
      return fetch(input, init)
    }

    const recording = await recordSample(new Backend(targetFor(mock.url, { fetch: real })), 'lb-01', 'torn-bag')

    expect(recording.origin).toBe('live')
  })

  it('records a ticket the pipeline handed to a person, with no draft', async () => {
    const recording = await recordSample(new Backend(targetFor(mock.url)), 'lb-01', 'injection-admin-mode')

    const final = recording.exchanges.at(-1)?.response.body as { status: string, draft: unknown, escalation_reason: string }
    expect(final).toMatchObject({ status: 'escalated', draft: null, escalation_reason: 'injection' })
    expect(recording.stats.modelCalls).toBe(1)
  })

  it('records the Czech samples in their language', async () => {
    const recording = await recordSample(new Backend(targetFor(mock.url)), 'lb-01', 'stale-decaf')

    expect(recording.language).toBe('cs')
  })

  it('refuses a sample that does not exist and a system it has no recorder for, naming what does', async () => {
    const backend = new Backend(targetFor(mock.url))

    await expect(recordSample(backend, 'lb-01', 'no-such-sample')).rejects.toThrow(/no sample called "no-such-sample".*torn-bag/)
    await expect(recordSample(backend, 'lb-02', 'anything')).rejects.toThrow(/no recorder for lb-02 yet.*lb-01/)
  })

  it('does not record a run whose pipeline failed, or a ticket the back end refused', async () => {
    const failing: typeof fetch = async (input, init) => {
      const response = await fetch(input, init)
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (init?.method !== 'GET' || !/^\/api\/lb01\/tickets\/tk/.test(url.pathname)) return response
      return Response.json({ ...(await response.json() as object), status: 'failed' })
    }
    await expect(recordSample(new Backend(targetFor(mock.url, { fetch: failing })), 'lb-01', 'torn-bag')).rejects.toThrow('The pipeline failed on this ticket')

    mock.script({ method: 'POST', path: '/api/lb01/tickets', status: 429, json: { error: { code: 'daily_limit', message: 'x' } } })
    await expect(recordSample(new Backend(targetFor(mock.url)), 'lb-01', 'torn-bag')).rejects.toThrow(/did not accept the ticket \(status 429\)/)
  })

  it('gives up on a pipeline that never finishes instead of recording half a run', async () => {
    // One clock for the recorder, its tokens and the mock, which moves only when the recorder waits.
    let now = Date.now()
    const sleep = (ms: number): Promise<void> => {
      now += ms
      return Promise.resolve()
    }
    const slowClock = { now: () => now, sleep }
    const gatewayTokens = new ServiceTokens('web', privateKeyFromJwk(JSON.parse(keys.webJwk)), () => now / 1_000)
    const slow = await startMockBackend({ siteKey: keys.sitePublic, webKey: keys.webPublic, pollsToFinish: 1_000_000, now: () => now })
    try {
      await expect(recordSample(new Backend(targetFor(slow.url, { clock: slowClock, gatewayTokens })), 'lb-01', 'torn-bag')).rejects.toThrow('did not finish within three minutes')
    }
    finally {
      await slow.close()
    }
  })
})

describe('where a recording goes, and what the site does with it', () => {
  it('is written as readable JSON at <folder>/<system>/<sample>.json, and reads back as the same recording', async () => {
    const recording = await recordSample(new Backend(targetFor(mock.url)), 'lb-01', 'late-parcel')

    const file = writeRecording(folder, recording)

    expect(file).toBe(recordingFile(folder, recording))
    expect(file.endsWith(join('lb-01', 'late-parcel.json'))).toBe(true)
    const text = readFileSync(file, 'utf8')
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).toContain('\n  "system": "lb-01"')
    expect(recordingSchema.parse(JSON.parse(text))).toEqual(recording)
  })

  it('is served by the test build of the site, which is the one place a mock recording is shown', async () => {
    const recording = await recordSample(new Backend(targetFor(mock.url)), 'lb-01', 'torn-bag')
    const site = await startTestSite({ keys, backendUrl: mock.url, recordings: { 'lb-01/torn-bag': recording } })
    try {
      const browser = new Browser(site)

      expect((await browser.request('GET', '/api/recordings/lb-01')).json).toEqual({ system: 'lb-01', samples: ['torn-bag'] })
      expect((await browser.request('GET', '/api/recordings/lb-01/torn-bag')).json).toEqual(recording)
    }
    finally {
      await site.close()
    }
  })
})

describe('the command', () => {
  /** Runs the command as `just record-sample` does, with these environment variables. */
  function command(args: string[], env: Record<string, string>) {
    return run('node', ['scripts/record-sample.ts', ...args], { cwd: join(import.meta.dirname, '../..'), env: { PATH: process.env.PATH ?? '', ...env } })
  }

  /** The environment the command reads, pointing at the mock and at key files it can read. */
  function environment(): Record<string, string> {
    const siteKey = join(folder, 'site.jwk.json')
    const webKey = join(folder, 'web.jwk.json')
    writeFileSync(siteKey, keys.siteJwk)
    writeFileSync(webKey, keys.webJwk)
    return { LB_API_URL: mock.url, LB_GATEWAY_URL: mock.url, LB_WEB_SIGNING_KEY_FILE: siteKey, LB_GATEWAY_SERVICE_KEY_FILE: webKey }
  }

  it('records a sample, writes it, and says plainly that it came from the mock', async () => {
    const out = join(folder, 'command')

    const { stdout } = await command(['lb-01', 'wrong-grind', '--out', out], environment())

    expect(stdout).toContain('Wrote ')
    expect(stdout).toContain('Made on the test mock')
    expect(stdout).toContain('never shown to a visitor of the real site')
    const written = recordingSchema.parse(JSON.parse(readFileSync(join(out, 'lb-01', 'wrong-grind.json'), 'utf8')))
    expect(written).toMatchObject({ sample: 'wrong-grind', origin: 'mock' })
  })

  it('names what is wrong with its arguments or its settings, and writes nothing', async () => {
    await expect(command(['lb-01'], environment())).rejects.toMatchObject({ stderr: expect.stringContaining('Usage: record-sample <system> <sample>') })
    await expect(command(['LB-1', 'x'], environment())).rejects.toMatchObject({ stderr: expect.stringContaining('Usage:') })
    await expect(command(['lb-01', 'torn-bag'], {})).rejects.toMatchObject({ stderr: expect.stringContaining('LB_API_URL must be the service\'s origin') })
    await expect(command(['lb-01', 'torn-bag'], { ...environment(), LB_WEB_SIGNING_KEY_FILE: join(folder, 'missing.json') })).rejects.toMatchObject({ stderr: expect.stringContaining('ENOENT') })
  })

  it('never prints a key', async () => {
    const out = join(folder, 'quiet')
    const { stdout, stderr } = await command(['lb-01', 'torn-bag', '--out', out], environment())
    const secret = (JSON.parse(keys.siteJwk) as { d: string }).d
    expect(stdout + stderr).not.toContain(secret)
  })
})
