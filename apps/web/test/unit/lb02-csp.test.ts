// Tests of what LB-02's board pages add to the site's Content Security Policy: the API's WebSocket
// origin, the service worker's Trusted Types policy and the worker source, on those two pages only,
// each as small as it can be. The rules start as nuxt.config.ts gives them to the other boards.
import { describe, expect, it } from 'vitest'

import { BOARD_PAGE_ROUTES, SERVICE_WORKER_POLICY } from '../../shared/lb02-app.ts'
import { addLb02Policy, socketSource } from '../../server/lib/lb02-csp.ts'
import type { SecurityRules } from '../../server/lib/lb02-csp.ts'

/** The rules as the other boards and every page have them. */
function baseRules(): SecurityRules {
  return {
    '/**': { headers: { contentSecurityPolicy: { 'connect-src': ['\'self\''], 'default-src': ['\'self\''], 'trusted-types': ['vue'] } } },
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

describe('the WebSocket source', () => {
  it.each([
    ['https://api.example.com', 'wss://api.example.com'],
    ['https://api.example.com/some/path?x=1', 'wss://api.example.com'],
    ['https://api.example.com:8443', 'wss://api.example.com:8443'],
    ['http://127.0.0.1:8121', 'ws://127.0.0.1:8121'],
    ['http://localhost:8001/', 'ws://localhost:8001'],
  ])('turns %s into %s', (api, source) => {
    expect(socketSource(new URL(api))).toBe(source)
  })
})

describe('LB-02\'s additions to the Content Security Policy', () => {
  it('gives each of the two board pages the socket, the policy name and the worker source', () => {
    const rules = baseRules()
    addLb02Policy(rules, new URL('https://api.example.com'))
    for (const route of BOARD_PAGE_ROUTES) {
      expect(directive(rules, route, 'connect-src')).toEqual(['\'self\'', 'wss://api.example.com'])
      expect(directive(rules, route, 'trusted-types')).toEqual(['vue', 'lb-turnstile', SERVICE_WORKER_POLICY])
      expect(directive(rules, route, 'worker-src')).toEqual(['\'self\''])
    }
  })

  it('leaves every other rule exactly as it was', () => {
    const rules = baseRules()
    addLb02Policy(rules, new URL('https://api.example.com'))
    const untouched = baseRules()
    for (const route of Object.keys(untouched)) expect(rules[route]).toEqual(untouched[route])
    expect(Object.keys(rules).sort()).toEqual([...Object.keys(untouched), ...BOARD_PAGE_ROUTES].sort())
  })

  it('adds nothing wide: no wildcard, no scheme alone, no unsafe source, no default policy', () => {
    const rules = baseRules()
    addLb02Policy(rules, new URL('https://api.example.com'))
    for (const route of BOARD_PAGE_ROUTES) {
      const added = [...(directive(rules, route, 'connect-src') as string[]), ...(directive(rules, route, 'trusted-types') as string[]), ...(directive(rules, route, 'worker-src') as string[])]
      for (const source of added) {
        expect(source).not.toMatch(/\*/)
        expect(source).not.toMatch(/^[a-z]+:$/)
        expect(source).not.toMatch(/unsafe|default/)
      }
    }
  })

  it('leaves connect-src alone when the site has no API address, since the board then connects nowhere', () => {
    const rules = baseRules()
    addLb02Policy(rules, undefined)
    for (const route of BOARD_PAGE_ROUTES) {
      expect(directive(rules, route, 'connect-src')).toBeUndefined()
      expect(directive(rules, route, 'trusted-types')).toEqual(['vue', 'lb-turnstile', SERVICE_WORKER_POLICY])
    }
  })

  it('keeps what a board page already says, such as the Turnstile frame', () => {
    const rules = baseRules()
    rules['/systems/lb-02/board'] = { headers: { contentSecurityPolicy: { 'frame-src': ['https://challenges.cloudflare.com'] } } }
    addLb02Policy(rules, new URL('https://api.example.com'))
    expect(directive(rules, '/systems/lb-02/board', 'frame-src')).toEqual(['https://challenges.cloudflare.com'])
    expect(directive(rules, '/systems/lb-02/board', 'worker-src')).toEqual(['\'self\''])
  })

  it('does not list a source twice when it runs again', () => {
    const rules = baseRules()
    addLb02Policy(rules, new URL('https://api.example.com'))
    addLb02Policy(rules, new URL('https://api.example.com'))
    expect(directive(rules, '/systems/lb-02/board', 'connect-src')).toEqual(['\'self\'', 'wss://api.example.com'])
    expect(directive(rules, '/systems/lb-02/board', 'trusted-types')).toEqual(['vue', 'lb-turnstile', SERVICE_WORKER_POLICY])
  })
})
