// Calling a service on the visitor's behalf, and passing its answer back safely. This is the
// one place the server's fetch leaves for a back end or the gateway, and it holds the rules that
// make forwarding safe:
//
// - The address is built from the configured origin and a path the route table matched, and is
//   checked to still be that origin, so nothing a visitor sends can choose where the call goes (SSRF).
// - A redirect is never followed: the answer to a 3xx is a failure, not a visit somewhere else.
// - Nothing of the visitor's request is forwarded but what the route needs: the bearer token this
//   server made, a JSON content type, and the JSON body written again. Never a cookie, never
//   the visitor's address or headers.
// - The answer is read with a size limit and a deadline, and only JSON is accepted.
// - Only a few statuses and headers go back to the visitor. An error is passed on only if it is
//   the platform's error shape, and then only with the fields that shape allows; anything else
//   (a stack trace, an HTML error page, a database message) becomes a generic failure.
import { platformErrorSchema } from '@lb/contracts'

import { ApiError, problems } from './errors.ts'

// The statuses that go back to the visitor as they are. Everything else is a failure of the system behind the demo.
const PASSED_STATUSES = new Set([200, 201, 202, 204, 400, 404, 409, 413, 422, 429, 503])

/** What to ask a service. */
export interface UpstreamRequest {
  method: string
  // The service's origin, such as https://api.example.com.
  origin: URL
  // The path, already built from a documented route: `/api/lb01/tickets/tk1`.
  path: string
  // The query, already checked against what the route documents.
  query: readonly (readonly [string, string])[]
  // The bearer token: a visitor token for a back end, a service token for the gateway.
  token: string
  // The JSON body to send, written as text; absent for a read.
  body?: string
  timeoutMs: number
  maxResponseBytes: number
  fetch: typeof fetch
}

/** What comes back: a status, the JSON text to send on (absent for 204), and the headers worth keeping. */
export interface UpstreamAnswer {
  status: number
  body: string | undefined
  headers: Record<string, string>
}

/** Builds the address of a call, and checks that it is still on the service's own origin. */
function addressOf(request: UpstreamRequest): URL {
  const url = new URL(request.path, request.origin)
  for (const [name, value] of request.query) url.searchParams.append(name, value)
  if (url.origin !== request.origin.origin) throw problems.upstreamFailed()
  return url
}

/** Reads a response body to the end, giving up at `limit` bytes. */
async function readLimited(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.length
    if (length > limit) {
      await reader.cancel()
      throw problems.upstreamFailed()
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Keeps from a service's headers only what the visitor needs: how long to wait before asking again. */
function keptHeaders(response: Response): Record<string, string> {
  const retryAfter = response.headers.get('retry-after')
  return retryAfter !== null && /^\d{1,6}$/.test(retryAfter) ? { 'retry-after': retryAfter } : {}
}

/** Turns a service's error answer into the platform's error body, or a generic one when it isn't that shape. */
function errorBodyOf(status: number, text: string): string {
  let parsed: ReturnType<typeof platformErrorSchema.safeParse>
  try {
    parsed = platformErrorSchema.safeParse(JSON.parse(text))
  }
  catch {
    parsed = platformErrorSchema.safeParse(undefined)
  }
  if (parsed.success) return JSON.stringify(parsed.data)
  return JSON.stringify(new ApiError(status, 'upstream_error', 'The system behind this demo could not do that.').toBody())
}

/**
 * Calls a service and returns what may be passed on to the visitor. Throws an ApiError for a
 * timeout (504) and for anything that must never be passed on (502): a network failure, a
 * redirect, an answer that is too big, not JSON, or a status the visitor has no use for.
 */
export async function callService(request: UpstreamRequest): Promise<UpstreamAnswer> {
  const headers: Record<string, string> = { authorization: `Bearer ${request.token}`, accept: 'application/json' }
  if (request.body !== undefined) headers['content-type'] = 'application/json'
  let response: Response
  try {
    response = await request.fetch(addressOf(request), {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(request.timeoutMs),
    })
  }
  catch (error) {
    if (error instanceof ApiError) throw error
    throw error instanceof Error && error.name === 'TimeoutError' ? problems.upstreamTimeout() : problems.upstreamFailed()
  }
  if (!PASSED_STATUSES.has(response.status)) {
    await response.body?.cancel()
    throw problems.upstreamFailed()
  }
  if (response.status === 204) {
    await response.body?.cancel()
    return { status: 204, body: undefined, headers: {} }
  }
  if (!/^application\/json(?:\s*;.*)?$/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel()
    throw problems.upstreamFailed()
  }
  let text: string
  try {
    text = await readLimited(response, request.maxResponseBytes)
  }
  catch (error) {
    throw error instanceof ApiError ? error : error instanceof Error && error.name === 'TimeoutError' ? problems.upstreamTimeout() : problems.upstreamFailed()
  }
  const failed = response.status >= 400
  if (!failed) {
    try {
      JSON.parse(text)
    }
    catch {
      throw problems.upstreamFailed()
    }
  }
  return { status: response.status, body: failed ? errorBodyOf(response.status, text) : text, headers: keptHeaders(response) }
}
