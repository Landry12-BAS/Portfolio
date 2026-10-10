// The first of the sandbox's two layers inside the browser: deciding, before anything is asked of the
// browser, whether an address may be opened. Only the shop's own origin may: never another host, a
// private or link-local address, the cloud metadata address, `file:`, `data:`, `javascript:`, `blob:`
// or anything else. The same decision is applied to a `goto` step's path, to the `href` of a link a step
// is about to click, and (as the second layer, in session.ts) to every request the page makes.
import { LB07_LIMITS } from '@lb/contracts'

/** Why an address was refused. */
export type RefusalReason = 'not_a_url' | 'scheme' | 'other_origin'

/** The decision about one address. */
export type UrlDecision
  = | { allowed: true, url: URL }
    | { allowed: false, reason: RefusalReason, target: string }

// The schemes whose addresses have an origin worth naming: the web's and its sockets'.
const NAMED_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'ws:', 'wss:'])

/** A short, safe description of an address for a finding: its scheme and host, never its path or query. */
export function describeTarget(raw: string): string {
  try {
    const url = new URL(raw)
    return NAMED_SCHEMES.has(url.protocol) ? url.origin : `${url.protocol} address`
  }
  catch {
    return 'an address that is not a URL'
  }
}

/** Decides whether an address, resolved against the page's own URL when relative, may be opened. */
export function decideUrl(raw: string, base: string, shopOrigin: string): UrlDecision {
  let url: URL
  try {
    url = new URL(raw, base)
  }
  catch {
    return { allowed: false, reason: 'not_a_url', target: 'an address that is not a URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { allowed: false, reason: 'scheme', target: describeTarget(url.href) }
  if (url.origin !== shopOrigin) return { allowed: false, reason: 'other_origin', target: url.origin }
  return { allowed: true, url }
}

/** Decides a `goto` step's path: a path of the shop and nothing else. `//host/x` resolves to another origin and is refused. */
export function decideShopPath(path: string, shopOrigin: string): UrlDecision {
  return decideUrl(path, `${shopOrigin}/`, shopOrigin)
}

/** The shop path of a page URL, bounded, for findings and answers. Another origin's URL is never written out. */
export function shopPathOf(href: string, shopOrigin: string): string {
  try {
    const url = new URL(href)
    if (url.origin !== shopOrigin) return url.protocol === 'about:' ? 'about:blank' : '(outside the shop)'
    return url.pathname.slice(0, 120)
  }
  catch {
    return '(unknown)'
  }
}

/** Checks a shop origin setting: http or https, a host, nothing else. */
export function checkShopOrigin(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  }
  catch {
    throw new RangeError('The shop origin must be a URL such as http://lb07-shop:8007.')
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '') {
    throw new RangeError('The shop origin is a scheme, a host and a port, and nothing else.')
  }
  return url.origin
}

/** The user agent of the simulated second engine: Firefox's, since only Chromium is installed in the sandbox. */
export const FIREFOX_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'

/** How long one step may take, from the limits. */
export const STEP_TIMEOUT_MS = LB07_LIMITS.stepTimeoutMs
