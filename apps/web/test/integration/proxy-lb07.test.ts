// Integration tests for what LB-07 asks of the site's server: its routes forwarded as the visitor (a run is
// started only after the check), and the one route of the site's own it has, which answers a run's
// screenshot as a picture so the board needs no wider policy to show it. The picture is the service's
// own answer, fetched as the visitor, and it is passed on only when it is a PNG no larger than the service
// keeps: a run that is not the visitor's is the service's own 404, a snapshot is not a picture, and an
// answer that is not a PNG, is too big or does not fit its schema is a 502. The mock back end plays the
// service, so its runs are the ones the tests of the mock check.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { startMockBackend, syntheticScreenshot } from '@lb/api-clients/testing'
import type { MockBackend } from '@lb/api-clients/testing'
import { loadPublicKey, verifyVisitorToken } from '@lb/common/visitors'

import { Browser } from '../support/browser.ts'
import { makeTestKeys, startTestSite } from '../support/site-app.ts'
import type { TestSite } from '../support/site-app.ts'

const keys = makeTestKeys()
const START = Date.UTC(2026, 9, 5, 9, 0, 0)
const clock = { now: START }
const TICK_MS = 50
let mock: MockBackend
let site: TestSite

beforeAll(async () => {
  mock = await startMockBackend({ siteKey: keys.sitePublic, webKey: keys.webPublic, now: () => clock.now, lb07: { tickMs: TICK_MS } })
  site = await startTestSite({ keys, backendUrl: mock.url, clock })
})

afterAll(async () => {
  await site.close()
  await mock.close()
})

beforeEach(() => {
  mock.reset()
  clock.now = START
})

/** A browser that has passed the Turnstile check. */
async function verified(): Promise<Browser> {
  const browser = new Browser(site)
  expect((await browser.verify()).status).toBe(200)
  return browser
}

/** Starts the sample that finds the doubled coupon and lets the mock's clock run until the run has ended. */
async function finishedRun(browser: Browser): Promise<string> {
  const started = await browser.request('POST', '/api/lb07/runs', { body: { from: 'sample', sampleId: 'coupon-double-discount' } })
  expect(started.status).toBe(201)
  const id = started.json.id as string
  clock.now += TICK_MS * 200
  expect((await browser.request('GET', `/api/lb07/runs/${id}`)).json.state).toBe('done')
  return id
}

/** The path of a run's screenshot as a picture. */
function picture(runId: string, evidenceId: string): string {
  return `/api/lb07/runs/${runId}/evidence/${evidenceId}/image`
}

/** A piece of evidence as the service would send it, with a base64 body of the test's choosing. */
function screenshotAnswer(base64: string): Record<string, unknown> {
  return { id: 'e1', kind: 'screenshot', contentType: 'image/png', base64, stepIndex: 8, engine: 'chromium' }
}

describe('LB-07\'s routes through the proxy', () => {
  it('are forwarded as the visitor, with a token for LB-07 alone, and a run starts only after the check', async () => {
    const browser = new Browser(site)
    expect((await browser.request('GET', '/api/lb07/limits')).json.runs.remaining).toBe(2)
    const refused = await browser.request('POST', '/api/lb07/runs', { body: { from: 'sample', sampleId: 'cart-count' } })
    expect(refused.status).toBe(403)
    expect(refused.json.error.code).toBe('verification_required')
    expect(mock.requests.filter(request => request.method === 'POST')).toEqual([])

    expect((await browser.verify()).status).toBe(200)
    const started = await browser.request('POST', '/api/lb07/runs', { body: { from: 'sample', sampleId: 'cart-count' } })
    expect(started.status).toBe(201)
    const token = (mock.requests.at(-1)?.headers.authorization ?? '').replace('Bearer ', '')
    expect(verifyVisitorToken(token, 'lb-07', loadPublicKey(keys.sitePublic), () => clock.now / 1_000).system).toBe('lb-07')
    expect(() => verifyVisitorToken(token, 'lb-06', loadPublicKey(keys.sitePublic), () => clock.now / 1_000)).toThrow()
  })

  it('passes the service\'s refusals on in the platform\'s shape: the day\'s limit with when it starts again, and a busy browser with its wait', async () => {
    const browser = await verified()
    mock.lb07.occupy(4, 60_000)
    const busy = await browser.request('POST', '/api/lb07/runs', { body: { from: 'sample', sampleId: 'cart-count' } })
    expect(busy.status).toBe(503)
    expect(busy.json.error.code).toBe('busy')
    expect(busy.headers.get('retry-after')).toBe('60')
    mock.reset()
    await browser.request('POST', '/api/lb07/runs', { body: { from: 'sample', sampleId: 'cart-count' } })
    await browser.request('POST', '/api/lb07/runs', { body: { from: 'sample', sampleId: 'hostile-goal' } })
    const third = await browser.request('POST', '/api/lb07/runs', { body: { from: 'sample', sampleId: 'clean-shop' } })
    expect(third.status).toBe(429)
    expect(third.json.error).toMatchObject({ code: 'daily_limit', resets_at: '2026-10-06T00:00:00.000Z' })
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0)
  })
})

