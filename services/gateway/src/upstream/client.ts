// The HTTP side of talking to a provider: sending a request, reading its answer safely,
// and deciding what a failure means for the rest of the chain.
import type { Model } from '../routing/load.ts'

/**
 * The provider endpoints the gateway calls: the OpenAI-compatible chat and embeddings
 * endpoints, and a provider's own endpoint for one model (Workers AI's /ai/run).
 */
export type Endpoint = 'chat' | 'embeddings' | 'run'

/** Returns the URL of an endpoint for one model. */
export function endpointUrl(model: Model, endpoint: Endpoint): string {
  const provider = model.provider
  if (endpoint === 'chat') return `${provider.baseUrl}/chat/completions`
  if (endpoint === 'embeddings') return `${provider.baseUrl}/embeddings`
  return `${provider.runUrl}/${model.id}`
}

/** Why an attempt failed in a way the next model on the chain might not. */
export type FailureReason
  = | 'rate_limited'
    | 'server_error'
    | 'unavailable'
    | 'timeout'
    | 'network'
    | 'bad_response'
    | 'stream_error'

/**
 * A failed attempt. `retry` moves the call to the next model on the chain; `reject`
 * means the request itself is at fault, so no other model would do better.
 */
export type Failure
  = | { kind: 'retry', reason: FailureReason, status?: number, retryAfterMs?: number }
    | { kind: 'reject', status: number, message: string }

/**
 * Sends a request to a model's provider with its API key. Redirects are refused, so a
 * compromised or misconfigured endpoint can't bounce the key to another host.
 */
export async function sendUpstream(model: Model, endpoint: Endpoint, body: Record<string, unknown>, stream: boolean, signal: AbortSignal): Promise<Response> {
  const provider = model.provider
  return fetch(endpointUrl(model, endpoint), {
    method: 'POST',
    headers: {
      // Provider extras first, so they can never replace the credentials or the type.
      ...provider.headers,
      'authorization': `Bearer ${provider.apiKey}`,
      'content-type': 'application/json',
      'accept': stream ? 'text/event-stream' : 'application/json',
    },
    body: JSON.stringify(body),
    redirect: 'error',
    signal,
  })
}

// A provider can't pause a model for longer than a day.
const MAX_RETRY_AFTER_MS = 86_400_000

/**
 * Reads a Retry-After header (seconds or an HTTP date) as milliseconds from now,
 * between one second and one day. Returns undefined when it is missing or unreadable.
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - nowMs
  if (!Number.isFinite(ms)) return undefined
  return Math.min(Math.max(ms, 1_000), MAX_RETRY_AFTER_MS)
}

// Provider messages are quoted to callers, so they are kept short.
const MAX_MESSAGE = 300

/**
 * Pulls the provider's error message out of its response body, cut short and stripped
 * of control characters, or a generic message when there isn't a usable one. Reads the
 * OpenAI envelope, a bare message, and Cloudflare's `errors` list.
 */
export function upstreamMessage(text: string): string {
  let message: unknown
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } | string, errors?: { message?: unknown }[], message?: unknown }
    const firstError = Array.isArray(body.errors) ? body.errors[0]?.message : undefined
    message = typeof body.error === 'string' ? body.error : body.error?.message ?? firstError ?? body.message
  }
  catch {
    message = undefined
  }
  if (typeof message !== 'string' || message.trim() === '') return 'The provider rejected the request.'
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return message.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, MAX_MESSAGE)
}

/** Decides what a provider's error status means: try the next model, or give up. */
export function classifyStatus(status: number, headers: Headers, text: string, nowMs: number): Failure {
  if (status === 429) return { kind: 'retry', reason: 'rate_limited', status, retryAfterMs: parseRetryAfter(headers.get('retry-after'), nowMs) }
  // Malformed or unsupported input fails the same way on every model.
  if (status === 400 || status === 422) return { kind: 'reject', status, message: upstreamMessage(text) }
  if (status >= 500) return { kind: 'retry', reason: 'server_error', status }
  // 401, 402, 403, 404, 408, 413 and the rest: this provider or model can't serve the
  // call right now (a revoked key, a withdrawn free model, a smaller context), but the
  // next one may.
  return { kind: 'retry', reason: 'unavailable', status }
}

/** Thrown when a provider's answer is bigger than the gateway will hold in memory. */
export class ResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`The provider's response is larger than ${limit} bytes.`)
    this.name = 'ResponseTooLargeError'
  }
}

/**
 * Reads a response body as text, refusing to buffer more than `maxBytes`, so a
 * misbehaving provider can't exhaust the gateway's memory.
 */
export async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new ResponseTooLargeError(maxBytes)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}
