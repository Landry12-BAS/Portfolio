// How the gateway talks to a provider for one attempt. A JSON attempt succeeds with a
// complete, validated response. A stream attempt succeeds once the first event has
// arrived: until then the call can still move to the next model; after it, the
// answer is streaming and never switches provider (docs/STACK.md, Routing rule 5).
import type { ServerResponse } from 'node:http'

import { ParseError } from 'eventsource-parser'
import type { z } from 'zod'

import { ClientGoneError } from './call.ts'
import type { Attempt, AttemptResult, GatewayContext, ModelCall, Served } from './call.ts'
import type { TokenEstimate } from './budget/estimate.ts'
import type { Model } from './routing/load.ts'
import { classifyStatus, readCapped, ResponseTooLargeError, sendUpstream } from './upstream/client.ts'
import type { Endpoint, FailureReason } from './upstream/client.ts'
import { sseData } from './upstream/sse.ts'
import { readUsage } from './upstream/usage.ts'

// The most of a provider's error response the gateway reads, to quote its message.
const ERROR_BODY_LIMIT = 65_536

// Abort reasons, compared by identity to tell a timeout from a departed client.
const TIMED_OUT = new Error('attempt timed out')
const CLIENT_GONE = new Error('client closed the connection')
const STREAM_IDLE = new Error('stream went idle')
const DEADLINE = new Error('call deadline passed')

/** Builds the result of an attempt that failed in a way the next model may not. */
function retry(reason: FailureReason, status?: number): AttemptResult<never> {
  return { ok: false, failure: { kind: 'retry', reason, ...(status === undefined ? {} : { status }) } }
}

/** Parses JSON, returning undefined instead of throwing on malformed text. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  }
  catch {
    return undefined
  }
}

/**
 * Tells whether a provider's payload is an error object. OpenRouter and others can
 * answer 200 with an error, or send one mid-stream.
 */
function isErrorPayload(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && 'error' in payload && Boolean(payload.error)
}

/**
 * Turns an exception from an attempt into its outcome: the client leaving stops the
 * whole call; a timeout, an oversized or garbled answer, or a network error moves on.
 */
function thrownReason(controller: AbortController, error: unknown): AttemptResult<never> {
  if (controller.signal.reason === CLIENT_GONE) throw new ClientGoneError()
  if (controller.signal.reason === TIMED_OUT) return retry('timeout')
  if (error instanceof ResponseTooLargeError || error instanceof ParseError) return retry('bad_response')
  return retry('network')
}

/**
 * Returns a signal that fires if the client disconnects before its response has been
 * fully written, so the gateway can stop paying for an answer no one will read.
 */
export function watchClient(response: ServerResponse): AbortSignal {
  const controller = new AbortController()
  response.once('close', () => {
    if (!response.writableFinished) controller.abort()
  })
  return controller.signal
}

/** A provider's complete JSON answer: its raw text, relayed as sent, and what the route read from it. */
export interface JsonAnswer<T> {
  text: string
  parsed: T
}

/**
 * Reads what a route needs from a provider's JSON answer. Undefined means the answer is
 * unusable: the attempt fails, and the next model on the chain can try.
 */
export type AnswerReader<T> = (json: unknown, model: Model) => T | undefined

/** Makes an answer reader that accepts any answer matching `schema`, and nothing else. */
export function matching<T>(schema: z.ZodType<T>): AnswerReader<T> {
  return (json) => {
    const parsed = schema.safeParse(json)
    return parsed.success ? parsed.data : undefined
  }
}

/**
 * Runs one attempt's requests under the attempt's clocks: they are aborted when the
 * attempt times out or the client leaves, and a thrown error becomes the attempt's
 * outcome (see `thrownReason`).
 */
async function underAttemptClock<T>(
  clientGone: AbortSignal,
  timeoutMs: number,
  send: (signal: AbortSignal) => Promise<AttemptResult<T>>,
): Promise<AttemptResult<T>> {
  const controller = new AbortController()
  const onClientGone = () => controller.abort(CLIENT_GONE)
  clientGone.addEventListener('abort', onClientGone, { once: true })
  const timer = setTimeout(() => controller.abort(TIMED_OUT), timeoutMs)
  try {
    return await send(controller.signal)
  }
  catch (error) {
    return thrownReason(controller, error)
  }
  finally {
    clearTimeout(timer)
    clientGone.removeEventListener('abort', onClientGone)
    controller.abort()
  }
}

