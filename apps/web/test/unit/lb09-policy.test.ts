// Tests of what LB-09's board pages add to the site's security headers: the API's WebSocket origin and
// the browser's own recordings (blob:) as media in the Content Security Policy and the microphone in the
// Permissions-Policy, on those two pages only,
// each as small as it can be. The rules start as nuxt.config.ts gives them to the other boards.
import { describe, expect, it } from 'vitest'
import { LB09_BOARD_PAGE_ROUTES } from '../../shared/lb09-app.ts'
import type { SecurityRules } from '../../server/lib/lb02-csp.ts'
import { addLb09Policy, LB09_PERMISSIONS_POLICY } from '../../server/lib/lb09-policy.ts'

/** The rules as the other boards and every page have them. */
function baseRules(): SecurityRules {
  return {
    '/**': { headers: { contentSecurityPolicy: { 'connect-src': ['\'self\''], 'default-src': ['\'self\''], 'trusted-types': ['vue'] }, permissionsPolicy: { camera: [], microphone: [] } } },
    '/systems/*/board': { headers: { contentSecurityPolicy: { 'frame-src': ['https://challenges.cloudflare.com'], 'trusted-types': ['vue', 'lb-turnstile'] } } },
    '/cs/systems/*/board': { headers: { contentSecurityPolicy: { 'frame-src': ['https://challenges.cloudflare.com'], 'trusted-types': ['vue', 'lb-turnstile'] } } },
  }
}

/** Reads one directive of a route's policy. */
function directive(rules: SecurityRules, route: string, name: string): unknown {
  const headers = rules[route]?.headers
  const policy = headers ? headers.contentSecurityPolicy : undefined
  return typeof policy === 'object' ? (policy as Record<string, unknown>)[name] : undefined
}

/** Reads a route's Permissions-Policy. */
function permissions(rules: SecurityRules, route: string): unknown {
  const headers = rules[route]?.headers
  return headers ? headers.permissionsPolicy : undefined
}

describe('LB-09\'s additions to the security headers', () => {
  it('gives each of the two board pages the socket, the recording as media and the microphone, and nothing else', () => {
    const rules = baseRules()
    addLb09Policy(rules, new URL('https://api.example.com'))
    for (const route of LB09_BOARD_PAGE_ROUTES) {
      expect(directive(rules, route, 'connect-src')).toEqual(['\'self\'', 'wss://api.example.com'])
      expect(directive(rules, route, 'media-src')).toEqual(['\'self\'', 'blob:'])
      expect(directive(rules, route, 'script-src')).toBeUndefined()
      expect(directive(rules, route, 'worker-src')).toBeUndefined()
      expect(directive(rules, route, 'frame-src')).toBeUndefined()
      expect(permissions(rules, route)).toEqual({ 'camera': [], 'display-capture': [], 'fullscreen': [], 'geolocation': [], 'microphone': ['self'], 'payment': [], 'usb': [] })
      expect(directive(rules, route, 'trusted-types')).toBeUndefined()
      expect(directive(rules, route, 'worker-src')).toBeUndefined()
    }
  })

  it('denies every device API but the microphone, and the microphone only to the site itself', () => {
    for (const [name, sources] of Object.entries(LB09_PERMISSIONS_POLICY)) {
      expect(sources, name).toEqual(name === 'microphone' ? ['self'] : [])
    }
  })

  it('leaves every other rule exactly as it was', () => {
    const rules = baseRules()
    addLb09Policy(rules, new URL('https://api.example.com'))
    const untouched = baseRules()
    for (const route of Object.keys(untouched)) expect(rules[route]).toEqual(untouched[route])
    expect(Object.keys(rules).sort()).toEqual([...Object.keys(untouched), ...LB09_BOARD_PAGE_ROUTES].sort())
  })

  it('adds nothing wide: no wildcard, no scheme alone, no unsafe source', () => {
    const rules = baseRules()
    addLb09Policy(rules, new URL('http://127.0.0.1:8121'))
    for (const route of LB09_BOARD_PAGE_ROUTES) {
      for (const source of directive(rules, route, 'connect-src') as string[]) {
        expect(source).not.toMatch(/\*/)
        expect(source).not.toMatch(/^[a-z]+:$/)
        expect(source).not.toMatch(/unsafe/)
      }
      expect(directive(rules, route, 'connect-src')).toContain('ws://127.0.0.1:8121')
    }
  })

  it('leaves connect-src alone, and still allows the microphone, when the site has no API', () => {
    const rules = baseRules()
    addLb09Policy(rules, undefined)
    for (const route of LB09_BOARD_PAGE_ROUTES) {
      expect(directive(rules, route, 'connect-src')).toBeUndefined()
      expect(directive(rules, route, 'media-src')).toEqual(['\'self\'', 'blob:'])
      expect((permissions(rules, route) as Record<string, string[]>).microphone).toEqual(['self'])
    }
  })
})
