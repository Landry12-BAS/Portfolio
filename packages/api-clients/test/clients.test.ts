// Tests for the typed clients and the generator: a client calls the path the document gives with
// its parameters filled in, and the generated files match what the committed documents say now.
import { execFileSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { createApiClients } from '../src/index.ts'

/** Makes a fetch that records the request it is given and answers with a fixed JSON body. */
function recordingFetch(body: unknown): { fetch: typeof globalThis.fetch, seen: Request[] } {
  const seen: Request[] = []
  return {
    seen,
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      seen.push(request)
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  }
}

describe('the typed clients', () => {
  it('call the back end\'s own paths, with path parameters and queries filled in', async () => {
    const { fetch, seen } = recordingFetch([])
    const { django, node } = createApiClients({ baseUrl: 'https://site.example', fetch })

    await django.GET('/api/lb01/tickets/{ticket_id}', { params: { path: { ticket_id: 'tk1' } } })
    await node.GET('/api/lb08/runs/{id}/events', { params: { path: { id: 'run1' }, query: { after: 3 } } })

    expect(seen.map(request => `${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`)).toEqual([
      'GET /api/lb01/tickets/tk1',
      'GET /api/lb08/runs/run1/events?after=3',
    ])
  })

  it('send a JSON body for a POST', async () => {
    const { fetch, seen } = recordingFetch({})
    const { flask } = createApiClients({ baseUrl: 'https://site.example', fetch })

    await flask.POST('/api/lb05/ask', { body: { question: 'Which roast sold most last month?' } })

    expect(await seen[0]?.json()).toEqual({ question: 'Which roast sold most last month?' })
    expect(seen[0]?.headers.get('content-type')).toBe('application/json')
  })

  it('call the same origin when no base URL is given, which is how the browser reaches the site\'s server', async () => {
    const { fetch, seen } = recordingFetch([])
    const { django } = createApiClients({ baseUrl: 'http://localhost', fetch })

    await django.GET('/api/lb01/customers')

    expect(new URL(seen[0]?.url ?? '').origin).toBe('http://localhost')
  })
})

describe('the generated files', () => {
  // The check starts the generator in a second process, which takes several seconds when other test
  // suites are running at the same time, so it gets a longer limit than the default five seconds.
  it('match the committed OpenAPI documents (the drift check `pnpm check` runs)', { timeout: 60_000 }, () => {
    const output = execFileSync('node', ['scripts/generate.ts', '--check'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' })

    expect(output).toContain('up to date')
  })
})
