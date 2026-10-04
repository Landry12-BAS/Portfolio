// Tests of what LB-06's board pages add to the site's Content Security Policy: the API's WebSocket
// origin in `connect-src`, on those two pages only, and nothing else: no policy name, no worker
// source, no wildcard. The rules start as nuxt.config.ts gives them to the other boards.
import { describe, expect, it } from 'vitest'

import { LB06_BOARD_PAGE_ROUTES } from '../../shared/lb06-app.ts'
import type { SecurityRules } from '../../server/lib/lb02-csp.ts'
import { addLb06Policy } from '../../server/lib/lb06-csp.ts'

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

describe('LB-06\'s addition to the Content Security Policy', () => {
  it('gives each of the two board pages the socket, and nothing else', () => {
    const rules = baseRules()
    addLb06Policy(rules, new URL('https://api.example.com'))
    for (const route of LB06_BOARD_PAGE_ROUTES) {
      expect(directive(rules, route, 'connect-src')).toEqual(['\'self\'', 'wss://api.example.com'])
      expect(directive(rules, route, 'trusted-types')).toBeUndefined()
      expect(directive(rules, route, 'worker-src')).toBeUndefined()
    }
  })

  it('leaves every other rule exactly as it was, and changes nothing without an API address', () => {
    const rules = baseRules()
    addLb06Policy(rules, new URL('https://api.example.com'))
    const untouched = baseRules()
    for (const route of Object.keys(untouched)) expect(rules[route]).toEqual(untouched[route])
    expect(Object.keys(rules).sort()).toEqual([...Object.keys(untouched), ...LB06_BOARD_PAGE_ROUTES].sort())
    const none = baseRules()
    addLb06Policy(none, undefined)
    expect(none).toEqual(baseRules())
  })

  it('adds nothing wide: no wildcard, no scheme alone, no unsafe source', () => {
    const rules = baseRules()
    addLb06Policy(rules, new URL('http://127.0.0.1:8121'))
    for (const route of LB06_BOARD_PAGE_ROUTES) {
      const connect = directive(rules, route, 'connect-src') as string[]
      expect(connect).toEqual(['\'self\'', 'ws://127.0.0.1:8121'])
      for (const source of connect) expect(source).not.toMatch(/\*|unsafe|^wss?:$/)
    }
  })
})
