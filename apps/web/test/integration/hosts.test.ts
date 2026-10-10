// Integration tests for the site's one address, through the same middleware the running site uses. Every
// other host that reaches the site (`www.`, the `*.vercel.app` addresses) would otherwise be a site of its
// own, with its own session cookie and so its own quota, so each is sent on to the address the site is
// configured with, whatever the request was. A site configured with none (a preview) answers on any host.
// The bare `/api` is an API path like `/api/` and answers in the platform's error shape.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startMockBackend } from '@lb/api-clients/testing'
import type { MockBackend } from '@lb/api-clients/testing'

import { rawRequest } from '../support/raw.ts'
import { makeTestKeys, startTestSite } from '../support/site-app.ts'
import type { TestSite } from '../support/site-app.ts'

const keys = makeTestKeys()
const SITE = 'https://example.com'
let mock: MockBackend
let single: TestSite
let open: TestSite

beforeAll(async () => {
  mock = await startMockBackend({ siteKey: keys.sitePublic, webKey: keys.webPublic })
  single = await startTestSite({ keys, backendUrl: mock.url, siteOrigin: SITE })
  open = await startTestSite({ keys, backendUrl: mock.url })
})

afterAll(async () => {
  await single.close()
  await open.close()
  await mock.close()
})

/** Asks the site for a path as a request that came in for `host`, the way Vercel reports it. */
async function asked(site: TestSite, path: string, host: string, options: { method?: string, proto?: string } = {}) {
  return rawRequest(site.url, path, { method: options.method, headers: { 'x-forwarded-host': host, 'x-forwarded-proto': options.proto ?? 'https' } })
}

describe('a site with one address', () => {
  it.each(['www.example.com', 'my-site-git-main-me.vercel.app', 'my-site.vercel.app', 'example.org', '127.0.0.1:3000'])('sends %s on to it, with the same path and query', async (host) => {
    const reply = await asked(single, '/systems/lb-01/board?sample=torn-bag&lang=cs', host)

    expect(reply.status).toBe(308)
    expect(reply.headers.location).toBe(`${SITE}/systems/lb-01/board?sample=torn-bag&lang=cs`)
  })

  it('sends the API on too, whatever the method, so a script that learns the one address keeps its request', async () => {
    for (const method of ['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS']) {
      const reply = await asked(single, '/api/session', 'www.example.com', { method })

      expect(reply.status, method).toBe(308)
      expect(reply.headers.location, method).toBe(`${SITE}/api/session`)
    }
  })

  it('sends nothing on that is already on it, however the host is written', async () => {
    for (const host of ['example.com', 'EXAMPLE.com', 'Example.Com']) {
      const reply = await asked(single, '/api/session', host)

      expect(reply.status, host).toBe(200)
    }
  })

  it('is not fooled by an address that only looks like it', async () => {
    for (const host of ['example.com.evil.example', 'evilexample.com', 'example.com:8443', 'example.com.', 'xn--example.com', 'example.com@evil.example', 'example.com evil.example']) {
      const reply = await asked(single, '/', host)

      expect(reply.status, host).toBe(308)
      expect(reply.headers.location, host).toBe(`${SITE}/`)
    }
  })

  it('always sends a visitor to its own address, whatever the path says', async () => {
    const paths = ['//evil.example/x', '/\\evil.example', '/%0d%0aSet-Cookie:%20x=1', '/https://evil.example/', '/..//evil.example', '//evil.example', '/?next=https://evil.example']

    for (const path of paths) {
      const reply = await asked(single, path, 'www.example.com')

      expect(reply.status, path).toBe(308)
      const location = String(reply.headers.location)
      expect(location.startsWith(`${SITE}/`), path).toBe(true)
      expect(new URL(location).origin, path).toBe(SITE)
      expect(Object.keys(reply.headers), path).not.toContain('set-cookie')
    }
  })

  it('says nothing but where to go: no cookie, nothing cached, no body', async () => {
    const reply = await asked(single, '/systems/lb-01', 'www.example.com')

    expect(reply.headers['set-cookie']).toBeUndefined()
    expect(reply.headers['cache-control']).toBe('no-store')
    expect(reply.text).toBe('')
  })

  it('never reaches a back end for a request it sends on', async () => {
    mock.reset()

    await asked(single, '/api/lb01/tickets', 'www.example.com', { method: 'POST' })
    await asked(single, '/api/runs/run-0123456789/spans', 'www.example.com')

    expect(mock.requests).toEqual([])
  })
})

describe('a site with no address set, as a preview is', () => {
  it('answers on any host, and sends nothing anywhere', async () => {
    for (const host of ['www.example.com', 'my-site.vercel.app', 'anything.test']) {
      const reply = await asked(open, '/api/session', host)

      expect(reply.status, host).toBe(200)
      expect(reply.headers.location, host).toBeUndefined()
    }
  })
})

describe('the bare /api', () => {
  it.each(['/api', '/api?x=1', '/api/', '/api/?x=1', '/api/nothing'])('answers %s with the platform\'s 404, as every unknown path under it does, and never a 503', async (path) => {
    for (const site of [single, open]) {
      const reply = await asked(site, path, 'example.com')

      expect(reply.status, path).toBe(404)
      expect(JSON.parse(reply.text), path).toEqual({ error: { code: 'not_found', message: expect.any(String) } })
    }
  })
})
