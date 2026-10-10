// How a board calls the site's API: the typed clients for the back ends' own routes
// (`/api/lb01/...`), and plain JSON calls for the site's own (`/api/session`, the Scope, the
// recordings). Every answer is read the same way: a failure becomes an `ApiProblem` with a kind
// the board can show, and a success is checked with its Zod schema before anything uses it, because
// what comes back is the output of a model or of a system a model drives (docs/STACK.md: Zod at
// every boundary). The browser's `fetch` is looked up at the moment of each call, so a test can
// replace it.
import { createApiClients } from '@lb/api-clients'
import type { ApiClients } from '@lb/api-clients'
import type { z } from 'zod'

import { badAnswerProblem, networkProblem, problemFromAnswer } from './problem'

// The clients are made once: they hold no state, only the way to call `fetch`.
let clients: ApiClients | undefined

/** Calls the page's `fetch` as it is right now, which is what lets a test swap it. */
function currentFetch(request: Request): Promise<Response> {
  return globalThis.fetch(request)
}

/** Returns the typed clients for the Django, Flask and Node systems' routes, which the site's server forwards. */
export function apiClients(): ApiClients {
  // The client builds absolute requests, so it is told the page's own origin; there is no other origin it may call.
  clients ??= createApiClients({ fetch: currentFetch, baseUrl: typeof location === 'undefined' ? undefined : location.origin })
  return clients
}

/** What a call through a typed client settles to: the data, or the error body, with the response. */
interface ClientResult {
  data?: unknown
  error?: unknown
  response: Response
}

/** Waits for a call and returns its result, or throws the problem that there was no answer at all. */
async function settle(pending: Promise<ClientResult>): Promise<ClientResult> {
  try {
    return await pending
  }
  catch {
    throw networkProblem()
  }
}

/** Reads a call made through a typed client: the data checked with its schema, or the problem it was. */
export async function callApi<T extends z.ZodType>(pending: Promise<ClientResult>, schema: T): Promise<z.output<T>> {
  const result = await settle(pending)
  if (!result.response.ok) throw problemFromAnswer(result.response.status, result.error)
  const parsed = schema.safeParse(result.data)
  if (!parsed.success) throw badAnswerProblem()
  return parsed.data
}

/** Reads a response's body as JSON, or undefined when it has none or it is not JSON. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  }
  catch {
    return undefined
  }
}

/** Calls one of the site's own routes with JSON, and returns the answer checked with its schema. */
async function sendJson<T extends z.ZodType>(method: 'GET' | 'POST', path: string, body: unknown, schema: T): Promise<z.output<T>> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  let response: Response
  try {
    response = await globalThis.fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    })
  }
  catch {
    throw networkProblem()
  }
  const answer = await readJson(response)
  if (!response.ok) throw problemFromAnswer(response.status, answer)
  const parsed = schema.safeParse(answer)
  if (!parsed.success) throw badAnswerProblem()
  return parsed.data
}

/** Reads one of the site's own routes with GET. */
export function getJson<T extends z.ZodType>(path: string, schema: T): Promise<z.output<T>> {
  return sendJson('GET', path, undefined, schema)
}

/** Sends JSON to one of the site's own routes with POST. */
export function postJson<T extends z.ZodType>(path: string, body: unknown, schema: T): Promise<z.output<T>> {
  return sendJson('POST', path, body, schema)
}

/**
 * Reads one of the site's own static files, such as a curated sample's invoice, as bytes. A file over
 * `maxBytes` is refused, and a failure of any kind is a problem the board can show.
 */
export async function getBytes(path: string, maxBytes: number): Promise<ArrayBuffer> {
  let response: Response
  try {
    response = await globalThis.fetch(path, { credentials: 'same-origin', cache: 'force-cache' })
  }
  catch {
    throw networkProblem()
  }
  if (!response.ok) throw problemFromAnswer(response.status, undefined)
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength > maxBytes) throw badAnswerProblem()
  return bytes
}
