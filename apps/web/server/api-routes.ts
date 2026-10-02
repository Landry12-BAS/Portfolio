// Everything the site's server answers, in one list. A request to anything under /api/ reaches
// exactly one of these handlers, so what the server exposes can be read, and reviewed, in this
// file: there is no folder scan to add a route by accident. nuxt.config.ts hands the list to
// Nitro, and the tests build their server from the same list, so a test exercises the routes
// the site really has.
//
// A route with no method answers every method; the handler decides which it accepts. The proxy
// accepts only the method and path combinations the three OpenAPI documents describe
// (packages/api-clients), and every other path under /api/ ends at the last entry: a 404 in the
// platform's error shape.

/** One handler of the server, and where it listens. */
export interface ServerRoute {
  // The path, in Nitro's pattern syntax: `:name` for one segment, `**` for the rest.
  route: string
  // The one method it answers; absent for any.
  method?: 'get' | 'post' | 'put' | 'delete'
  // The handler's file, from this folder; it default-exports an event handler.
  handler: string
}

/** The handlers of the site's API, most specific first. */
export const SERVER_ROUTES: readonly ServerRoute[] = [
  // The visitor's anonymous session, and the Turnstile check that lifts it to one that may spend quota.
  { route: '/api/session', method: 'get', handler: 'handlers/session.ts' },
  { route: '/api/session/verify', method: 'post', handler: 'handlers/verify.ts' },
  // The token for LB-02's WebSocket, the one thing the browser does directly.
  { route: '/api/tokens/lb-02', method: 'post', handler: 'handlers/token.ts' },
  // The Scope: a run's trace, read from the gateway.
  { route: '/api/runs/:runId/spans', method: 'get', handler: 'handlers/spans.ts' },
  // The recordings the demos replay.
  { route: '/api/recordings/:system', method: 'get', handler: 'handlers/recordings/list.ts' },
  { route: '/api/recordings/:system/:sample', method: 'get', handler: 'handlers/recordings/read.ts' },
  // The back ends, forwarded as the visitor: one prefix for each demo system.
  { route: '/api/lb01/**', handler: 'handlers/proxy.ts' },
  { route: '/api/lb02/**', handler: 'handlers/proxy.ts' },
  { route: '/api/lb05/**', handler: 'handlers/proxy.ts' },
  { route: '/api/lb08/**', handler: 'handlers/proxy.ts' },
  { route: '/api/lb04/**', handler: 'handlers/proxy.ts' },
  // Anything else under /api/, and the bare prefix, which the pattern below does not cover. The router answers
  // `/api/` with the route `/api`, so it needs no entry of its own; it had one, and Nitro's Vercel preset, which
  // makes a function for each route and gave both the name `api`, stopped the build there with EEXIST
  // (test/unit/api-routes.test.ts keeps it from happening again).
  { route: '/api', handler: 'handlers/not-found.ts' },
  { route: '/api/**', handler: 'handlers/not-found.ts' },
]
