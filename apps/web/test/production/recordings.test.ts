// What a production build does about recordings: shows only those made on the live back end. This
// project runs with `__LB_TEST_BUILD__` false, as the production build has it, so a recording that
// says it came from the test mock is as good as missing, however it got into the site's files.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startMockBackend } from '@lb/api-clients/testing'
import type { MockBackend } from '@lb/api-clients/testing'
import type { Recording } from '@lb/contracts'

import { Browser } from '../support/browser.ts'
import { makeTestKeys, startTestSite } from '../support/site-app.ts'
import type { TestSite } from '../support/site-app.ts'

const keys = makeTestKeys()
let mock: MockBackend
let site: TestSite

/** Makes a valid recording of `sample`, made on `origin`. */
function recording(sample: string, origin: 'live' | 'mock'): Recording {
  const runId = 'run-0123456789'
  const span = { v: 1 as const, runId, system: 'lb-01', spanId: '00000000000000a1', kind: 'system.run', name: 'support ticket', status: 'ok' as const, startMs: 1_790_000_000_000, endMs: 1_790_000_002_000, attrs: {} }
  return {
    v: 1,
    system: 'lb-01',
    sample,
    origin,
    recordedAt: '2026-10-04T09:30:00.000Z',
    language: 'en',
    exchanges: [{ request: { method: 'POST', path: '/api/lb01/tickets', body: { customer: 'cus-0001' } }, response: { status: 202, body: { status: 'received' } } }],
    trace: { runId, spans: [span] },
    stats: { modelCalls: 0, steps: 0, durationMs: 2_000 },
  }
}

beforeAll(async () => {
  mock = await startMockBackend({ siteKey: keys.sitePublic, webKey: keys.webPublic })
  site = await startTestSite({ keys, backendUrl: mock.url, recordings: { 'lb-01/torn-bag': recording('torn-bag', 'live'), 'lb-01/mock-one': recording('mock-one', 'mock') } })
})

afterAll(async () => {
  await site.close()
  await mock.close()
})

describe('a production build and recordings', () => {
  it('knows the build flag is false', () => {
    expect(__LB_TEST_BUILD__).toBe(false)
  })

  it('lists only the recordings made on the live back end', async () => {
    const browser = new Browser(site)

    expect((await browser.request('GET', '/api/recordings/lb-01')).json).toEqual({ system: 'lb-01', samples: ['torn-bag'] })
  })

  it('sends a live recording and never one that came from the test mock', async () => {
    const browser = new Browser(site)

    expect((await browser.request('GET', '/api/recordings/lb-01/torn-bag')).json).toEqual(recording('torn-bag', 'live'))
    const refused = await browser.request('GET', '/api/recordings/lb-01/mock-one')
    expect(refused.status).toBe(404)
    expect(refused.json.error.code).toBe('not_found')
  })
})
