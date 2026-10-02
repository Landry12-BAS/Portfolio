// End-to-end tests for the security headers from docs/SECURITY.md, and for the site's
// promise to set no cookies.
import { expect, test } from './fixtures'

test.describe('security headers (docs/SECURITY.md, section 3)', () => {
  test('every page carries the strict policy with a fresh nonce', async ({ request }) => {
    const [first, second] = await Promise.all([request.get('/'), request.get('/systems/lb-01')])
    const csp = first.headers()['content-security-policy'] ?? ''

    expect(csp).toMatch(/script-src 'self' 'strict-dynamic' 'nonce-[\w+/=-]{16,}'/)
    expect(csp).toContain('require-trusted-types-for \'script\'')
    expect(csp).toContain('trusted-types vue')
    expect(csp).toContain('frame-ancestors \'none\'')
    expect(csp).toContain('object-src \'none\'')
    expect(csp).toContain('base-uri \'none\'')

    const nonce = (policy: string) => policy.match(/'nonce-([^']+)'/)?.[1]
    expect(nonce(csp)).not.toEqual(nonce(second.headers()['content-security-policy'] ?? ''))

    const headers = first.headers()
    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(headers['cross-origin-opener-policy']).toBe('same-origin')
    expect(headers['cross-origin-resource-policy']).toBe('same-origin')
    expect(headers['permissions-policy']).toContain('microphone=()')
    expect(headers['strict-transport-security']).toContain('max-age=63072000')
    expect(headers['access-control-allow-origin']).toBeUndefined()
    expect(headers['x-powered-by']).toBeUndefined()
  })

  test('the pages set no cookies, in either language', async ({ page, context }) => {
    await page.goto('/')
    await page.goto('/systems/lb-03')
    await page.goto('/cs')
    await page.goto('/cs/systems/lb-03')
    expect(await context.cookies()).toEqual([])
  })
})

test.describe('the policy of LB-02\'s board pages (docs/SECURITY.md, section 3)', () => {
  // The WebSocket origin the end-to-end server's API listens on, which the site names in the policy of these pages only.
  const socket = `ws://127.0.0.1:${process.env.E2E_MOCK_PORT ?? 8121}`

  for (const path of ['/systems/lb-02/board', '/cs/systems/lb-02/board']) {
    test(`${path} adds the API's WebSocket, the service worker's policy and the worker source, and nothing wide`, async ({ request }) => {
      const csp = (await request.get(path)).headers()['content-security-policy'] ?? ''
      expect(csp).toContain(`connect-src 'self' ${socket}`)
      expect(csp).toContain('trusted-types vue lb-turnstile lb-service-worker')
      expect(csp).toContain('worker-src \'self\'')
      expect(csp).toContain('frame-src https://challenges.cloudflare.com')
      expect(csp).toContain('require-trusted-types-for \'script\'')
      expect(csp).toMatch(/script-src 'self' 'strict-dynamic' 'nonce-[\w+/=-]{16,}'/)
      expect(csp).not.toContain('*')
      expect(csp).not.toMatch(/unsafe-eval|allow-duplicates/)
      const trusted = csp.split(';').map(part => part.trim()).find(part => part.startsWith('trusted-types ')) ?? ''
      expect(trusted.split(' ')).not.toContain('default')
    })
  }

  for (const path of ['/', '/cs', '/systems/lb-02', '/cs/systems/lb-02', '/systems/lb-01/board', '/cs/systems/lb-01/board', '/systems/lb-03']) {
    test(`${path} does not get them`, async ({ request }) => {
      const csp = (await request.get(path)).headers()['content-security-policy'] ?? ''
      expect(csp).toContain('connect-src \'self\';')
      expect(csp).not.toContain('lb-service-worker')
      expect(csp).not.toContain('worker-src')
      expect(csp).not.toContain('ws://')
    })
  }

  test('serves the worker as a script of the site\'s own, with no wider scope than its place allows', async ({ request }) => {
    const answer = await request.get('/lb02-sw.js')
    expect(answer.ok()).toBe(true)
    expect(answer.headers()['content-type']).toMatch(/javascript/)
    expect(answer.headers()['service-worker-allowed']).toBeUndefined()
    expect(await answer.text()).toContain('lb02-shell-v1')
  })
})
