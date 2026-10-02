// GET /v1/runs/{runId}/spans: a run's trace, for the Scope. The site's server calls it with
// the `web` service's token and hands the spans to the visitor's browser, which polls it
// while a run is live and opens it again for a permalink.
//
// A trace is metadata: names, timings, models, token counts, scores. Spans never carry
// a prompt or an answer (docs/SECURITY.md, section 4), and this route checks that again on
// the way out: every stream entry must be a valid span of the strict schema in spans.ts, or
// it is passed over. The run's ID is the only key to its trace, so the route answers a
// run that isn't there exactly like one that has expired, and never logs the ID: the request
// serializer in log.ts replaces it in every logged URL, and test/integration/log.test.ts reads the
// log to prove it.
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { GatewayContext } from '../call.ts'
import { GatewayError } from '../errors.ts'
import type { RunSpanPage, SpanQuery } from '../spans.ts'
import { parseBody } from './body.ts'

// The most spans one response may carry, and the default. A run has at most 1,000 spans in
// its stream, and the response is also cut at a byte budget (spans.ts).
const MAX_LIMIT = 500
const DEFAULT_LIMIT = 200

// A run ID is what x-lb-run-id allows (call.ts) and what the Caddy edge lets through.
const params = z.object({ runId: z.string().regex(/^[\w-]{8,64}$/, '8 to 64 letters, digits, underscores or hyphens') })
// `after` is a stream ID the previous page handed out, such as 1790000000123-0.
const query = z.object({
  after: z.string().regex(/^\d{1,16}-\d{1,16}$/, 'the cursor of the previous page').optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
})

/**
 * Reads a page of a run's spans. A Redis failure becomes a 503 that says nothing about
 * the cause, the way the budget store's does, so the gateway fails closed and leaks nothing.
 */
async function readPage(ctx: GatewayContext, runId: string, spanQuery: SpanQuery): Promise<RunSpanPage | undefined> {
  try {
    return await ctx.spanReader.read(runId, spanQuery)
  }
  catch (error) {
    ctx.log.warn({ errorName: error instanceof Error ? error.name : 'unknown' }, 'could not read a run\'s spans')
    throw new GatewayError(503, 'gateway_unavailable', 'The trace store is unavailable.', 5_000)
  }
}

/** Registers the Scope's route on the /v1 scope. Only a service that routing.yaml lists under `traceReaders` may call it. */
export function registerRuns(app: FastifyInstance, ctx: GatewayContext): void {
  app.get('/runs/:runId/spans', async (request) => {
    // 1. Who: a service made for reading traces, and no model-calling service.
    const reader = ctx.routing.traceReaders.get(request.service)
    if (!reader) throw new GatewayError(403, 'permission_denied', 'This service may not read run traces.')

    // 2. What: a valid run ID and cursor, before anything is read.
    const { runId } = parseBody(params, request.params)
    const { after, limit } = parseBody(query, request.query)

    // 3. The page: spans in the order they were written, only of systems this service may read.
    const page = await readPage(ctx, runId, { after, limit, systems: reader.systems })
    if (!page) throw new GatewayError(404, 'run_not_found', 'There is no trace for that run: its ID is unknown, or its trace has expired.')
    return { runId, ...page }
  })
}
