// Tests of recording LB-04's samples: against the test mock (a real HTTP server that plays the contract
// service, with the real PDF extraction and the real review pipeline and the golden set's reference reviewer
// for a model, and the gateway's trace route) the recorder sends a sample to be reviewed, reads the
// contract until the review has ended, reads the pages, the PDF and the report, and asks for one proposed
// wording. What it keeps is what the board's replay hands back, one answer after another, so every kept
// answer must be one the board reads. A sample that does not end the way the golden set expects of it is
// not recorded. They run on the mock and say so: a recording made here is labelled the mock's and is never
// shown to a visitor of the real site.
import { MOCK_IDENTITY_PATH, startMockBackend } from '@lb/api-clients/testing'
import type { MockBackend } from '@lb/api-clients/testing'
import { ServiceTokens, privateKeyFromJwk } from '@lb/common/tokens'
import { recordingSchema } from '@lb/contracts'
import type { Recording } from '@lb/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { factOf } from '../../app/boards/lb-04/exchange.ts'
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

/** Shortens a recording's exchanges to `GET /contracts/<id>/pages 200` and so on, to compare them at a glance. */
function outline(recording: Recording): string[] {
  return recording.exchanges.map(exchange => `${exchange.request.method} ${exchange.request.path.replace('/api/lb04', '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>')} ${exchange.response.status}`)
}

/** The state each kept read of the contract showed, in order. */
function statesOf(recording: Recording): string[] {
  return recording.exchanges.flatMap((exchange) => {
    const fact = factOf(exchange)
    return fact?.kind === 'started' || fact?.kind === 'view' ? [fact.view.state] : []
  })
}

beforeAll(async () => {
  mock = await startMockBackend({ siteKey: keys.sitePublic, webKey: keys.webPublic, now: clock.now })
})

beforeEach(() => {
  mock.reset()
})

afterAll(async () => {
  await mock.close()
})

