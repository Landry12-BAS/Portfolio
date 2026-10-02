// Integration tests for the anonymous session and the Turnstile check, over HTTP, as
// docs/SECURITY.md, section 2 describes them: a random ID in a signed `__Host-` cookie, rotated
// daily, a hash of it (never the ID) as the visitor's name to the back ends, an invisible check
// before the first AI run, and an Origin check on everything that changes something.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { startMockBackend } from '@lb/api-clients/testing'
import type { MockBackend } from '@lb/api-clients/testing'

import { Browser } from '../support/browser.ts'
import { makeTestKeys, startTestSite } from '../support/site-app.ts'
import type { TestSite } from '../support/site-app.ts'

const keys = makeTestKeys()
// One clock for the site and the back end, so a token the site stamps is read at the same moment.
const clock = { now: Date.UTC(2026, 9, 5, 9, 0, 0) }
let mock: MockBackend
let site: TestSite

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
  site.turnstile.answer = 'pass'
  site.turnstile.seen.length = 0
  site.clock.now = Date.UTC(2026, 9, 5, 9, 0, 0)
})

describe('the session cookie', () => {
  it('is set on the first call to the API, and is the only cookie the site ever sets', async () => {
    const browser = new Browser(site)

    await browser.request('GET', '/api/session')
    await browser.request('GET', '/api/lb01/customers')
    await browser.verify()
    await browser.request('POST', '/api/lb01/tickets', { body: { customer: 'cus-0001', language: 'en', body: 'Hello' } })

    const names = new Set(browser.setCookies.map(line => line.split('=')[0]))
    expect([...names]).toEqual(['__Host-lb_session'])
  })

  it('has the flags the security design asks for: __Host-, HttpOnly, Secure, SameSite=Strict, the whole site, and no domain', async () => {
    const browser = new Browser(site)

    await browser.request('GET', '/api/session')

    const cookie = browser.setCookies[0] ?? ''
    expect(cookie).toMatch(/^__Host-lb_session=v1\.[\w-]+\.[\w-]{43};/)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Path=/')
    expect(cookie.toLowerCase()).not.toContain('domain')
  })

  it('lasts until the day\'s end, when the quotas start again', async () => {
    const browser = new Browser(site)

    await browser.request('GET', '/api/session')

    // 09:00 UTC: fifteen hours to midnight.
    expect(browser.setCookies[0]).toContain(`Max-Age=${15 * 3_600}`)
  })

  it('is set by nothing that does not need a session: a deployment with no back end, and the recordings and traces', async () => {
    const off = await startTestSite({ keys, backendUrl: mock.url, disabled: true })
    try {
      const browser = new Browser(off)
      const state = await browser.request('GET', '/api/session')

      expect(state.json).toMatchObject({ available: false, verified: false, siteKey: null })
      await browser.request('GET', '/api/recordings/lb-01')
      expect(browser.setCookies).toEqual([])
    }
    finally {
      await off.close()
    }
  })

  it('keeps the same session across calls, and tells each browser apart', async () => {
    const first = new Browser(site)
    const second = new Browser(site)

    await first.request('GET', '/api/session')
    const idBefore = first.session
    await first.request('GET', '/api/lb01/customers')
    await second.request('GET', '/api/session')

    expect(first.session).toBe(idBefore)
    expect(second.session).not.toBe(first.session)
    expect(first.setCookies).toHaveLength(1)
  })

  it('is replaced by a new one the next day, so the ID rotates when the quotas turn over', async () => {
    const browser = new Browser(site)
    await browser.request('GET', '/api/session')
    const monday = browser.session

    site.clock.now += 24 * 3_600_000
    await browser.request('GET', '/api/session')

    expect(browser.session).not.toBe(monday)
    expect(browser.setCookies).toHaveLength(2)
  })

  it('is ignored when it has been changed, when another site made it and when it is not one', async () => {
    const browser = new Browser(site)
    await browser.request('GET', '/api/session')
    const original = browser.session ?? ''
    const [version, payload, signature] = original.split('.')
    const forged = [version, Buffer.from(JSON.stringify({ i: 'AAAAAAAAAAAAAAAAAAAAAA', d: '2026-10-05', v: 1 })).toString('base64url'), signature].join('.')
    const otherSite = await startTestSite({ keys, backendUrl: mock.url, clock })
    const stranger = new Browser(otherSite)
    await stranger.request('GET', '/api/session')
    const foreign = stranger.session ?? ''
    await otherSite.close()

    for (const planted of [forged, foreign, 'v1.x.y', `${version}.${payload}.${signature.slice(0, -2)}AA`, '', 'garbage', `v2.${payload}.${signature}`]) {
      const visitor = new Browser(site)
      visitor.cookies.set('__Host-lb_session', planted)
      const state = await visitor.request('GET', '/api/session')

      expect(state.json.verified, planted.slice(0, 12)).toBe(false)
      // A new session was started: a planted one is never adopted.
      expect(visitor.session).not.toBe(planted)
      expect(visitor.session).toMatch(/^v1\./)
    }
  })

  it('cannot be fixed by an attacker: a verified cookie from one browser stays one session, and one with a stale day is dropped', async () => {
    const attacker = new Browser(site)
    await attacker.request('GET', '/api/session')
    const planted = attacker.session ?? ''
    site.clock.now += 24 * 3_600_000

    const victim = new Browser(site)
    victim.cookies.set('__Host-lb_session', planted)
    await victim.request('GET', '/api/session')

    expect(victim.session).not.toBe(planted)
  })
})

