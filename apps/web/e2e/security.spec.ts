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
