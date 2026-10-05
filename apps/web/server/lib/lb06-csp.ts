// What LB-06's board pages add to the site's Content Security Policy, and only those two pages: the
// API's WebSocket origin in `connect-src`, because the incident's feed connects straight to the API
// (a Vercel function cannot hold a WebSocket). It is derived from the same setting (NUXT_LB_API_URL)
// that the token route uses to name the socket, so the two cannot disagree. No wildcard, no other
// host, and nothing else: LB-06 has no service worker and no Web Worker, so the Trusted Types list
// and `worker-src` stay as every board has them.
//
// The additions are made while the server starts, with the hook nuxt-security provides; a page's
// policy is merged from the most specific rule that matches, and an array in it replaces the less
// specific one's, so the directive is written out in full.
import type { NuxtSecurityRouteRules } from 'nuxt-security'

import { LB06_BOARD_PAGE_ROUTES } from '../../shared/lb06-app.ts'
import { socketSource } from './lb02-csp.ts'
import type { SecurityRules } from './lb02-csp.ts'

const EVERY_ROUTE = '/**'

/** Reads the sources one rule gives a directive, or none when the rule does not say. */
function sourcesOf(rule: NuxtSecurityRouteRules | undefined, directive: string): string[] {
  const headers = rule?.headers
  if (!headers) return []
  const policy: unknown = headers.contentSecurityPolicy
  if (typeof policy !== 'object' || policy === null) return []
  const value = (policy as Record<string, unknown>)[directive]
  return Array.isArray(value) ? value.filter((source): source is string => typeof source === 'string') : []
}

/** Adds LB-06's socket to the `connect-src` of its two pages. Without an API address the board connects nowhere, so nothing changes. */
export function addLb06Policy(rules: SecurityRules, api: URL | undefined): void {
  if (!api) return
  const connect = [...new Set([...sourcesOf(rules[EVERY_ROUTE], 'connect-src'), socketSource(api)])]
  for (const route of LB06_BOARD_PAGE_ROUTES) {
    const existing = rules[route]
    const headers = existing?.headers || undefined
    const policy = headers?.contentSecurityPolicy
    rules[route] = {
      ...existing,
      headers: {
        ...headers,
        contentSecurityPolicy: {
          ...(typeof policy === 'object' ? policy : {}),
          'connect-src': connect,
        },
      },
    }
  }
}
