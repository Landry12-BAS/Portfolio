// What LB-04's board pages add to the site's Content Security Policy, and only those two pages. The other
// boards, the datasheets and the home page keep the policy docs/SECURITY.md lists, unchanged. The PDF
// viewer runs pdf.js in a Web Worker from the site's own origin, and needs two additions, each the
// smallest that does the job:
//
//   trusted-types the name of the one policy that makes the worker's address, added to the list the board
//                 pages already have. A worker's address is a script address, which a page that requires
//                 Trusted Types for scripts may only give as a value a policy made. There is never a
//                 `default` policy.
//   worker-src    'self', so the worker's script may be loaded from the site's own origin whatever a
//                 browser makes of `strict-dynamic` for workers.
//
// Nothing else changes: not `script-src`, not `connect-src` (the PDF reaches the viewer as bytes the page
// already holds), and not `img-src`, since the page is drawn on a canvas and no image is loaded. A page's
// policy is merged from the most specific rule that matches, and an array in it replaces the less
// specific one's, so each array here is written out in full.
import type { NuxtSecurityRouteRules } from 'nuxt-security'

import { LB04_BOARD_PAGE_ROUTES, PDF_WORKER_POLICY } from '../../shared/lb04-viewer.ts'

// The route rules that already give the boards their policy (nuxt.config.ts).
const ANY_BOARD_ROUTE = '/systems/*/board'

/** The route rules by route, as nuxt-security keeps them. */
export type SecurityRules = Record<string, NuxtSecurityRouteRules>

/** Reads the sources one rule gives a directive, or none when the rule does not say. */
function sourcesOf(rule: NuxtSecurityRouteRules | undefined, directive: string): string[] {
  const headers = rule?.headers
  if (!headers) return []
  const policy: unknown = headers.contentSecurityPolicy
  if (typeof policy !== 'object' || policy === null) return []
  const value = (policy as Record<string, unknown>)[directive]
  return Array.isArray(value) ? value.filter((source): source is string => typeof source === 'string') : []
}

/** Adds LB-04's additions to the rules for its two pages. */
export function addLb04Policy(rules: SecurityRules): void {
  const trustedTypes = [...new Set([...sourcesOf(rules[ANY_BOARD_ROUTE], 'trusted-types'), PDF_WORKER_POLICY])]
  for (const route of LB04_BOARD_PAGE_ROUTES) {
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
        },
      },
    }
  }
}
