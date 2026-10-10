// Calling a service on the visitor's behalf, and passing its answer back safely. This is the
// one place the server's fetch leaves for a back end or the gateway, and it holds the rules that
// make forwarding safe:
//
// - The address is built from the configured origin and a path the route table matched, and is
//   checked to still be that origin, so nothing a visitor sends can choose where the call goes (SSRF).
// - A redirect is never followed: the answer to a 3xx is a failure, not a visit somewhere else.
// - Nothing of the visitor's request is forwarded but what the route needs: the bearer token this
//   server made, a content type, and the body (JSON written again, or an upload's bytes). Never a
//   cookie, never the visitor's address or headers.
// - The answer is read with a size limit and a deadline, and only JSON is accepted, with one
//   exception: a route whose document says it answers with a file (a page's picture, a CSV export)
//   may answer with a file of exactly the media types the document lists, and no other.
// - Only a few statuses and headers go back to the visitor. An error is passed on only if it is
//   the platform's error shape, and then only with the fields that shape allows; anything else
//   (a stack trace, an HTML error page, a database message) becomes a generic failure.
import { platformErrorSchema } from '@lb/contracts'

import { ApiError, problems } from './errors.ts'

// The statuses that go back to the visitor as they are. Everything else is a failure of the system behind the demo.
// 415 is one of them: an upload the system will not take (a file it does not read) is the visitor's to be told.
const PASSED_STATUSES = new Set([200, 201, 202, 204, 400, 404, 409, 413, 415, 422, 429, 503])

// A name the system offers a file under, as it writes it (`attachment; filename="invoice.json"`): a plain one, or nothing is passed on.
const SAFE_DISPOSITION = /^(?:attachment|inline); filename="[\w.-]{1,64}"$/

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
  // The body to send: JSON written as text, or the bytes of an upload; absent for a read.
  body?: string | Uint8Array<ArrayBuffer>
  // What the body is written in. JSON unless an upload says otherwise (with the boundary its parts are cut at).
  contentType?: string
  // The media types of the files the route may answer with in place of JSON; absent for a route that answers JSON only.
  files?: readonly string[]
  timeoutMs: number
  maxResponseBytes: number
  fetch: typeof fetch
}

/** A file a service answered with: its bytes, and the Content-Type to send them on under. */
export interface UpstreamFile {
  bytes: Uint8Array
  contentType: string
}

/** What comes back: a status, the JSON text to send on (absent for 204 and for a file), a file if it is one, and the headers worth keeping. */
export interface UpstreamAnswer {
  status: number
  body: string | undefined
  headers: Record<string, string>
  file?: UpstreamFile
}

/** Builds the address of a call, and checks that it is still on the service's own origin. */
function addressOf(request: UpstreamRequest): URL {
  const url = new URL(request.path, request.origin)
  for (const [name, value] of request.query) url.searchParams.append(name, value)
  if (url.origin !== request.origin.origin) throw problems.upstreamFailed()
  return url
}

/** Reads a response body to the end, giving up at `limit` bytes. */
async function readLimited(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
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
  return new Uint8Array(Buffer.concat(chunks))
}

/**
 * Keeps from a service's headers only what the visitor needs: how long to wait before asking again, and, for
 * a route that answers with files, the plain name the system offers the file under.
 */
function keptHeaders(response: Response, answersFiles: boolean): Record<string, string> {
  const kept: Record<string, string> = {}
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter !== null && /^\d{1,6}$/.test(retryAfter)) kept['retry-after'] = retryAfter
  const disposition = response.headers.get('content-disposition')
  if (answersFiles && response.ok && disposition !== null && SAFE_DISPOSITION.test(disposition)) kept['content-disposition'] = disposition
  return kept
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

/** The media type of a response, without its parameters and in lower case: `text/csv; charset=utf-8` is `text/csv`. */
function mediaTypeOf(response: Response): string {
  return (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
}

/** The Content-Type a file is sent on under: its media type, and UTF-8 for text, which is what the system writes. */
function fileContentType(mediaType: string): string {
  return mediaType.startsWith('text/') ? `${mediaType}; charset=utf-8` : mediaType
}

/** Reads a response body to the end as the bytes it is, or answers 504 or 502 as a read of JSON would. */
async function readBytes(response: Response, limit: number): Promise<Uint8Array> {
  try {
    return await readLimited(response, limit)
  }
  catch (error) {
    throw error instanceof ApiError ? error : error instanceof Error && error.name === 'TimeoutError' ? problems.upstreamTimeout() : problems.upstreamFailed()
  }
}

/**
 * Calls a service and returns what may be passed on to the visitor. Throws an ApiError for a
 * timeout (504) and for anything that must never be passed on (502): a network failure, a
 * redirect, an answer that is too big, not JSON (or not one of the files the route may answer
 * with), or a status the visitor has no use for.
 */
export async function callService(request: UpstreamRequest): Promise<UpstreamAnswer> {
  const answersFiles = (request.files?.length ?? 0) > 0
  const headers: Record<string, string> = { authorization: `Bearer ${request.token}`, accept: ['application/json', ...(request.files ?? [])].join(', ') }
  if (request.body !== undefined) headers['content-type'] = request.contentType ?? 'application/json'
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
  const mediaType = mediaTypeOf(response)
  const isJson = /^application\/json(?:\s*;.*)?$/i.test(response.headers.get('content-type') ?? '')
  const isFile = !isJson && response.status === 200 && request.files?.includes(mediaType) === true
  if (!isJson && !isFile) {
    await response.body?.cancel()
    throw problems.upstreamFailed()
  }
  const bytes = await readBytes(response, request.maxResponseBytes)
  if (isFile) return { status: 200, body: undefined, headers: keptHeaders(response, answersFiles), file: { bytes, contentType: fileContentType(mediaType) } }
  const text = Buffer.from(bytes).toString('utf8')
  const failed = response.status >= 400
  if (!failed) {
    try {
      JSON.parse(text)
    }
    catch {
      throw problems.upstreamFailed()
    }
  }
  return { status: response.status, body: failed ? errorBodyOf(response.status, text) : text, headers: keptHeaders(response, answersFiles) }
}
