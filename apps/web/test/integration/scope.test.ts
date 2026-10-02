// Integration tests for the Scope's route, GET /api/runs/:runId/spans, and for the recordings
// the demos replay, against the mock back end (whose gateway route checks the `web` service's
// token with the gateway's own code). The route is public by run ID, so it needs no session
// and sets no cookie; what comes back is checked again, strictly, before it is passed on.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { startMockBackend } from '@lb/api-clients/testing'
import type { MockBackend } from '@lb/api-clients/testing'
import type { Recording } from '@lb/contracts'

import { Browser } from '../support/browser.ts'
import { rawRequest } from '../support/raw.ts'
import { makeTestKeys, startTestSite } from '../support/site-app.ts'
import type { TestSite } from '../support/site-app.ts'

const keys = makeTestKeys()
const clock = { now: Date.UTC(2026, 9, 5, 9, 0, 0) }
let mock: MockBackend
let site: TestSite

const TICKET = { customer: 'cus-0001', language: 'en', body: 'Hi, my order BB-1040 came a few days ago and one of the two bags of Basalt Blend was ripped open. There were beans all over the box. What can you do?' }

beforeAll(async () => {
  mock = await startMockBackend({ siteKey: keys.sitePublic, webKey: keys.webPublic, now: () => clock.now })
  site = await startTestSite({ keys, backendUrl: mock.url, clock })
})

afterAll(async () => {
  await site.close()
  await mock.close()
})

beforeEach(() => {
  mock.reset()
  clock.now = Date.UTC(2026, 9, 5, 9, 0, 0)
})

/** Files a ticket as a verified visitor, lets its pipeline finish, and returns its run ID. */
async function finishedRun(): Promise<string> {
  const browser = new Browser(site)
  await browser.verify()
  const ticket = (await browser.request('POST', '/api/lb01/tickets', { body: TICKET })).json
  await browser.request('GET', `/api/lb01/tickets/${ticket.id}`)
  await browser.request('GET', `/api/lb01/tickets/${ticket.id}`)
  mock.requests.length = 0
  return ticket.run_id as string
}

