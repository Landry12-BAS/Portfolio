// What the site does before it answers anything. Two decisions, both made here so that the running site
// (server/middleware/lb-site.ts) and the tests (test/support/site-app.ts) run the same code:
//
// - One address. A request made for any host but the site's own (NUXT_LB_SITE_ORIGIN) is sent on to the same
//   path there with a 308, and goes no further: no page, no handler, no session. Without this `www.` and every
//   `*.vercel.app` address of the production deployment would be a site of their own, with a session cookie of
//   their own and so a quota of their own for each visitor. The host is the one the platform reports in
//   X-Forwarded-Host, which Vercel sets itself. The redirect goes to the configured origin and nowhere else,
//   so nothing in the request can choose where a visitor is sent.
// - The API's services. A request for a path under /api gets the site's services (the settings, the clock and
//   the network) on its context, so the handlers reach them through the request alone. The bare `/api` is
//   one of those paths, like `/api/`: it once was not, and answered 503 instead of the API's own 404.
import { defineEventHandler, getRequestHost, send, setResponseHeader, setResponseStatus } from 'h3'
import type { EventHandler } from 'h3'

import type { SiteServices } from './services.ts'

// Where the API's paths start.
const API_PREFIX = '/api'
// What a request target may hold for the redirect to repeat it: printable ASCII, so it is a valid header value.
// Percent-encoded text is that, and stays encoded.
const REPEATABLE_TARGET = /^[\x21-\x7e]+$/

/** Tells whether a request path, with its query if it has one, is the API's: `/api` itself or anything under `/api/`. */
export function isApiPath(path: string): boolean {
  const pathname = path.split('?', 1)[0] ?? ''
  return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`)
}

/**
 * Says where a request for `host` is sent on to: the same target (path and query, as the request wrote them,
 * still percent-encoded) on the site's own origin. Returns undefined when it needs no sending on, because it was
 * made for the site's own host (compared without regard to case) or because the site has no address of its own
 * and answers on any host. Any other host, including one that only looks like the site's, an empty one and the
 * site's host on another port, is sent on. The target is only ever added after the origin, so it cannot change
 * where the visitor lands; one that is not a path, or holds anything but printable ASCII, is replaced by `/`.
 */
export function canonicalLocation(host: string, target: string, siteOrigin: URL | undefined): string | undefined {
  if (siteOrigin === undefined) return undefined
  if (host.toLowerCase() === siteOrigin.host) return undefined
  return `${siteOrigin.origin}${target.startsWith('/') && REPEATABLE_TARGET.test(target) ? target : '/'}`
}

/**
 * Makes the site's first middleware from a way to get its services (a function, so the running site builds them
 * once, on first use, and a test hands over its own). A request for another host is answered with a permanent
 * redirect that says nothing else and is never cached, so a mistake in the address is cured by changing it; the
 * rest of the requests go on, the API's with the services attached.
 */
export function siteMiddleware(servicesOf: () => SiteServices): EventHandler {
  return defineEventHandler((event) => {
    const services = servicesOf()
    // The redirect repeats the request target as it was written: h3's `event.path` has its percent-escapes decoded.
    const target = event.node.req.url ?? '/'
    const location = canonicalLocation(getRequestHost(event, { xForwardedHost: true }), target, services.siteOrigin)
    if (location !== undefined) {
      setResponseStatus(event, 308)
      setResponseHeader(event, 'location', location)
      setResponseHeader(event, 'cache-control', 'no-store')
      return send(event, '')
    }
    if (isApiPath(event.path)) event.context.lbSite = services
  })
}
