// What LB-09's board pages add to the site's security headers, and only those two pages. The other
// boards, the datasheets and the home page keep the policy docs/SECURITY.md lists, unchanged. The
// board needs three additions, each the smallest that does the job:
//
//   connect-src           the API's WebSocket origin (ws: or wss:, and its host), because the meeting's
//                         progress connects straight to the API: a Vercel function cannot hold a
//                         WebSocket. It is derived from the same setting (NUXT_LB_API_URL) that the token
//                         route uses to name the socket, so the two cannot disagree. No wildcard, no other host.
//   media-src             `'self' blob:`, because the visitor's own recording is played back from the
//                         browser's memory (an object URL made by the page) and never from the back end,
//                         which deletes the audio once transcribed. The samples' audio is the site's own.
//                         `blob:` is a fetch source for media only: scripts, workers and frames keep the
//                         site's policy, and no `media-src` exists on any other page (default-src 'self').
//   Permissions-Policy    `microphone=(self)` on these pages alone, so the recorder may ask for the
//                         microphone; every other page keeps `microphone=()`, and every other device API
//                         stays denied here too. The policy is written out in full, so nothing is inherited
//                         by accident.
//
// The additions are made while the server starts, from the settings, with the hook nuxt-security
// provides for this; a page's policy is merged from the most specific rule that matches, and an array
// in it replaces the less specific one's, so each array here is written out in full.
import type { NuxtSecurityRouteRules } from 'nuxt-security'
import { LB09_BOARD_PAGE_ROUTES } from '../../shared/lb09-app.ts'
import { socketSource } from './lb02-csp.ts'
import type { SecurityRules } from './lb02-csp.ts'

// The route rule that already gives every page its policy (nuxt.config.ts).
const EVERY_ROUTE = '/**'

/** Where media may be played from on LB-09's pages: the site's own files, and a recording held in the browser. */
export const LB09_MEDIA_SOURCES: readonly string[] = ['\'self\'', 'blob:']

/** The device APIs the site denies everywhere, as nuxt.config.ts lists them; the microphone alone is allowed on LB-09's pages. */
export const LB09_PERMISSIONS_POLICY: Readonly<Record<string, readonly string[]>> = {
  'camera': [],
  'display-capture': [],
  'fullscreen': [],
  'geolocation': [],
  'microphone': ['self'],
  'payment': [],
  'usb': [],
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

/** Adds LB-09's additions to the rules for its two pages. Without an API address the board connects nowhere, so `connect-src` stays as it is. */
export function addLb09Policy(rules: SecurityRules, api: URL | undefined): void {
  const connect = api ? [...new Set([...sourcesOf(rules[EVERY_ROUTE], 'connect-src'), socketSource(api)])] : undefined
  for (const route of LB09_BOARD_PAGE_ROUTES) {
    const existing = rules[route]
    const headers = existing?.headers || undefined
    const policy = headers?.contentSecurityPolicy
    rules[route] = {
      ...existing,
      headers: {
        ...headers,
        contentSecurityPolicy: {
          ...(typeof policy === 'object' ? policy : {}),
          ...(connect ? { 'connect-src': connect } : {}),
          'media-src': [...LB09_MEDIA_SOURCES],
        },
        permissionsPolicy: Object.fromEntries(Object.entries(LB09_PERMISSIONS_POLICY).map(([name, sources]) => [name, [...sources]])),
      },
    }
  }
}