describe('recording LB-04 samples against the mock', () => {
  it('sends the sample, follows the review, reads what the board reads and asks for one redline, in the board\'s order', async () => {
    const recording = await recordSample(backend(), 'lb-04', 'wholesale-supply')

    expect(recordingSchema.safeParse(recording).success).toBe(true)
    expect(recording).toMatchObject({ system: 'lb-04', sample: 'wholesale-supply', origin: 'mock', language: 'en' })
    expect(recording.exchanges[0]?.request.body).toEqual({ from: 'sample', sampleId: 'wholesale-supply' })
    expect(outline(recording)).toEqual([
      'POST /contracts 201',
      'GET /contracts/<id> 200',
      'GET /contracts/<id> 200',
      'GET /contracts/<id> 200',
      'GET /contracts/<id> 200',
      'GET /contracts/<id>/pages 200',
      'GET /contracts/<id>/file 200',
      'GET /contracts/<id>/report 200',
      'POST /contracts/<id>/findings/f1/redline 201',
    ])
  })

  it('keeps one read for each state the review was seen in, in the order it went through them, ending in done', async () => {
    const recording = await recordSample(backend(), 'lb-04', 'wholesale-supply')

    expect(statesOf(recording)).toEqual(['queued', 'extracting', 'analysing', 'verifying', 'done'])
  })

  it('keeps only answers the board accepts, and no query string in any path', async () => {
    for (const sample of ['wholesale-supply', 'clean-supply', 'scanned-supply']) {
      const recording = await recordSample(backend(), 'lb-04', sample)

      for (const exchange of recording.exchanges) {
        expect(factOf(exchange), `${sample}: ${exchange.request.method} ${exchange.request.path}`).toBeDefined()
        expect(exchange.request.path).not.toContain('?')
      }
    }
  })

  it('keeps the PDF the report\'s page text was read from, so the replay can draw the pages it cites', async () => {
    const recording = await recordSample(backend(), 'lb-04', 'wholesale-supply')

    const facts = recording.exchanges.map(exchange => factOf(exchange))
    const file = facts.find(fact => fact?.kind === 'file')
    const pages = facts.find(fact => fact?.kind === 'pages')
    expect(file?.kind === 'file' && Buffer.from(file.file.base64, 'base64').subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(pages?.kind === 'pages' && pages.pages).toHaveLength(11)
  })

  it('keeps the whole trace of the review, with the redline\'s model call nested under the same root span, and counts what it holds', async () => {
    const recording = await recordSample(backend(), 'lb-04', 'wholesale-supply')

    const { spans } = recording.trace
    const roots = spans.filter(span => span.kind === 'system.run' && span.parentId === undefined)
    expect(roots).toHaveLength(1)
    expect(spans.filter(span => span.kind === 'gateway.call').map(span => span.name)).toEqual(['lb-guard', 'lb-long', 'lb-reason', 'lb-fast'])
    const redline = spans.find(span => span.name === 'propose redline')
    expect(redline?.parentId).toBe(roots[0]?.spanId)
    expect(recording.stats.modelCalls).toBe(4)
  })

  it('records a fair contract with nothing to report, and so no redline to ask for', async () => {
    const recording = await recordSample(backend(), 'lb-04', 'clean-supply')

    expect(outline(recording).at(-1)).toBe('GET /contracts/<id>/report 200')
    expect(outline(recording).some(line => line.includes('redline'))).toBe(false)
    const report = recording.exchanges.map(exchange => factOf(exchange)).find(fact => fact?.kind === 'report')
    expect(report?.kind === 'report' && report.report.findings).toEqual([])
  })

  it('records a file the system must refuse ending in its refusal, with no pages, PDF or report to read', async () => {
    const scan = await recordSample(backend(), 'lb-04', 'scanned-supply')
    const tooLong = await recordSample(backend(), 'lb-04', 'master-supply-31')

    expect(statesOf(scan).at(-1)).toBe('failed')
    expect(outline(scan)).toEqual(['POST /contracts 201', 'GET /contracts/<id> 200', 'GET /contracts/<id> 200'])
    const ended = scan.exchanges.map(exchange => factOf(exchange)).at(-1)
    expect(ended?.kind === 'view' && ended.view.failure?.code).toBe('no_text_layer')
    const refused = tooLong.exchanges.map(exchange => factOf(exchange)).at(-1)
    expect(refused?.kind === 'view' && refused.view.failure?.code).toBe('too_many_pages')
  })

  it('labels a recording made on a back end that does not say it is the mock as live', async () => {
    const real: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.pathname === MOCK_IDENTITY_PATH) return Response.json({ error: { code: 'not_found', message: 'There is nothing at this address.' } }, { status: 404 })
      return fetch(input, init)
    }

    const recording = await recordSample(backend(real), 'lb-04', 'clean-supply')

    expect(recording.origin).toBe('live')
  })

  it('refuses a sample that does not exist, naming the samples there are', async () => {
    await expect(recordSample(backend(), 'lb-04', 'no-such-sample')).rejects.toThrow(/no sample called "no-such-sample".*wholesale-supply/)
  })

  it('does not record a sample the back end would not take, and says why', async () => {
    mock.script({ method: 'POST', path: '/api/lb04/contracts', status: 429, json: { error: { code: 'daily_limit', message: 'x' } } })

    await expect(recordSample(backend(), 'lb-04', 'wholesale-supply')).rejects.toThrow(/did not take the sample \(status 429, daily_limit\)/)
  })

  it('does not record a curated sample whose review failed on the model, since a bad ending is to be looked into', async () => {
    mock.lb04.failNext('analysis_unavailable')

    await expect(recordSample(backend(), 'lb-04', 'wholesale-supply')).rejects.toThrow(/should end with a report, but the review ended as analysis_unavailable/)
  })

  it('does not record a refused file that ends any other way than the reason it should be refused for', async () => {
    const otherwise: typeof fetch = async (input, init) => {
      const response = await fetch(input, init)
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (init?.method !== 'GET' || !/\/contracts\/[^/]+$/.test(url.pathname)) return response
      const view = await response.json() as { state: string }
      if (view.state !== 'failed') return Response.json(view)
      return Response.json({ ...view, failure: { code: 'internal', message: 'The review failed on the service\'s side.' } })
    }

    await expect(recordSample(backend(otherwise), 'lb-04', 'scanned-supply')).rejects.toThrow(/should be refused as no_text_layer, but the review ended as internal/)
  })

  it('does not record a redline the back end could not make', async () => {
    const failing: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (init?.method === 'POST' && url.pathname.endsWith('/redline')) return Response.json({ error: { code: 'analysis_unavailable', message: 'x' } }, { status: 503 })
      return fetch(input, init)
    }

    await expect(recordSample(backend(failing), 'lb-04', 'wholesale-supply')).rejects.toThrow(/did not make the redline \(status 503, analysis_unavailable\)/)
  })

  it('gives up on a review that never ends instead of recording half of it', async () => {
    const stuck: typeof fetch = async (input, init) => {
      const response = await fetch(input, init)
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (init?.method !== 'GET' || !/\/contracts\/[^/]+$/.test(url.pathname)) return response
      const view = await response.json() as Record<string, unknown>
      return Response.json({ ...view, state: 'analysing', failure: null })
    }

    await expect(recordSample(backend(stuck), 'lb-04', 'wholesale-supply')).rejects.toThrow('did not end within three minutes')
  })
})