describe('the visitor token the back ends see', () => {
  it('names the visitor by a keyed hash of the session, never by the session cookie, and is for one system and five minutes', async () => {
    const browser = new Browser(site)
    await browser.request('GET', '/api/lb01/customers')

    const token = (mock.requests[0]?.headers.authorization ?? '').replace('Bearer ', '')
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
    const cookie = browser.session ?? ''
    const sessionId = JSON.parse(Buffer.from(cookie.split('.')[1] ?? '', 'base64url').toString('utf8')).i as string

    expect(claims).toEqual({ iss: 'lb-web', aud: 'lb-01', sub: expect.stringMatching(/^[\w-]{43}$/), iat: expect.any(Number), exp: expect.any(Number) })
    expect((claims.exp as number) - (claims.iat as number)).toBe(300)
    expect(claims.sub).not.toBe(sessionId)
    expect(token).not.toContain(sessionId)
    expect(JSON.stringify(mock.requests)).not.toContain(sessionId)
  })

  it('is the same visitor on every call of a session, another visitor for another session, and a new one the next day', async () => {
    const first = new Browser(site)
    const second = new Browser(site)
    const subjects: string[] = []
    const subjectOfLast = () => JSON.parse(Buffer.from((mock.requests.at(-1)?.headers.authorization ?? '').split('.')[1] ?? '', 'base64url').toString('utf8')).sub as string

    await first.request('GET', '/api/lb01/customers')
    subjects.push(subjectOfLast())
    await first.request('GET', '/api/lb01/tickets')
    subjects.push(subjectOfLast())
    await second.request('GET', '/api/lb01/customers')
    subjects.push(subjectOfLast())
    site.clock.now += 24 * 3_600_000
    await first.request('GET', '/api/lb01/customers')
    subjects.push(subjectOfLast())

    expect(subjects[0]).toBe(subjects[1])
    expect(subjects[2]).not.toBe(subjects[0])
    expect(subjects[3]).not.toBe(subjects[0])
  })
})

