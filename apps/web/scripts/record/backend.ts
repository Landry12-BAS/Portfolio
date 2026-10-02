// How the recorder talks to a back end and to the gateway: the same signed, size-limited and
// time-limited calls the site's server makes for a visitor (server/lib/upstream.ts), as one
// synthetic anonymous visitor of its own. It makes no model call itself; the back end does, and the
// recorder only watches. Nothing here is specific to a system.
import { randomBytes } from 'node:crypto'
import type { KeyObject } from 'node:crypto'

import { MOCK_IDENTITY_PATH } from '@lb/api-clients/mock-identity'
import type { ServiceTokens } from '@lb/common/tokens'
import { mintVisitorToken } from '@lb/common/visitors'
import { tracePageSchema } from '@lb/contracts'
import type { Span } from '@lb/contracts'

import { callService } from '../../server/lib/upstream.ts'

/** How a trace is known to be complete: its root span has arrived, or it has stopped growing. */
export type TraceEnd = 'root' | 'quiet'

// How many reads in a row must bring nothing new before a trace with no root span is taken as complete.
const QUIET_READS = 3

/** The clock and the waiting the recorder uses, so a test can run a recording without waiting. */
export interface Clock {
  // Unix milliseconds.
  now: () => number
  sleep: (ms: number) => Promise<void>
}

/** Where the recorder sends its requests, and what it signs them with. */
export interface BackendTarget {
  apiUrl: URL
  gatewayUrl: URL
  // The site's private key, which signs visitor tokens.
  signingKey: KeyObject
  // The `web` service's tokens for the gateway's trace route.
  gatewayTokens: ServiceTokens
  fetch: typeof fetch
  clock: Clock
}

/** What a call may add to the default: a query (a list of name and value pairs) and its own time limit. */
export interface CallOptions {
  query?: readonly (readonly [string, string])[]
  timeoutMs?: number
}

/** What a back end answered: the status and the JSON body, if it had one. */
export interface Answer {
  status: number
  body: unknown
}

// The longest the recorder waits on one call, and the biggest answer it accepts.
const CALL_TIMEOUT_MS = 30_000
const MAX_ANSWER_BYTES = 2_000_000

/** One synthetic visitor of a back end, who records a sample's run. */
export class Backend {
  readonly #target: BackendTarget
  // A made-up session hash, so the run is a visitor's own and no other visitor's.
  readonly #sessionKey = randomBytes(24).toString('base64url')

  /** Starts a visitor against a back end. */
  constructor(target: BackendTarget) {
    this.#target = target
  }

  /** The recorder's clock. */
  get clock(): Clock {
    return this.#target.clock
  }

  /** The origin of the API, for a connection that goes to it directly (a WebSocket) instead of through a call. */
  get apiUrl(): URL {
    return this.#target.apiUrl
  }

  /** Makes a fresh visitor token for a system, for a connection that carries it in its first frame instead of a header. */
  visitorToken(system: string): string {
    const target = this.#target
    return mintVisitorToken(target.signingKey, { system, sessionKey: this.#sessionKey }, target.clock.now() / 1_000)
  }

  /** Starts another synthetic visitor on the same back end, who shares nothing with this one but what every visitor shares. */
  another(): Backend {
    return new Backend(this.#target)
  }

  /**
   * Lets minutes pass, for a sample that waits (a hold running out). On a real back end the recorder
   * waits that long on its clock. The test mock keeps a clock of its own for its bookings, which
   * waiting would not move, so it is told to move it.
   */
  async waitMinutes(minutes: number): Promise<void> {
    const target = this.#target
    await target.clock.sleep(minutes * 60_000)
    if (!(await this.isMock())) return
    const answer = await target.fetch(new URL('/__mock/lb02/advance', target.apiUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ minutes }) })
    if (!answer.ok) throw new Error(`The mock would not move its clock (status ${answer.status}).`)
  }

  /**
   * Calls the system's API as the visitor, with a fresh token for the system. A call waits 30 seconds
   * unless its caller says it may take longer, as a question to LB-05's analyst may (up to 90 seconds),
   * and may carry a query, a list of name and value pairs.
   */
  async call(system: string, method: 'GET' | 'POST', path: string, body?: unknown, options: CallOptions = {}): Promise<Answer> {
    const { query = [], timeoutMs = CALL_TIMEOUT_MS } = options
    const target = this.#target
    const token = mintVisitorToken(target.signingKey, { system, sessionKey: this.#sessionKey }, target.clock.now() / 1_000)
    const answer = await callService({
      method,
      origin: target.apiUrl,
      path,
      query,
      token,
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs,
      maxResponseBytes: MAX_ANSWER_BYTES,
      fetch: target.fetch,
    })
    return { status: answer.status, body: answer.body === undefined ? undefined : JSON.parse(answer.body) as unknown }
  }

  /** Asks whether the back end is the test mock, which says so at an address no real back end serves. */
  async isMock(): Promise<boolean> {
    const target = this.#target
    try {
      const answer = await callService({ method: 'GET', origin: target.apiUrl, path: MOCK_IDENTITY_PATH, query: [], token: 'none', timeoutMs: CALL_TIMEOUT_MS, maxResponseBytes: 1_000, fetch: target.fetch })
      return answer.status === 200 && (JSON.parse(answer.body ?? 'null') as { mock?: unknown } | null)?.mock === true
    }
    catch {
      return false
    }
  }

  /** Reads one page of a run's trace from the gateway, or undefined while the run has no trace yet. */
  async #spansPage(runId: string, after: string | undefined): Promise<ReturnType<typeof tracePageSchema.parse> | undefined> {
    const target = this.#target
    const answer = await callService({
      method: 'GET',
      origin: target.gatewayUrl,
      path: `/v1/runs/${runId}/spans`,
      query: after === undefined ? [] : [['after', after]],
      token: target.gatewayTokens.current(),
      timeoutMs: CALL_TIMEOUT_MS,
      maxResponseBytes: MAX_ANSWER_BYTES,
      fetch: target.fetch,
    })
    if (answer.status === 404) return undefined
    return tracePageSchema.parse(JSON.parse(answer.body ?? 'null'))
  }

  /**
   * Reads a run's whole trace: every page, until the run's root span has arrived. A trace with no
   * root span (a conversation writes none) is read until it has been quiet for a few reads in a
   * row instead. Gives up after `patienceMs` of waiting, since a trace that never finishes is
   * not one to record.
   */
  async readTrace(runId: string, patienceMs: number, ends: TraceEnd = 'root'): Promise<Span[]> {
    const { clock } = this.#target
    const startedAt = clock.now()
    const spans: Span[] = []
    let cursor: string | undefined
    let quietReads = 0
    for (;;) {
      const page = await this.#spansPage(runId, cursor)
      if (page) {
        spans.push(...page.spans)
        cursor = page.cursor
        if (ends === 'root' && page.finished && !page.more) return spans
        quietReads = page.spans.length === 0 && !page.more ? quietReads + 1 : 0
        if (ends === 'quiet' && spans.length > 0 && quietReads >= QUIET_READS) return spans
      }
      if (clock.now() - startedAt > patienceMs) throw new Error(`The trace of run ${runId} did not finish within ${Math.round(patienceMs / 1_000)} seconds.`)
      await clock.sleep(page?.more ? 0 : 500)
    }
  }
}
