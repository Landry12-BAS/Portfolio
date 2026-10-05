// The service's side of the runner's API: a small client over `fetch` that opens a session, runs a step,
// reads the snapshot and the screenshot, runs axe and closes the session, showing the worker's key with every
// call (key.ts) and checking every answer against protocol.ts. The runner drives a browser that hostile pages
// could, in the worst case, take over, so its answers are read like any stranger's: never larger than the
// largest honest one (a screenshot), and refused when they do not fit their schema. A runner that cannot be
// reached, answers something else, says it is busy or that its browser crashed becomes a `RunnerError` with a
// code the engine turns into the run's failure or its retry.
import type { Lb07Engine, Lb07Step } from '@lb/contracts'
import type { z } from 'zod'

import { RUNNER_KEY_HEADER } from './key.ts'
import { axeResponseSchema, closeResponseSchema, healthResponseSchema, openSessionResponseSchema, runnerErrorSchema, screenshotResponseSchema, snapshotResponseSchema, stepResponseSchema } from './protocol.ts'
import type { CloseResponse, HealthResponse, RunnerFinding, StepResponse } from './protocol.ts'

/** What went wrong with the runner, as a stable code. */
export type RunnerErrorCode = 'unreachable' | 'busy' | 'exhausted' | 'expired' | 'crashed' | 'bad_answer' | 'refused'

/** The most bytes an answer of the runner may have: a screenshot at its limit as base64, with room for the rest. */
export const MAX_ANSWER_BYTES = 1_048_576

/** A failure to get an answer from the runner. */
export class RunnerError extends Error {
  readonly code: RunnerErrorCode

  constructor(code: RunnerErrorCode, message: string) {
    super(message)
    this.name = 'RunnerError'
    this.code = code
  }
}

/** What a runner does, as the engine needs it. The real one is `HttpRunner`; tests may give a script. */
export interface Runner {
  health: () => Promise<HealthResponse>
  open: (request: { runId: string, engine: Lb07Engine, bugToken: string | null, wallClockMs: number }) => Promise<string>
  step: (sessionId: string, index: number, step: Lb07Step) => Promise<StepResponse>
  snapshot: (sessionId: string) => Promise<{ text: string, path: string }>
  screenshot: (sessionId: string) => Promise<{ base64: string, path: string }>
  axe: (sessionId: string, index: number | null) => Promise<{ findings: RunnerFinding[], path: string }>
  close: (sessionId: string) => Promise<CloseResponse>
}

// How long one call to the runner may take: a step's own timeout, the page's settling and a margin.
const CALL_TIMEOUT_MS = 30_000

/** Turns a refusal of the runner into the error code the engine understands. */
function codeOf(status: number, body: unknown): RunnerErrorCode {
  const parsed = runnerErrorSchema.safeParse(body)
  const code = parsed.success ? parsed.data.error.code : ''
  if (code === 'browser') return 'crashed'
  if (status === 409 || code === 'busy') return 'busy'
  if (status === 503 || code === 'exhausted') return 'exhausted'
  if (status === 410 || code === 'expired') return 'expired'
  return 'refused'
}

/**
 * Reads an answer's body as JSON, at most `MAX_ANSWER_BYTES` of it: an answer that says it is longer, or turns out
 * to be, is refused without being read to its end. Undefined when there is no body or it is not JSON.
 */
async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > MAX_ANSWER_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new RunnerError('bad_answer', 'The browser runner answered with more than any answer holds.')
  }
  if (!response.body) return undefined
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body.getReader()
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    size += read.value.byteLength
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new RunnerError('bad_answer', 'The browser runner answered with more than any answer holds.')
    }
    chunks.push(read.value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  catch {
    return undefined
  }
}

/** The runner over HTTP. */
export class HttpRunner implements Runner {
  readonly #baseUrl: string
  readonly #key: string

  /** Points at a runner, such as http://lb07-runner:8008, with the key it wants (key.ts). */
  constructor(baseUrl: string, key: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, '')
    this.#key = key
  }

  /** Makes one call and reads its JSON answer against a schema. */
  async #call<Schema extends z.ZodType>(method: 'GET' | 'POST' | 'DELETE', path: string, body: unknown, schema: Schema): Promise<z.output<Schema>> {
    let response: Response
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: body === undefined ? { [RUNNER_KEY_HEADER]: this.#key } : { [RUNNER_KEY_HEADER]: this.#key, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        redirect: 'error',
      })
    }
    catch {
      throw new RunnerError('unreachable', 'The browser runner could not be reached.')
    }
    let answer: unknown
    try {
      answer = await readBoundedJson(response)
    }
    catch (error) {
      if (error instanceof RunnerError) throw error
      throw new RunnerError('unreachable', 'The browser runner stopped answering.')
    }
    if (!response.ok) throw new RunnerError(codeOf(response.status, answer), `The browser runner refused (${response.status}).`)
    const parsed = schema.safeParse(answer)
    if (!parsed.success) throw new RunnerError('bad_answer', 'The browser runner answered with something unexpected.')
    return parsed.data
  }

  /** The runner's health. */
  health(): Promise<HealthResponse> {
    return this.#call('GET', '/healthz', undefined, healthResponseSchema)
  }

  /** Opens a session and returns its id. */
  async open(request: { runId: string, engine: Lb07Engine, bugToken: string | null, wallClockMs: number }): Promise<string> {
    return (await this.#call('POST', '/sessions', request, openSessionResponseSchema)).sessionId
  }

  /** Runs one step. */
  step(sessionId: string, index: number, step: Lb07Step): Promise<StepResponse> {
    return this.#call('POST', `/sessions/${sessionId}/steps`, { index, step }, stepResponseSchema)
  }

  /** Reads the page's snapshot. */
  snapshot(sessionId: string): Promise<{ text: string, path: string }> {
    return this.#call('GET', `/sessions/${sessionId}/snapshot`, undefined, snapshotResponseSchema)
  }

  /** Reads a screenshot of the page. */
  screenshot(sessionId: string): Promise<{ base64: string, path: string }> {
    return this.#call('GET', `/sessions/${sessionId}/screenshot`, undefined, screenshotResponseSchema)
  }

  /** Runs axe in the page. */
  axe(sessionId: string, index: number | null): Promise<{ findings: RunnerFinding[], path: string }> {
    return this.#call('POST', `/sessions/${sessionId}/axe`, { index }, axeResponseSchema)
  }

  /** Closes the session. */
  close(sessionId: string): Promise<CloseResponse> {
    return this.#call('DELETE', `/sessions/${sessionId}`, undefined, closeResponseSchema)
  }
}
