// Tests for the list of the server's routes (server/api-routes.ts) that no request can show. Nitro's Vercel
// preset makes one function name for each route, and two routes that make the same name stop the build with
// EEXIST: `/api` and `/api/` did, and nothing but a build with VERCEL set (which no test or CI step makes)
// would have said so. The site's one deployment target is Vercel, so the list is checked for it here.
import { describe, expect, it } from 'vitest'

import { SERVER_ROUTES } from '../../server/api-routes.ts'

/**
 * Names the function Nitro's Vercel preset makes for a route (nitropack, presets/vercel/utils.mjs,
 * `normalizeRouteDest`): the segments of the path, each pattern written as a bracketed name, joined by slashes,
 * then resolved as a path, so a trailing slash is gone.
 */
function vercelFunctionName(route: string): string {
  const name = route.split('/').slice(1).map((segment) => {
    if (segment.startsWith('**')) return `[...${segment.replace(/[*:]/g, '')}]`
    if (segment === '*') return '[-]'
    if (segment.startsWith(':')) return `[${segment.slice(1)}]`
    if (segment.includes(':')) return `[${segment.replace(/:/g, '_')}]`
    return segment
  }).join('/')
  return name.replace(/\/+$/, '') || 'index'
}

describe('the server\'s routes', () => {
  it('make one Vercel function each: no two routes share a name, as `/api` and `/api/` did', () => {
    const owners = new Map<string, string>()
    const clashes: string[] = []
    for (const { route } of SERVER_ROUTES) {
      const name = vercelFunctionName(route)
      const other = owners.get(name)
      if (other !== undefined) clashes.push(`${other} and ${route} are both ${name}`)
      owners.set(name, route)
    }

    expect(clashes).toEqual([])
  })

  it('name a route once, with or without a trailing slash, since the router answers /api/ with the route /api', () => {
    const routes = SERVER_ROUTES.map(({ route, method }) => `${method ?? 'any'} ${route.replace(/\/+$/, '')}`)

    expect(new Set(routes).size).toBe(routes.length)
  })

  it('end with the catch-alls that make every unknown path under /api the API\'s own 404', () => {
    const last = SERVER_ROUTES.slice(-2).map(({ route, handler }) => [route, handler])

    expect(last).toEqual([['/api', 'handlers/not-found.ts'], ['/api/**', 'handlers/not-found.ts']])
  })
})