/**
 * Sends one JSON request and reads the complete answer with `read`. An HTTP failure
 * comes back as a failed result; network errors and aborts are thrown.
 */
async function sendJson<T>(
  model: Model,
  endpoint: Endpoint,
  body: Record<string, unknown>,
  read: AnswerReader<T>,
  maxBytes: number,
  signal: AbortSignal,
  now: () => number,
): Promise<AttemptResult<JsonAnswer<T>>> {
  const response = await sendUpstream(model, endpoint, body, false, signal)
  if (!response.ok) {
    const text = await readCapped(response, ERROR_BODY_LIMIT).catch(() => '')
    return { ok: false, failure: classifyStatus(response.status, response.headers, text, now()) }
  }
  const text = await readCapped(response, maxBytes)
  const json = parseJson(text)
  if (json === undefined || isErrorPayload(json)) return retry('bad_response', response.status)
  const parsed = read(json, model)
  if (parsed === undefined) return retry('bad_response', response.status)
  return { ok: true, value: { text, parsed } }
}

/**
 * Makes an attempt that sends a JSON request and waits for the complete JSON answer,
 * which `read` must accept before it counts as a success.
 */
export function jsonAttempt<T>(
  endpoint: Endpoint,
  body: (model: Model) => Record<string, unknown>,
  read: AnswerReader<T>,
  maxBytes: number,
  clientGone: AbortSignal,
  now: () => number,
): Attempt<JsonAnswer<T>> {
  return (model, timeoutMs) => underAttemptClock(clientGone, timeoutMs, signal => sendJson(model, endpoint, body(model), read, maxBytes, signal, now))
}

/**
 * Makes an attempt that sends several JSON requests to the same model at once. It
 * succeeds only when `read` accepts every answer; otherwise it fails like the first
 * request that failed. The guard uses it to read a text in segments.
 */
export function jsonBatchAttempt<T>(
  endpoint: Endpoint,
  bodies: (model: Model) => Record<string, unknown>[],
  read: AnswerReader<T>,
  maxBytes: number,
  clientGone: AbortSignal,
  now: () => number,
): Attempt<JsonAnswer<T>[]> {
  return (model, timeoutMs) => underAttemptClock(clientGone, timeoutMs, async (signal) => {
    const results = await Promise.all(bodies(model).map(body => sendJson(model, endpoint, body, read, maxBytes, signal, now)))
    const answers: JsonAnswer<T>[] = []
    for (const result of results) {
      if (!result.ok) return result
      answers.push(result.value)
    }
    return { ok: true, value: answers }
  })
}

/** A provider stream that has delivered its first event: the call is committed to it. */
export interface OpenStream {
  // Aborting it cancels the upstream request.
  controller: AbortController
  // The remaining events' data, in order.
  events: AsyncGenerator<string, void, undefined>
  first: string
  firstJson: unknown
  // Stops listening for the client leaving; the relay calls it when it ends.
  detach: () => void
}

/**
 * Makes an attempt that opens a streamed chat completion and waits for its first
 * event. Late, empty or erroring streams fail the attempt, so the next model can try.
 */
export function streamAttempt(body: (model: Model) => Record<string, unknown>, clientGone: AbortSignal, now: () => number): Attempt<OpenStream> {
  return async (model, timeoutMs) => {
    const controller = new AbortController()
    const onClientGone = () => controller.abort(CLIENT_GONE)
    const detach = () => clientGone.removeEventListener('abort', onClientGone)
    clientGone.addEventListener('abort', onClientGone, { once: true })
    const timer = setTimeout(() => controller.abort(TIMED_OUT), timeoutMs)
    let committed = false
    try {
      const response = await sendUpstream(model, 'chat', body(model), true, controller.signal)
      if (!response.ok) {
        const text = await readCapped(response, ERROR_BODY_LIMIT).catch(() => '')
        return { ok: false, failure: classifyStatus(response.status, response.headers, text, now()) }
      }
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
        return retry('bad_response', response.status)
      }
      const events = sseData(response.body)
      const first = await events.next()
      if (first.done || first.value === '[DONE]') return retry('bad_response')
      const firstJson = parseJson(first.value)
      if (firstJson === undefined) return retry('bad_response')
      if (isErrorPayload(firstJson)) return retry('stream_error')
      committed = true
      return { ok: true, value: { controller, events, first: first.value, firstJson, detach } }
    }
    catch (error) {
      return thrownReason(controller, error)
    }
    finally {
      clearTimeout(timer)
      // A stream the call didn't commit to is closed here; a committed one is the relay's.
      if (!committed) {
        detach()
        controller.abort()
      }
    }
  }
}

