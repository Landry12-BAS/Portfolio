// Tests for the table of routes the site may forward: it holds exactly what the committed OpenAPI
// documents describe for the demo systems, and a request is one of them only if its method, its
// path and its query are, down to the characters a path parameter may hold.
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { API_ROUTES, checkQuery, matchRoute } from '../src/routes.ts'

/** Reads a back end's committed OpenAPI document. */
function readDocument(path: string): { paths: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(new URL(`../../../services/${path}/openapi.json`, import.meta.url), 'utf8')) as { paths: Record<string, Record<string, unknown>> }
}

const documents = ['django-systems', 'flask-systems', 'node-systems'].map(readDocument)

describe('the table of routes', () => {
  it('lists every method and path the three documents describe for the demo systems, and nothing else', () => {
    const described: string[] = []
    for (const document of documents) {
      for (const [path, operations] of Object.entries(document.paths)) {
        if (!/^\/api\/lb\d{2}\//.test(path)) continue
        for (const method of Object.keys(operations)) described.push(`${method.toUpperCase()} ${path}`)
      }
    }

    expect(API_ROUTES.map(route => `${route.method} ${route.path}`).sort()).toEqual(described.sort())
  })

  it('leaves out the health checks, which the Caddy edge hides too', () => {
    const paths = API_ROUTES.map(route => route.path)

    expect(paths).not.toContain('/api/healthz')
    expect(paths).not.toContain('/api/readyz')
    expect(paths.every(path => /^\/api\/lb\d{2}\//.test(path))).toBe(true)
  })

  it('names each route\'s system after its path, and forwards only the four methods', () => {
    for (const route of API_ROUTES) {
      expect(route.path.startsWith(`/api/lb${route.system.slice(3)}/`), route.path).toBe(true)
      expect(['GET', 'POST', 'PUT', 'DELETE']).toContain(route.method)
    }
    expect(new Set(API_ROUTES.map(route => route.system))).toEqual(new Set(['lb-01', 'lb-02', 'lb-03', 'lb-05', 'lb-08']))
  })

  it('marks the one route that takes a file as an upload and the two that answer with files, and no other', () => {
    const uploads = API_ROUTES.filter(route => route.upload).map(route => `${route.method} ${route.path}`)
    const files = API_ROUTES.filter(route => route.files !== undefined).map(route => `${route.method} ${route.path} ${route.files?.join(',')}`)

    expect(uploads).toEqual(['POST /api/lb03/documents'])
    expect(files).toEqual([
      'GET /api/lb03/documents/{document_id}/export text/csv',
      'GET /api/lb03/documents/{document_id}/pages/{number} image/jpeg',
    ])
    for (const route of API_ROUTES.filter(candidate => candidate.upload)) expect(route.body).toBe(true)
  })

  it('serves LB-03 with the routes of its documents, a correction being a POST because the proxy forwards no PATCH', () => {
    expect(API_ROUTES.filter(route => route.system === 'lb-03').map(route => `${route.method} ${route.path}`)).toEqual([
      'GET /api/lb03/documents',
      'POST /api/lb03/documents',
      'DELETE /api/lb03/documents/{document_id}',
      'GET /api/lb03/documents/{document_id}',
      'POST /api/lb03/documents/{document_id}/corrections',
      'GET /api/lb03/documents/{document_id}/export',
      'GET /api/lb03/documents/{document_id}/pages/{number}',
      'GET /api/lb03/quota',
    ])
    expect(matchRoute('PATCH', '/api/lb03/documents/abc12345/fields/total')).toBeUndefined()
    expect(matchRoute('GET', '/api/lb03/documents/abc12345/fields/line_items.0.total')).toBeUndefined()
  })

  it('has no route twice', () => {
    const keys = API_ROUTES.map(route => `${route.method} ${route.path}`)

    expect(new Set(keys).size).toBe(keys.length)
  })

  it('serves LB-01 with its six routes', () => {
    expect(API_ROUTES.filter(route => route.system === 'lb-01').map(route => `${route.method} ${route.path}`)).toEqual([
      'GET /api/lb01/customers',
      'GET /api/lb01/stats',
      'GET /api/lb01/tickets',
      'POST /api/lb01/tickets',
      'GET /api/lb01/tickets/{ticket_id}',
      'POST /api/lb01/tickets/{ticket_id}/decision',
    ])
  })
})

describe('matching a request to a route', () => {
  it('finds a route and reads its path parameters', () => {
    expect(matchRoute('GET', '/api/lb01/customers')?.route.system).toBe('lb-01')
    expect(matchRoute('GET', '/api/lb01/tickets/tk_3f9a')).toMatchObject({ route: { path: '/api/lb01/tickets/{ticket_id}' }, params: { ticket_id: 'tk_3f9a' } })
    expect(matchRoute('POST', '/api/lb08/runs/3b241101-e2bb-4255-8caf-4136c566a962/steps/check_stock/decision')?.params).toEqual({ id: '3b241101-e2bb-4255-8caf-4136c566a962', nodeId: 'check_stock' })
  })

  it('tells a method from another on the same path', () => {
    expect(matchRoute('POST', '/api/lb01/tickets')?.route.body).toBe(true)
    expect(matchRoute('GET', '/api/lb01/tickets')?.route.body).toBe(false)
    expect(matchRoute('DELETE', '/api/lb08/workflows/wf1')?.route.method).toBe('DELETE')
    expect(matchRoute('PUT', '/api/lb08/workflows/wf1')?.route.method).toBe('PUT')
  })

  it('refuses a method the route does not have, and methods the site never forwards', () => {
    for (const method of ['DELETE', 'PUT', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT', 'get', 'Get']) {
      expect(matchRoute(method, '/api/lb01/customers'), method).toBeUndefined()
    }
    expect(matchRoute('POST', '/api/lb01/customers')).toBeUndefined()
  })

  it('refuses a path that is not a documented one', () => {
    const paths = [
      '/api/healthz', '/api/readyz', '/api/lb01', '/api/lb01/', '/api/lb01/tickets/', '/api/lb01/tickets/a/b', '/api/lb01/ticket',
      '/api/lb03/anything', '/api/lb99/customers', '/api/LB01/customers', '/api/lb01/Customers', '/api/openapi.json', '/api/lb08/runs/a/steps',
      '/v1/runs/run-0123456789/spans', '/admin/', '/', '', 'api/lb01/customers', '//api/lb01/customers', '/api//lb01/customers',
    ]
    for (const path of paths) expect(matchRoute('GET', path), path).toBeUndefined()
  })

  it('refuses a path parameter that is not a plain identifier, so nothing can climb out of its place', () => {
    const bad = ['..', '.', 'a.b', '%2e%2e', 'a%2Fb', 'a b', 'a/b', '', 'a:b', 'ticket?x=1', 'ticket#frag', 'ünï', 'x'.repeat(65), 'a\\b', 'a\u0000b', '<script>']
    for (const value of bad) {
      expect(matchRoute('GET', `/api/lb01/tickets/${value}`), JSON.stringify(value)).toBeUndefined()
    }
    expect(matchRoute('GET', `/api/lb01/tickets/${'x'.repeat(64)}`)).toBeDefined()
    expect(matchRoute('GET', '/api/lb01/tickets/Aa09_-')).toBeDefined()
  })
})

describe('checking a query string', () => {
  const calendar = matchRoute('GET', '/api/lb02/calendar')!.route
  const customers = matchRoute('GET', '/api/lb01/customers')!.route

  it('keeps the parameters a route documents, in the route\'s order', () => {
    const pairs = checkQuery(calendar, new URLSearchParams('days=7&from=2026-10-05&conversation=ab12'))

    expect(pairs).toEqual([['conversation', 'ab12'], ['days', '7'], ['from', '2026-10-05']])
  })

  it('accepts no query at all, and a route that takes none refuses any', () => {
    expect(checkQuery(calendar, new URLSearchParams(''))).toEqual([])
    expect(checkQuery(customers, new URLSearchParams(''))).toEqual([])
    expect(checkQuery(customers, new URLSearchParams('debug=1'))).toBeUndefined()
  })

  it('refuses an unknown name, a repeated name and a value that is not a short plain one', () => {
    for (const query of ['x=1', 'days=7&days=8', 'days=', 'days=%2e%2e%2f', 'days=a b', 'days=' + 'x'.repeat(65), 'days=7&x=1', 'DAYS=7', 'days[]=7']) {
      expect(checkQuery(calendar, new URLSearchParams(query)), query).toBeUndefined()
    }
  })
})
