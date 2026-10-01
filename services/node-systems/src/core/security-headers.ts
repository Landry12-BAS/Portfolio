// Security headers on every response of the Node systems (docs/SECURITY.md, section 3).
//
// The service answers JSON and streams events, never pages, so its content security policy
// allows nothing at all, and no response may be cached: they carry a visitor's own data.
// These are the same headers the Django systems send (core/middleware.py).
import type { FastifyInstance } from 'fastify'

/** The headers every response carries, whatever the route and whatever the status. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': 'default-src \'none\'; frame-ancestors \'none\'',
  'cross-origin-opener-policy': 'same-origin',
  // The site calls the API from its own subdomain.
  'cross-origin-resource-policy': 'same-site',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
}

/**
 * Stamps the security headers on every response, replacing any a route set. It runs in
 * `onSend`, so it covers error answers and the 404 for an unknown path too.
 */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value)
    // Lets an operator find a request in the logs from a response the site saw.
    reply.header('x-request-id', request.id)
  })
}
