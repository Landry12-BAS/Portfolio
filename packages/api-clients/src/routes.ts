// The routes the site's server may forward to the back ends, and the check that a request
// is one of them. The table is generated from the three committed OpenAPI documents
// (generated/routes.ts), so a route a back end doesn't document is not forwardable, and a
// path parameter or query value can hold only a plain identifier: no dot segment, escape,
// slash or space can slip through to the back end.
import { API_ROUTES } from './generated/routes.ts'
import type { ApiRoute } from './route-types.ts'

export { API_ROUTES } from './generated/routes.ts'
export type { ApiRoute, ForwardedMethod, ServiceName, SystemName } from './route-types.ts'

/** What a path parameter may hold: a plain identifier, such as a ticket's public ID or a run's UUID. */
const PATH_PARAMETER = /^[\w-]{1,64}$/
/** What a query value may hold: the same, plus dots and colons for dates and cursors. */
const QUERY_VALUE = /^[\w.:-]{1,64}$/
// A template segment that stands for a path parameter, such as `{ticket_id}`.
const TEMPLATE_PARAMETER = /^\{(\w+)\}$/

/** A route with its path split into segments once, so matching a request is a comparison of strings. */
interface CompiledRoute {
  route: ApiRoute
  // Each segment is the literal text it must equal, or a parameter's name.
  segments: readonly { literal: string | undefined, parameter: string | undefined }[]
}

const COMPILED: readonly CompiledRoute[] = API_ROUTES.map(route => ({
  route,
  segments: route.path.split('/').map((segment) => {
    const parameter = TEMPLATE_PARAMETER.exec(segment)?.[1]
    return { literal: parameter === undefined ? segment : undefined, parameter }
  }),
}))

/** A request that is a documented route: which one, and the values of its path parameters. */
export interface MatchedRoute {
  route: ApiRoute
  params: Readonly<Record<string, string>>
}

/** Compares a request's path with one route, returning the path parameters when it is that route. */
function matchSegments(compiled: CompiledRoute, parts: readonly string[]): Record<string, string> | undefined {
  if (compiled.segments.length !== parts.length) return undefined
  const params: Record<string, string> = {}
  for (const [index, segment] of compiled.segments.entries()) {
    const part = parts[index] ?? ''
    if (segment.parameter === undefined) {
      if (part !== segment.literal) return undefined
    }
    else if (PATH_PARAMETER.test(part)) {
      params[segment.parameter] = part
    }
    else {
      return undefined
    }
  }
  return params
}

/**
 * Finds the documented route a request is, or returns undefined. The method must be one the
 * site forwards, the path must have exactly the template's segments (no trailing slash, no
 * empty segment), and every path parameter must be a plain identifier.
 */
export function matchRoute(method: string, pathname: string): MatchedRoute | undefined {
  const parts = pathname.split('/')
  for (const compiled of COMPILED) {
    if (compiled.route.method !== method) continue
    const params = matchSegments(compiled, parts)
    if (params !== undefined) return { route: compiled.route, params }
  }
  return undefined
}

/**
 * Checks a request's query string against what a route documents: only its own parameter
 * names, each at most once, each a short plain value. Returns the clean pairs in the route's
 * order, or undefined when anything else is there.
 */
export function checkQuery(route: ApiRoute, search: URLSearchParams): [string, string][] | undefined {
  const pairs: [string, string][] = []
  for (const name of route.query) {
    const values = search.getAll(name)
    if (values.length > 1) return undefined
    const value = values[0]
    if (value === undefined) continue
    if (!QUERY_VALUE.test(value)) return undefined
    pairs.push([name, value])
  }
  const known = new Set(route.query)
  for (const name of search.keys()) {
    if (!known.has(name)) return undefined
  }
  return pairs
}
