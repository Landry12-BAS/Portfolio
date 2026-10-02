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

  /** Calls the system's API as the visitor, with a fresh token for the system. The query is a list of name and value pairs. */
  async call(system: string, method: 'GET' | 'POST', path: string, body?: unknown, query: readonly (readonly [string, string])[] = []): Promise<Answer> {
    const target = this.#target
    const token = mintVisitorToken(target.signingKey, { system, sessionKey: this.#sessionKey }, target.clock.now() / 1_000)
    const answer = await callService({
      method,
      origin: target.apiUrl,
      path,
      query,
      token,
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: CALL_TIMEOUT_MS,
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
   * root span (a workflow run's steps are spans of their own, with no span around them) is read
   * until it has been quiet for a few reads in a row instead. Gives up after `patienceMs` of
   * waiting, since a trace that never finishes is not one to record.
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