describe('a run\'s trace', () => {
  it('is read from the gateway with the web service\'s token, and passed on as the gateway sent it', async () => {
    const runId = await finishedRun()
    const visitor = new Browser(site)

    const reply = await visitor.request('GET', `/api/runs/${runId}/spans`)

    expect(reply.status).toBe(200)
    expect(reply.json).toMatchObject({ runId, more: false, finished: true })
    expect(reply.json.spans.at(-1)).toMatchObject({ kind: 'system.run', name: 'support ticket' })
    expect(reply.json.spans.some((span: { kind: string }) => span.kind === 'gateway.call')).toBe(true)
    expect(mock.requests.map(sent => `${sent.method} ${sent.path}${sent.query}`)).toEqual([`GET /v1/runs/${runId}/spans`])
    expect(mock.requests[0]?.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
  })

  it('needs no session and no Origin, sets no cookie, and is not cached', async () => {
    const runId = await finishedRun()
    const stranger = new Browser(site)

    const reply = await stranger.request('GET', `/api/runs/${runId}/spans`, { origin: null })

    expect(reply.status).toBe(200)
    expect(stranger.setCookies).toEqual([])
    expect(reply.headers.get('cache-control')).toBe('no-store')
    expect(JSON.stringify(mock.requests)).not.toContain('cookie')
  })

  it('follows a run as it goes: nothing until the pipeline writes, then pages with a cursor', async () => {
    const browser = new Browser(site)
    await browser.verify()
    const ticket = (await browser.request('POST', '/api/lb01/tickets', { body: TICKET })).json

    const before = await browser.request('GET', `/api/runs/${ticket.run_id}/spans`)
    await browser.request('GET', `/api/lb01/tickets/${ticket.id}`)
    const during = await browser.request('GET', `/api/runs/${ticket.run_id}/spans?limit=3`)
    await browser.request('GET', `/api/lb01/tickets/${ticket.id}`)
    const rest = await browser.request('GET', `/api/runs/${ticket.run_id}/spans?after=${during.json.cursor}`)

    expect(before.status).toBe(404)
    expect(before.json.error.code).toBe('run_not_found')
    expect(during.json).toMatchObject({ finished: false, more: true })
    expect(during.json.spans).toHaveLength(3)
    expect(rest.json.finished).toBe(true)
    expect(rest.json.spans[0].spanId).not.toBe(during.json.spans[0].spanId)
  })

  it('is a 404 in the platform\'s shape for a run that is not there, and asks nothing of the gateway for an ID that cannot be one', async () => {
    const browser = new Browser(site)

    const unknown = await browser.request('GET', '/api/runs/run-0123456789/spans')
    expect(unknown.status).toBe(404)
    expect(unknown.json).toEqual({ error: { code: 'run_not_found', message: expect.any(String) } })

    mock.reset()
    for (const id of ['short', 'x'.repeat(65), 'run:with:colons', 'run.dots.0123456789', 'run%2f..%2f0123456789']) {
      const reply = await rawRequest(site.url, `/api/runs/${id}/spans`)
      expect(reply.status, id).toBe(404)
    }
    expect(mock.requests).toEqual([])
  })

  it('takes only a cursor and a limit of the right shape', async () => {
    const runId = await finishedRun()
    const browser = new Browser(site)

    for (const query of ['?after=abc', '?after=(1-0', '?after=1-0%20x', '?limit=0', '?limit=501', '?limit=1.5', '?limit=x', '?debug=1', '?after=1-0&after=2-0']) {
      const reply = await browser.request('GET', `/api/runs/${runId}/spans${query}`)
      expect(reply.status, query).toBe(400)
    }
    expect(mock.requests).toEqual([])
    expect((await browser.request('GET', `/api/runs/${runId}/spans?limit=500&after=0-0`)).status).toBe(200)
  })

  it('is a 502 when the gateway sends a page that is not strictly the page it should be', async () => {
    const runId = await finishedRun()
    const browser = new Browser(site)
    const span = { v: 1, runId, system: 'lb-01', spanId: '00000000000000a1', kind: 'system.step', name: 'classify', status: 'ok', startMs: 1, endMs: 2, attrs: {} }
    const page = { runId, spans: [span], cursor: '1-0', more: false, finished: false }
    const bad: unknown[] = [
      { ...page, spans: [{ ...span, prompt: 'my words' }] },
      { ...page, extra: true },
      { ...page, runId: 'run-9999999999' },
      { ...page, cursor: 'nope' },
      { ...page, spans: [{ ...span, attrs: { note: 'x'.repeat(201) } }] },
    ]

    for (const body of bad) {
      mock.script({ json: body })
      const reply = await browser.request('GET', `/api/runs/${runId}/spans`)
      expect(reply.status, JSON.stringify(body).slice(0, 60)).toBe(502)
      expect(reply.text).not.toContain('my words')
    }
  })

  it('is a 502 when the gateway refuses the site\'s service token, 503 when it is unavailable, and never repeats what it said', async () => {
    const browser = new Browser(site)
    mock.script({ status: 401, json: { error: { code: 'invalid_service_token', message: 'The service token is invalid or expired. kid=web' } } })
    mock.script({ status: 403, json: { error: { code: 'permission_denied', message: 'This service may not read run traces.' } } })
    mock.script({ status: 503, json: { error: { code: 'gateway_unavailable', message: 'The trace store is unavailable.' } } })

    const unauthorised = await browser.request('GET', '/api/runs/run-0123456789/spans')
    const forbidden = await browser.request('GET', '/api/runs/run-0123456789/spans')
    const unavailable = await browser.request('GET', '/api/runs/run-0123456789/spans')

    expect([unauthorised.status, forbidden.status, unavailable.status]).toEqual([502, 502, 503])
    expect(unauthorised.text).not.toContain('kid')
    expect(unavailable.json.error.code).toBe('gateway_unavailable')
  })

  it('answers 503 when the deployment has no gateway to ask', async () => {
    const off = await startTestSite({ keys, backendUrl: mock.url, clock, disabled: true })
    try {
      expect((await new Browser(off).request('GET', '/api/runs/run-0123456789/spans')).status).toBe(503)
    }
    finally {
      await off.close()
    }
  })
})

describe('the recordings of the curated samples', () => {
  /** Makes a valid recording of `sample`, made on `origin`. */
  function recording(sample: string, origin: 'live' | 'mock' = 'live', system = 'lb-01'): Recording {
    const runId = 'run-0123456789'
    const span = { v: 1 as const, runId, system, spanId: '00000000000000a1', kind: 'system.run', name: 'support ticket', status: 'ok' as const, startMs: 1_790_000_000_000, endMs: 1_790_000_002_000, attrs: {} }
    return {
      v: 1,
      system,
      sample,
      origin,
      recordedAt: '2026-10-04T09:30:00.000Z',
      language: 'en',
      exchanges: [{ request: { method: 'POST', path: '/api/lb01/tickets', body: { customer: 'cus-0001' } }, response: { status: 202, body: { status: 'received' } } }],
      trace: { runId, spans: [span] },
      stats: { modelCalls: 0, steps: 0, durationMs: 2_000 },
    }
  }

  /** Starts a site that holds these recordings, by `<system>/<sample>`. */
  async function siteWith(recordings: Record<string, unknown>): Promise<TestSite> {
    return startTestSite({ keys, backendUrl: mock.url, clock, recordings })
  }

  it('lists the samples that have a recording a visitor may be shown, in name order (the test build also shows the mock\'s)', async () => {
    const holding = await siteWith({
      'lb-01/torn-bag': recording('torn-bag'),
      'lb-01/late-parcel': recording('late-parcel'),
      'lb-01/mock-one': recording('mock-one', 'mock'),
      'lb-01/broken': { v: 1, nonsense: true },
      'lb-01/wrong-name': recording('another-sample'),
      'lb-05/question': recording('question', 'live', 'lb-05'),
    })
    try {
      const browser = new Browser(holding)

      const list = await browser.request('GET', '/api/recordings/lb-01')

      expect(list.status).toBe(200)
      expect(list.json).toEqual({ system: 'lb-01', samples: ['late-parcel', 'mock-one', 'torn-bag'] })
      expect(list.headers.get('cache-control')).toBe('public, max-age=300')
      expect(browser.setCookies).toEqual([])
      expect((await browser.request('GET', '/api/recordings/lb-02')).json).toEqual({ system: 'lb-02', samples: [] })
    }
    finally {
      await holding.close()
    }
  })

  it('says there is none when none was made, so the board can offer the live run', async () => {
    const browser = new Browser(site)

    expect((await browser.request('GET', '/api/recordings/lb-01')).json).toEqual({ system: 'lb-01', samples: [] })
    expect((await browser.request('GET', '/api/recordings/lb-01/torn-bag')).status).toBe(404)
  })

  it('sends one recording, checked with its schema, and never a damaged one or another sample\'s (the test build also sends a mock\'s)', async () => {
    const holding = await siteWith({
      'lb-01/torn-bag': recording('torn-bag'),
      'lb-01/mock-one': recording('mock-one', 'mock'),
      'lb-01/broken': { v: 1 },
      'lb-01/wrong-name': recording('another-sample'),
    })
    try {
      const browser = new Browser(holding)

      const sent = await browser.request('GET', '/api/recordings/lb-01/torn-bag')
      expect(sent.status).toBe(200)
      expect(sent.json).toEqual(recording('torn-bag'))
      expect((await browser.request('GET', '/api/recordings/lb-01/mock-one')).json).toEqual(recording('mock-one', 'mock'))
      for (const sample of ['broken', 'wrong-name', 'nothing-here']) {
        const reply = await browser.request('GET', `/api/recordings/lb-01/${sample}`)
        expect(reply.status, sample).toBe(404)
        expect(reply.json.error.code).toBe('not_found')
      }
    }
    finally {
      await holding.close()
    }
  })

  it('refuses a system or a sample named in a way that could reach another file', async () => {
    const holding = await siteWith({ 'lb-01/torn-bag': recording('torn-bag') })
    try {
      const browser = new Browser(holding)

      for (const path of ['/api/recordings/LB-01', '/api/recordings/lb-1', '/api/recordings/lb-01/Torn-Bag', '/api/recordings/lb-01/torn_bag', `/api/recordings/lb-01/${'x'.repeat(61)}`, '/api/recordings/..']) {
        expect((await browser.request('GET', path)).status, path).toBe(404)
      }
      expect((await rawRequest(holding.url, '/api/recordings/lb-01/..%2f..%2fetc%2fpasswd')).status).toBe(404)
    }
    finally {
      await holding.close()
    }
  })
})
