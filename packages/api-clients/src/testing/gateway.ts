// The AI gateway's Scope route as the mock back end plays it: GET /v1/runs/{runId}/spans, which
// the site's server calls with the `web` service's token (services/gateway/src/routes/runs.ts).
// The token is checked by the real gateway's own code, so a token the site mints that the real
// gateway would refuse is refused here too; the page's shape (spans, cursor, more, finished)
// follows the real route's, and its limits are the real ones: 500 spans at most, 200 by default.
import { importServiceKeys, verifyServiceToken } from '../../../../services/gateway/src/auth/service-token.ts'
import type { ServiceKeys } from '../../../../services/gateway/src/auth/service-token.ts'

import type { Answer } from './lb01.ts'
import { errorAnswer } from './lb01.ts'
import type { MockSpan } from './spans.ts'

// The most spans a page may carry, and how many it carries when the caller doesn't say.
const MAX_LIMIT = 500
const DEFAULT_LIMIT = 200
// A run ID, as the real route and the Caddy edge accept it.
const RUN_ID = /^[\w-]{8,64}$/
// A stream cursor, such as 1790000000123-0.
const CURSOR = /^\d{1,16}-\d{1,16}$/

/** Checks the `web` service's tokens, and answers the Scope route from the mock's spans. */
export class MockGateway {
  readonly #keys: Promise<ServiceKeys>
  readonly #now: () => number
  readonly #spansOf: (runId: string) => MockSpan[] | undefined

  /**
   * Trusts the `web` service's public key (base64url). `spansOf` returns a run's spans so far,
   * or undefined for a run that has none.
   */
  constructor(webPublicKey: string, now: () => number, spansOf: (runId: string) => MockSpan[] | undefined) {
    this.#keys = importServiceKeys({ web: webPublicKey })
    this.#now = now
    this.#spansOf = spansOf
  }

  /** Answers a read of a run's spans, after checking the caller's service token. */
  async spans(authorization: string | undefined, runId: string, search: URLSearchParams): Promise<Answer> {
    try {
      await verifyServiceToken(authorization, await this.#keys, new Date(this.#now()))
    }
    catch {
      return errorAnswer(401, 'invalid_service_token', 'The service token is invalid or expired.')
    }
    const limit = search.has('limit') ? Number(search.get('limit')) : DEFAULT_LIMIT
    const after = search.get('after') ?? undefined
    if (!RUN_ID.test(runId) || (after !== undefined && !CURSOR.test(after)) || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return errorAnswer(400, 'invalid_request', 'Invalid request.')
    }
    const spans = this.#spansOf(runId)
    if (!spans) return errorAnswer(404, 'run_not_found', 'There is no trace for that run: its ID is unknown, or its trace has expired.')
    return { status: 200, body: pageOf(runId, spans, after, limit) }
  }
}

/** Makes the stream ID of the span at a position: when it ended, and its place among the spans. */
function entryId(spans: readonly MockSpan[], index: number): string {
  return `${spans[index]?.endMs ?? 0}-${index}`
}

/** Cuts the page that follows `after` out of a run's spans, the way the real route does. */
function pageOf(runId: string, spans: readonly MockSpan[], after: string | undefined, limit: number): Record<string, unknown> {
  const first = after === undefined ? 0 : spans.findIndex((_, index) => entryId(spans, index) === after) + 1
  // A cursor the mock never handed out starts from the beginning, as an unknown one would be refused.
  const waiting = spans.slice(Math.max(first, 0))
  const page = waiting.slice(0, limit)
  const last = first + page.length - 1
  return {
    runId,
    spans: page,
    cursor: page.length > 0 ? entryId(spans, last) : (after ?? '0-0'),
    more: waiting.length > limit,
    finished: spans.some(span => span.kind === 'system.run' && span.parentId === undefined),
  }
}
