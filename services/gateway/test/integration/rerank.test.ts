// Integration tests for reranking: Workers AI's own endpoint, scores on a 0 to 1 scale,
// best first, and answers that don't cover the documents sent.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { reranked } from '../support/fake-provider.ts'
import { startGateway } from '../support/gateway.ts'
import type { TestGateway } from '../support/gateway.ts'

let gw: TestGateway

beforeEach(async () => {
  gw = await startGateway()
})

afterEach(async () => {
  await gw.close()
})

const documents = ['Refunds for damaged bags', 'Delivery times in Czechia', 'Changing a subscription']

/** Asks lb-rerank to rank the documents, with any field overridden. */
async function rerank(overrides: Record<string, unknown> = {}, headers: Record<string, string | undefined> = {}) {
  return gw.app.inject({
    method: 'POST',
    url: '/v1/rerank',
    headers: await gw.headers(headers),
    payload: { model: 'lb-rerank', query: 'my bag arrived torn', documents, ...overrides },
  })
}

/** The logistic function, which maps a reranker's logit to 0 to 1. */
function sigmoid(logit: number): number {
  return 1 / (1 + Math.exp(-logit))
}

describe('reranking', () => {
  it('asks Workers AI\'s own endpoint to score every document, and answers best first on a 0 to 1 scale', async () => {
    gw.providers.beta.enqueue({ kind: 'json', body: reranked([[1, -2], [0, 3.5], [2, 0.25]]) })

    const response = await rerank()

    expect(response.statusCode).toBe(200)
    expect(response.headers['x-lb-model']).toBe('beta/rerank')
    const answer = response.json<{ object: string, model: string, results: { index: number, relevance_score: number }[] }>()
    expect(answer.object).toBe('list')
    expect(answer.model).toBe('lb-rerank')
    expect(answer.results.map(result => result.index)).toEqual([0, 2, 1])
    expect(answer.results[0]?.relevance_score).toBeCloseTo(sigmoid(3.5))
    expect(answer.results[2]?.relevance_score).toBeCloseTo(sigmoid(-2))
    expect(gw.providers.beta.requests[0]).toMatchObject({
      path: '/ai/run/@beta/rerank-model',
      headers: { authorization: 'Bearer beta-key' },
      body: { query: 'my bag arrived torn', contexts: documents.map(text => ({ text })), top_k: 3 },
    })
  })

  it('returns only the best top_n documents', async () => {
    gw.providers.beta.enqueue({ kind: 'json', body: reranked([[0, 1], [1, 2], [2, 3]]) })

    const response = await rerank({ top_n: 2 })

    expect(response.json<{ results: { index: number }[] }>().results.map(result => result.index)).toEqual([2, 1])
    // The provider still scores every document, so the answer can be checked in full.
    expect(gw.providers.beta.requests[0]?.body).toMatchObject({ top_k: 3 })
  })

  it('refuses a document too long to read with the query, before calling anyone', async () => {
    const response = await rerank({ documents: ['short', 'x'.repeat(2_000)] })

    expect(response.statusCode).toBe(413)
    expect(response.json()).toMatchObject({ error: { code: 'input_too_large', message: expect.stringContaining('Document 1') } })
    expect(gw.providers.beta.requests).toHaveLength(0)
  })

  it('fails rather than trust an answer that skips or repeats a document', async () => {
    gw.providers.beta.enqueue({ kind: 'json', body: reranked([[0, 1], [0, 2], [1, 3]]) })

    const repeated = await rerank()

    expect(repeated.statusCode).toBe(502)
    expect(repeated.json()).toMatchObject({ error: { code: 'upstream_failed' } })
  })

  it('fails on Cloudflare\'s failure envelope, even with a 200 status', async () => {
    gw.providers.beta.enqueue({ kind: 'json', body: { success: false, errors: [{ code: 5006, message: 'model busy' }], result: null } })

    expect((await rerank()).statusCode).toBe(502)
  })

  it('passes Cloudflare\'s reason back when it refuses the request itself', async () => {
    gw.providers.beta.enqueue({ kind: 'json', status: 400, body: { success: false, errors: [{ code: 5006, message: 'contexts must not be empty' }] } })

    const response = await rerank()

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'upstream_rejected', message: expect.stringContaining('contexts must not be empty') } })
  })

  it('counts against the run like any model call, and records the document count', async () => {
    gw.providers.beta.enqueue({ kind: 'json', body: reranked([[0, 1], [1, 2], [2, 3]]) })
    const runId = 'run-rerank-0001'

    await rerank({}, { 'x-lb-run-id': runId })

    const call = (await gw.runSpans(runId)).find(span => span.kind === 'gateway.call')
    expect(call).toMatchObject({ name: 'lb-rerank', status: 'ok', attrs: { documents: 3, usage: 'estimated', model: 'beta/rerank' } })
  })

  it('refuses a rerank alias on the chat route, and a chat alias here', async () => {
    const chatHere = await rerank({ model: 'lb-fast' })
    const rerankThere = await gw.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: await gw.headers(),
      payload: { model: 'lb-rerank', messages: [{ role: 'user', content: 'hi' }] },
    })

    expect(chatHere.statusCode).toBe(404)
    expect(chatHere.json()).toMatchObject({ error: { message: expect.stringContaining('no rerank model called lb-fast') } })
    expect(rerankThere.statusCode).toBe(404)
  })
})
