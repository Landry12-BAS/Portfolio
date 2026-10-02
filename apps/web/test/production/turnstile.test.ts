// What a production build does about the test build's stand-in for a Turnstile token: nothing. This
// project runs with `__LB_TEST_BUILD__` false, as the production build has it, and shows that the
// stand-in is just another token that Cloudflare is asked about, and that the session state tells
// the browser to use the real widget. (`scripts/check-production-build.ts` shows the other half: that
// the production bundle holds no trace of the stand-in at all.)
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startMockBackend } from '@lb/api-clients/testing'
import type { MockBackend } from '@lb/api-clients/testing'

import { TEST_TURNSTILE_STAND_IN } from '../../server/lib/turnstile-test.ts'
import { verifyTurnstile } from '../../server/lib/turnstile.ts'
import { Browser } from '../support/browser.ts'
import { makeTestKeys, startTestSite } from '../support/site-app.ts'
import type { TestSite } from '../support/site-app.ts'

const keys = makeTestKeys()
let mock: MockBackend
let site: TestSite

beforeAll(async () => {
  mock = await startMockBackend({ siteKey: keys.sitePublic, webKey: keys.webPublic })
  site = await startTestSite({ keys, backendUrl: mock.url })
})

afterAll(async () => {
  await site.close()
  await mock.close()
})

describe('a production build', () => {
  it('knows the build flag is false', () => {
    expect(__LB_TEST_BUILD__).toBe(false)
  })

  it('asks Cloudflare about the test build\'s stand-in token, and refuses it when Cloudflare does', async () => {
    const asked: string[] = []
    const cloudflare: typeof fetch = async (_input, init) => {
      asked.push(new URLSearchParams(String(init?.body)).get('response') ?? '')
      return Response.json({ 'success': false, 'error-codes': ['invalid-input-response'] })
    }

    const verdict = await verifyTurnstile(TEST_TURNSTILE_STAND_IN, { secret: 'secret', hostname: 'example.com', fetch: cloudflare })

    expect(verdict).toBe('failed')
    expect(asked).toEqual([TEST_TURNSTILE_STAND_IN])
  })

  it('does not let a visitor in with the stand-in: the verify route refuses it, and the session stays unverified', async () => {
    const browser = new Browser(site)
    site.turnstile.answer = 'fail'

    const reply = await browser.verify(TEST_TURNSTILE_STAND_IN)

    expect(reply.status).toBe(403)
    expect(site.turnstile.seen).toEqual([TEST_TURNSTILE_STAND_IN])
    expect((await browser.request('GET', '/api/session')).json).toMatchObject({ verified: false, testMode: false, siteKey: 'site-key-for-tests' })
  })

  it('tells the browser to show the real widget, with the real site key', async () => {
    const state = (await new Browser(site).request('GET', '/api/session')).json

    expect(state).toMatchObject({ available: true, testMode: false, siteKey: 'site-key-for-tests' })
  })
})
