// End-to-end tests for the site's one address and its bare /api, against the real build, so the
// whole path is the production one: Nitro's middleware, the API handlers and the page renderer.
// The end-to-end server is started with NUXT_LB_SITE_ORIGIN set to its own address (e2e/support/serve.ts),
// as the production site is with its own domain (docs/DEPLOY.md, part 10). A request says which host it was
// made for the way Vercel reports it, in X-Forwarded-Host, so no DNS is needed.
import { expect, test } from './fixtures'

// The one address of the site in these tests: where Playwright's baseURL points.
const SITE = `http://127.0.0.1:${process.env.E2E_PORT ?? 3100}`

/** Asks for a path as a request made for another host, and keeps the redirect instead of following it. */
function askedFor(host: string) {
  return { headers: { 'x-forwarded-host': host, 'x-forwarded-proto': 'https' }, maxRedirects: 0 }
}

test.describe('a visitor who comes by another address', () => {
  for (const host of ['www.example.test', 'my-site-git-main-me.vercel.app']) {
    test(`is sent from ${host} to the site's own address, on the same page`, async ({ request }) => {
      for (const path of ['/', '/cs/systems/lb-01?tab=trace', '/api/session']) {
        const reply = await request.get(path, askedFor(host))

        expect(reply.status(), `${host}${path}`).toBe(308)
        expect(reply.headers().location, `${host}${path}`).toBe(`${SITE}${path}`)
        expect(reply.headers()['set-cookie'], `${host}${path}`).toBeUndefined()
        expect(reply.headers()['cache-control'], `${host}${path}`).toBe('no-store')
        // The redirect is an answer of the site like any other: the first one a browser gets from `www.` is the one that
        // tells it to use HTTPS there from then on.
        expect(reply.headers()['strict-transport-security'], `${host}${path}`).toContain('max-age=63072000')
        expect(reply.headers()['x-content-type-options'], `${host}${path}`).toBe('nosniff')
        expect(reply.headers()['x-frame-options'], `${host}${path}`).toBe('DENY')
      }
    })
  }

  test('gets no session, and so no quota, at the other address: nothing there asks the back end', async ({ request }) => {
    const reply = await request.post('/api/session/verify', { ...askedFor('www.example.test'), data: { token: 'x' } })

    expect(reply.status()).toBe(308)
    expect(reply.headers()['set-cookie']).toBeUndefined()
  })

  test('is not sent anywhere when the site\'s own address is used', async ({ request }) => {
    for (const path of ['/', '/api/session']) {
      const reply = await request.get(path, askedFor(`127.0.0.1:${process.env.E2E_PORT ?? 3100}`))

      expect(reply.status(), path).toBe(200)
    }
  })
})

test.describe('the bare /api', () => {
  for (const path of ['/api', '/api?x=1', '/api/', '/api/nothing']) {
    test(`answers ${path} in the platform's error shape, like every unknown path under it`, async ({ request }) => {
      const reply = await request.get(path)

      expect(reply.status()).toBe(404)
      expect(reply.headers()['content-type']).toContain('application/json')
      expect(await reply.json()).toEqual({ error: { code: 'not_found', message: expect.any(String) } })
    })
  }
})