/** Tells whether a stream chunk carries Groq's own usage field (`x_groq.usage`). */
function hasGroqUsage(payload: object): payload is { x_groq: { usage: unknown } } {
  return 'x_groq' in payload && typeof payload.x_groq === 'object' && payload.x_groq !== null && 'usage' in payload.x_groq
}

/**
 * Formats one event for the client, as the provider sent it, with two exceptions:
 * Groq's streaming usage is copied into the standard `usage` field that clients read,
 * and multi-line data is re-serialised onto one line so it can't break the SSE framing.
 */
function frame(data: string, json: unknown): string {
  if (typeof json === 'object' && json !== null && !('usage' in json && json.usage) && hasGroqUsage(json)) {
    return `data: ${JSON.stringify({ ...json, usage: json.x_groq.usage })}\n\n`
  }
  return `data: ${data.includes('\n') ? JSON.stringify(json) : data}\n\n`
}

/** Formats the error event that ends a stream the provider couldn't finish. */
function errorFrame(code: string, message: string): string {
  return `data: ${JSON.stringify({ error: { message, type: 'api_error', code } })}\n\n`
}

/**
 * Relays a committed stream to the client. Ends with `[DONE]` when the provider
 * finished, or with an error event when it failed, went silent or ran past the call's
 * deadline. Settles the budget and records the call span once the stream is over.
 */
export async function* relay(ctx: GatewayContext, call: ModelCall, served: Served<OpenStream>): AsyncGenerator<string, void, undefined> {
  const { controller, events, first, firstJson, detach } = served.value
  let usage: TokenEstimate | undefined = readUsage(firstJson)
  let ok = false
  let error: string | undefined
  // Two clocks: silence between events, and the call's overall deadline.
  const idle = setTimeout(() => controller.abort(STREAM_IDLE), call.alias.timeouts.idleMs)
  const deadline = setTimeout(() => controller.abort(DEADLINE), Math.max(call.deadlineAt - ctx.now(), 0))
  try {
    yield frame(first, firstJson)
    for await (const data of events) {
      idle.refresh()
      if (data === '[DONE]') {
        ok = true
        break
      }
      const json = parseJson(data)
      // Anything that isn't JSON isn't a completion chunk; it is dropped, not relayed.
      if (json === undefined) continue
      usage = readUsage(json) ?? usage
      yield frame(data, json)
      if (isErrorPayload(json)) {
        error = 'provider_stream_error'
        return
      }
    }
    if (ok) {
      yield 'data: [DONE]\n\n'
    }
    else {
      error = 'stream_ended_early'
      yield errorFrame('upstream_failed', 'The provider ended the stream before finishing.')
    }
  }
  catch {
    const reason = controller.signal.reason
    if (reason === CLIENT_GONE) {
      error = 'client_closed'
      return
    }
    error = reason === STREAM_IDLE ? 'stream_idle' : reason === DEADLINE ? 'upstream_timeout' : 'stream_interrupted'
    yield errorFrame(error === 'upstream_timeout' ? 'upstream_timeout' : 'upstream_failed', 'The provider stopped streaming before finishing.')
  }
  finally {
    clearTimeout(idle)
    clearTimeout(deadline)
    detach()
    controller.abort()
    // Ending with neither [DONE] nor an error means the response stream was destroyed
    // under the relay: the client left.
    await call.finish(served, usage, ok ? { ok } : { ok, error: error ?? 'client_closed' })
  }
}