describe('a screenshot as a picture', () => {
  it('is the run\'s own PNG, answered as image/png that is never sniffed or kept, read as the visitor', async () => {
    const browser = await verified()
    const id = await finishedRun(browser)
    const reply = await browser.request('GET', picture(id, 'e1'))

    expect(reply.status).toBe(200)
    expect(reply.headers.get('content-type')).toBe('image/png')
    expect(reply.headers.get('x-content-type-options')).toBe('nosniff')
    expect(reply.headers.get('cache-control')).toBe('no-store')
    expect(Buffer.from(reply.bytes).equals(syntheticScreenshot(9))).toBe(true)
    const asked = mock.requests.at(-1)
    expect([asked?.method, asked?.path]).toEqual(['GET', `/api/lb07/runs/${id}/evidence/e1`])
    const token = (asked?.headers.authorization ?? '').replace('Bearer ', '')
    expect(verifyVisitorToken(token, 'lb-07', loadPublicKey(keys.sitePublic), () => clock.now / 1_000).system).toBe('lb-07')
  })

  it('is the service\'s own 404 for a run that is someone else\'s, and for a picture the run has not made', async () => {
    const owner = await verified()
    const id = await finishedRun(owner)
    const stranger = new Browser(site)
    const theirs = await stranger.request('GET', picture(id, 'e1'))
    expect(theirs.status).toBe(404)
    expect(theirs.json.error.code).toBe('run_not_found')
    expect(theirs.headers.get('content-type')).toMatch(/^application\/json/)
    const none = await owner.request('GET', picture(id, 'e9'))
    expect(none.status).toBe(404)
    expect(none.json.error.code).toBe('evidence_not_found')
  })

  it('is not a picture when the evidence is the page\'s text', async () => {
    const browser = await verified()
    const id = await finishedRun(browser)
    const reply = await browser.request('GET', picture(id, 'e3'))
    expect(reply.status).toBe(404)
    expect(reply.json.error.code).toBe('not_a_picture')
  })

  it('is refused with a 502 when the service sends something that is not a PNG', async () => {
    const browser = await verified()
    const id = await finishedRun(browser)
    const gif = Buffer.from('GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000;', 'latin1').toString('base64')
    mock.script({ method: 'GET', path: `/api/lb07/runs/${id}/evidence/e1`, json: screenshotAnswer(gif) })
    const reply = await browser.request('GET', picture(id, 'e1'))
    expect(reply.status).toBe(502)
    expect(reply.json.error.code).toBe('upstream_failed')
    expect(reply.headers.get('content-type')).toMatch(/^application\/json/)
  })

  it('is refused with a 502 when the PNG is larger than the service keeps, or the answer larger than the site reads', async () => {
    const browser = await verified()
    const id = await finishedRun(browser)
    const oversize = Buffer.concat([syntheticScreenshot(1), Buffer.alloc(400_001 - syntheticScreenshot(1).length)])
    mock.script({ method: 'GET', path: `/api/lb07/runs/${id}/evidence/e1`, json: screenshotAnswer(oversize.toString('base64')) })
    expect((await browser.request('GET', picture(id, 'e1'))).status).toBe(502)
    mock.script({ method: 'GET', path: `/api/lb07/runs/${id}/evidence/e1`, bytes: 1_200_000, headers: { 'content-type': 'application/json' } })
    expect((await browser.request('GET', picture(id, 'e1'))).status).toBe(502)
  })

  it('is refused with a 502 when the answer does not fit the evidence schema or is not base64', async () => {
    const browser = await verified()
    const id = await finishedRun(browser)
    mock.script({ method: 'GET', path: `/api/lb07/runs/${id}/evidence/e1`, json: { ...screenshotAnswer(syntheticScreenshot(1).toString('base64')), extra: 'field' } })
    expect((await browser.request('GET', picture(id, 'e1'))).status).toBe(502)
    mock.script({ method: 'GET', path: `/api/lb07/runs/${id}/evidence/e1`, json: screenshotAnswer('iVBORw0KGgo*') })
    expect((await browser.request('GET', picture(id, 'e1'))).status).toBe(502)
  })

  it('asks the service nothing for an address that is not a run\'s and an evidence\'s', async () => {
    const browser = await verified()
    for (const path of ['/api/lb07/runs/not-a-run/evidence/e1/image', '/api/lb07/runs/0a1b2c3d-1111-4222-8333-444455556666/evidence/x1/image', '/api/lb07/runs/0a1b2c3d-1111-4222-8333-444455556666/evidence/e1/image/more']) {
      const reply = await browser.request('GET', path)
      expect(reply.status, path).toBe(404)
    }
    expect(mock.requests.filter(request => request.path.includes('/evidence/'))).toEqual([])
    const posted = await browser.request('POST', picture('0a1b2c3d-1111-4222-8333-444455556666', 'e1'), { body: {} })
    expect(posted.status).toBe(404)
  })
})
