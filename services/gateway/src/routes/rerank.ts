// POST /v1/rerank: scores how well each document answers a query, and returns the
// documents best first. The request and answer take the shape Cohere and Jina made
// common; the gateway maps them to Workers AI's own reranker endpoint and back, and
// brings every score to the same 0 to 1 scale.
import type { FastifyInstance } from 'fastify'

import { jsonAttempt, watchClient } from '../attempts.ts'
import { estimateRerankInput, textTokens } from '../budget/estimate.ts'
import { assertPlannable, ModelCall, readCallMeta, resolveAlias } from '../call.ts'
import type { GatewayContext } from '../call.ts'
import { GatewayError } from '../errors.ts'
import type { Alias, Model } from '../routing/load.ts'
import { planChain } from '../routing/plan.ts'
import type { Capability } from '../routing/schema.ts'
import { rerankRequestSchema, workersRerankSchema } from '../schemas/rerank.ts'
import type { RerankRequest } from '../schemas/rerank.ts'
import { parseBody } from './body.ts'

const MIB = 1_048_576
// 64 scores are a few kilobytes; anything near a megabyte is not a rerank answer.
const MAX_RERANK_BYTES = MIB
const needs: ReadonlySet<Capability> = new Set(['rerank'])

/** One document's place in a ranking: its index in the request, and its relevance from 0 to 1. */
export interface Ranked {
  index: number
  relevance_score: number
}

/**
 * Checks that every document fits the reranker together with the query. A reranker
 * reads the query and one document at a time and quietly cuts whatever runs past its
 * window, so an oversized document would be ranked on its opening alone.
 */
export function assertDocumentsFit(request: RerankRequest, alias: Alias): void {
  const queryTokens = textTokens(request.query)
  request.documents.forEach((document, index) => {
    const tokens = queryTokens + textTokens(document)
    if (tokens > alias.maxInputTokens) {
      throw new GatewayError(413, 'input_too_large', `Document ${index} and the query come to about ${tokens} tokens; ${alias.name} reads up to ${alias.maxInputTokens} at a time. Split the document.`)
    }
  })
}

/** Brings a raw reranker score to 0 to 1: logits through the logistic function, probabilities as they are. */
export function relevance(score: number, scores: Model['scores']): number {
  return scores === 'logits' ? 1 / (1 + Math.exp(-score)) : score
}

/**
 * Turns a reranker's answer into the ranking callers get: every document scored exactly
 * once, on a 0 to 1 scale, best first (ties in request order), cut to `topN`. Returns
 * undefined when the answer doesn't cover exactly the documents sent, so the attempt
 * fails rather than rank the wrong things.
 */
export function ranking(json: unknown, documentCount: number, scores: Model['scores'], topN: number): Ranked[] | undefined {
  const parsed = workersRerankSchema.safeParse(json)
  if (!parsed.success) return undefined
  const seen = new Set<number>()
  const ranked: Ranked[] = []
  for (const { id, score } of parsed.data.result.response) {
    if (id >= documentCount || seen.has(id)) return undefined
    seen.add(id)
    const relevanceScore = relevance(score, scores)
    if (!(relevanceScore >= 0 && relevanceScore <= 1)) return undefined
    ranked.push({ index: id, relevance_score: relevanceScore })
  }
  if (seen.size !== documentCount) return undefined
  ranked.sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index)
  return ranked.slice(0, topN)
}

/** Registers the rerank route on the /v1 scope. */
export function registerRerank(app: FastifyInstance, ctx: GatewayContext): void {
  app.post('/rerank', { bodyLimit: 2 * MIB }, async (request, reply) => {
    // 1. Check the headers, the body, the alias and the sizes before spending anything.
    const meta = readCallMeta(request, ctx.routing)
    const body = parseBody(rerankRequestSchema, request.body)
    const alias = resolveAlias(ctx.routing, meta.system, body.model, 'rerank')
    assertDocumentsFit(body, alias)
    const plan = planChain(alias, meta.dataClass, ctx.profile, needs)
    assertPlannable(plan, alias, needs)

    // 2. Count the call, then score every document. Workers AI is asked for all of
    //    them, so the gateway can check the answer covers each one before cutting it.
    const count = body.documents.length
    const topN = Math.min(body.top_n ?? count, count)
    const call = new ModelCall(ctx, meta, alias, plan, { input: estimateRerankInput(body.query, body.documents), output: 0 }, false)
    await call.admit()
    const served = await call.run(jsonAttempt(
      'run',
      () => ({ query: body.query, contexts: body.documents.map(text => ({ text })), top_k: count }),
      (json, model) => ranking(json, count, model.scores, topN),
      MAX_RERANK_BYTES,
      watchClient(reply.raw),
      ctx.now,
    ))

    // 3. Workers AI reports no token usage for reranking, so the estimate stands.
    await call.finish(served, undefined, { ok: true, attrs: { documents: count } })
    return reply.headers(call.headers(served.model)).send({ object: 'list', model: alias.name, results: served.value.parsed })
  })
}
