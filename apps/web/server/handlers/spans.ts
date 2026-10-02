// GET /api/runs/:runId/spans: a run's trace, for the Scope. The site's server reads it from the
// gateway's one public route with the `web` service's token (NUXT_LB_GATEWAY_SERVICE_KEY), which
// may read traces and call no model, and hands the page to the browser, which polls it while a run
// is live and opens it again for a permalink. Anyone with a run's ID may read its trace: the ID
// is 8 to 64 unguessable characters, the trace is metadata only, and it expires within a day. So no
// session or Turnstile check applies, and the page is checked again here, strictly, before it is passed on.
//
// A read of a full page costs the gateway about 10 ms of CPU, and this route is open, so a page is kept for a
// second (server/lib/trace-cache.ts): a Scope, or many viewers of one trace, cost the gateway one read of
// each page a second, and the gateway counts the reads of each run on its own for anything past that
// (services/gateway/src/read-limit.ts).
import { tracePageSchema } from '@lb/contracts'
import { getRequestURL, getRouterParam } from 'h3'

import { defineApiHandler } from '../lib/api.ts'
import type { RawAnswer } from '../lib/api.ts'
import { problems } from '../lib/errors.ts'
import { MAX_TRACE_PAGE_BYTES, TRACE_TIMEOUT_MS } from '../lib/policy.ts'
import { requireConfig } from '../lib/services.ts'
import type { SiteServices } from '../lib/services.ts'
import type { TraceAnswer } from '../lib/trace-cache.ts'
import { callService } from '../lib/upstream.ts'

// A run ID, as the gateway and the Caddy edge accept it.
const RUN_ID = /^[\w-]{8,64}$/
// The cursor the previous page handed out, and the page sizes the gateway allows.
const CURSOR = /^\d{1,16}-\d{1,16}$/
const LIMIT = /^\d{1,3}$/

/** Reads the query a trace read may carry: only `after` and `limit`, each of the right shape. */
function traceQuery(search: URLSearchParams): [string, string][] {
  const query: [string, string][] = []
  for (const name of search.keys()) {
    if (name !== 'after' && name !== 'limit') throw problems.invalidRequest('The query string is not accepted.')
  }
  for (const name of ['after', 'limit']) {
    if (search.getAll(name).length > 1) throw problems.invalidRequest('Each query parameter may appear once.')
  }
  const after = search.get('after')
  const limit = search.get('limit')
  if (after !== null) {
    if (!CURSOR.test(after)) throw problems.invalidRequest('The cursor is not one this site handed out.')
    query.push(['after', after])
  }
  if (limit !== null) {
    if (!LIMIT.test(limit) || Number(limit) < 1 || Number(limit) > 500) throw problems.invalidRequest('The limit is from 1 to 500.')
    query.push(['limit', limit])
  }
  return query
}

/** Names one page of one run's trace: the run, then the cursor and the size in a fixed order, so the same page is always the same key. */
function pageKey(runId: string, query: readonly (readonly [string, string])[]): string {
  return `${runId}?${query.map(([name, value]) => `${name}=${value}`).join('&')}`
}

/** Asks the gateway for a page of a run's trace, and passes on what fits the page schema. */
async function fetchPage(site: SiteServices, runId: string, query: [string, string][]): Promise<TraceAnswer> {
  const config = requireConfig(site)
  const answer = await callService({
    method: 'GET',
    origin: config.gatewayUrl,
    path: `/v1/runs/${runId}/spans`,
    query,
    token: config.gatewayTokens.current(),
    timeoutMs: TRACE_TIMEOUT_MS,
    maxResponseBytes: MAX_TRACE_PAGE_BYTES,
    fetch: site.fetch,
  })
  if (answer.status !== 200 || answer.body === undefined) return answer
  const page = tracePageSchema.safeParse(JSON.parse(answer.body))
  if (!page.success || page.data.runId !== runId) throw problems.upstreamFailed()
  return { status: 200, body: JSON.stringify(page.data), headers: {} }
}

/** Reads a page of a run's trace: the one the site was sent a moment ago, or one from the gateway. */
export default defineApiHandler(async (event, site): Promise<RawAnswer> => {
  requireConfig(site)
  const runId = getRouterParam(event, 'runId') ?? ''
  // A run ID of the wrong shape is a run that is not there: nothing is asked of the gateway.
  if (!RUN_ID.test(runId)) throw problems.notFound()
  const query = traceQuery(getRequestURL(event).searchParams)
  return site.traces.read(pageKey(runId, query), async () => fetchPage(site, runId, query))
}, { cache: 'no-store' })