describe('Turnstile', () => {
  it('asks Cloudflare about the token, and marks the session verified when it is real', async () => {
    const browser = new Browser(site)
    await browser.request('GET', '/api/session')
    expect((await browser.request('GET', '/api/session')).json.verified).toBe(false)

    const reply = await browser.verify('the-token')

    expect(reply.status).toBe(200)
    expect(reply.json).toMatchObject({ available: true, verified: true })
    expect(site.turnstile.seen).toEqual(['the-token'])
    expect((await browser.request('GET', '/api/session')).json.verified).toBe(true)
  })

  it('stays verified for the rest of the day, and not into the next', async () => {
    const browser = new Browser(site)
    await browser.verify()

    site.clock.now += 14 * 3_600_000
    expect((await browser.request('GET', '/api/session')).json.verified).toBe(true)
    site.clock.now += 2 * 3_600_000
    expect((await browser.request('GET', '/api/session')).json.verified).toBe(false)
  })

  it('refuses a token Cloudflare refuses, and a token solved on another site, without saying why', async () => {
    for (const answer of ['fail', 'wrong-host'] as const) {
      const browser = new Browser(site)
      site.turnstile.answer = answer

      const reply = await browser.verify('bad-token')

      expect(reply.status, answer).toBe(403)
      expect(reply.json).toEqual({ error: { code: 'verification_failed', message: expect.any(String) } })
      expect((await browser.request('GET', '/api/session')).json.verified).toBe(false)
      expect(reply.text).not.toContain('bad-token')
    }
  })

  it('accepts a token solved on this site, when Cloudflare names the hostname', async () => {
    site.turnstile.answer = 'pass-with-host'

    expect((await new Browser(site).verify()).status).toBe(200)
  })

  it('fails closed when Cloudflare cannot be asked: the visitor is told the check could not run, and is not let in', async () => {
    const browser = new Browser(site)
    site.turnstile.answer = 'down'

    const reply = await browser.verify()

    expect(reply.status).toBe(503)
    expect(reply.json.error.code).toBe('unavailable')
    expect((await browser.request('GET', '/api/session')).json.verified).toBe(false)
  })

  it('accepts the fixed stand-in token in the test build, which asks Cloudflare nothing', async () => {
    const browser = new Browser(site)

    const reply = await browser.verify('lb-test-turnstile-stand-in')

    expect(reply.status).toBe(200)
    expect(site.turnstile.seen).toEqual([])
  })

  it('refuses a body that is not {"token": ...}, a token that is too long and a body that is too big', async () => {
    const browser = new Browser(site)

    expect((await browser.request('POST', '/api/session/verify', { body: {} })).status).toBe(400)
    expect((await browser.request('POST', '/api/session/verify', { body: { token: '' } })).status).toBe(400)
    expect((await browser.request('POST', '/api/session/verify', { body: { token: 'x'.repeat(2_049) } })).status).toBe(400)
    expect((await browser.request('POST', '/api/session/verify', { body: { token: 'x', extra: 1 } })).status).toBe(400)
    expect((await browser.request('POST', '/api/session/verify', { raw: { text: JSON.stringify({ token: 'x'.repeat(5_000) }) } })).status).toBe(413)
    expect((await browser.request('POST', '/api/session/verify', { raw: { text: 'nope' } })).status).toBe(400)
    expect(site.turnstile.seen).toEqual([])
  })

  it('answers 503 when the deployment has no back end', async () => {
    const off = await startTestSite({ keys, backendUrl: mock.url, disabled: true })
    try {
      const reply = await new Browser(off).verify()

      expect(reply.status).toBe(503)
    }
    finally {
      await off.close()
    }
  })
})

describe('the Origin check', () => {
  it('lets a read through without an Origin, and refuses a change that comes from anywhere else', async () => {
    const browser = new Browser(site)

    expect((await browser.request('GET', '/api/session', { origin: null })).status).toBe(200)
    for (const origin of [null, 'null', 'https://evil.example', 'http://127.0.0.1:1', `${site.origin}.evil.example`, 'not a url']) {
      const reply = await browser.request('POST', '/api/session/verify', { body: { token: 'x' }, origin })
      expect(reply.status, String(origin)).toBe(403)
      expect(reply.json.error.code).toBe('forbidden_origin')
    }
    expect(site.turnstile.seen).toEqual([])
  })

  it('refuses a change a browser says is cross-site, even when the Origin header seems right', async () => {
    const browser = new Browser(site)

    for (const fetchSite of ['cross-site', 'same-site', 'none']) {
      const reply = await browser.request('POST', '/api/session/verify', { body: { token: 'x' }, headers: { 'sec-fetch-site': fetchSite } })
      expect(reply.status, fetchSite).toBe(403)
    }
    expect((await browser.request('POST', '/api/session/verify', { body: { token: 'x' }, headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200)
  })

  it('names the site by the host and scheme a proxy such as Vercel\'s reports', async () => {
    const browser = new Browser(site)
    const reply = await browser.request('POST', '/api/session/verify', {
      body: { token: 'x' },
      origin: 'https://www.example.com',
      headers: { 'x-forwarded-host': 'www.example.com', 'x-forwarded-proto': 'https' },
    })

    expect(reply.status).toBe(200)
  })

  it('sends no CORS header on any answer, so no other site can read one', async () => {
    const browser = new Browser(site)

    for (const reply of [await browser.request('GET', '/api/session'), await browser.request('GET', '/api/lb01/customers'), await browser.request('GET', '/api/nothing'), await browser.request('POST', '/api/session/verify', { origin: 'https://evil.example', body: {} })]) {
      expect([...reply.headers.keys()].filter(name => name.startsWith('access-control'))).toEqual([])
    }
  })
})
