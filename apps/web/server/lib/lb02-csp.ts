// What LB-02's board pages add to the site's Content Security Policy, and only those two pages. The
// other boards, the datasheets and the home page keep the policy docs/SECURITY.md lists, unchanged.
// The board needs three additions, each the smallest that does the job:
//
//   connect-src   the API's WebSocket origin (ws: or wss:, and its host), because the conversation
//                 connects straight to the API: a Vercel function cannot hold a WebSocket. It is
//                 derived from the same setting (NUXT_LB_API_URL) that the token route uses to name
//                 the socket, so the two cannot disagree. No wildcard, no other host.
//   trusted-types the name of the one policy that makes the service worker's address, added to the
//                 list the board pages already have. There is never a `default` policy.
//   worker-src    'self', so the worker's script may be loaded from the site's own origin whatever
//                 a browser makes of `strict-dynamic` for workers.
//
// The additions are made while the server starts, from the settings, with the hook nuxt-security
// provides for this; a page's policy is merged from the most specific rule that matches, and an array
// in it replaces the less specific one's, so each array here is written out in full.
import type { NuxtSecurityRouteRules } from 'nuxt-security'

import { BOARD_PAGE_ROUTES, SERVICE_WORKER_POLICY } from '../../shared/lb02-app.ts'

// The route rules that already give the boards, and every page, their policy (nuxt.config.ts).
const ANY_BOARD_ROUTE = '/systems/*/board'
const EVERY_ROUTE = '/**'

/** The route rules by route, as nuxt-security keeps them. */
export type SecurityRules = Record<string, NuxtSecurityRouteRules>

/** Makes the source that lets a page connect to the API's WebSocket: `ws:` or `wss:` and the host, with its port. */
export function socketSource(api: URL): string {
  return `${api.protocol === 'https:' ? 'wss:' : 'ws:'}//${api.host}`
}

/** Reads the sources one rule gives a directive, or none when the rule does not say. */
function sourcesOf(rule: NuxtSecurityRouteRules | undefined, directive: string): string[] {
  const headers = rule?.headers
  if (!headers) return []
  const policy: unknown = headers.contentSecurityPolicy
  if (typeof policy !== 'object' || policy === null) return []
  const value = (policy as Record<string, unknown>)[directive]
  return Array.isArray(value) ? value.filter((source): source is string => typeof source === 'string') : []
}

/** Adds LB-02's additions to the rules for its two pages. Without an API address the board connects nowhere, so `connect-src` stays as it is. */
export function addLb02Policy(rules: SecurityRules, api: URL | undefined): void {
  const trustedTypes = [...new Set([...sourcesOf(rules[ANY_BOARD_ROUTE], 'trusted-types'), SERVICE_WORKER_POLICY])]
  const connect = api ? [...new Set([...sourcesOf(rules[EVERY_ROUTE], 'connect-src'), socketSource(api)])] : undefined
  for (const route of BOARD_PAGE_ROUTES) {
    const existing = rules[route]
    const headers = existing?.headers || undefined
    const policy = headers?.contentSecurityPolicy
    rules[route] = {
      ...existing,
      headers: {
        ...headers,
        contentSecurityPolicy: {
          ...(typeof policy === 'object' ? policy : {}),
          'trusted-types': trustedTypes,
          'worker-src': ['\'self\''],
          ...(connect ? { 'connect-src': connect } : {}),
        },
      },
    }
  }
}
