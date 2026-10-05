// Integration tests for Eval Lab's pinned aliases: one model and no fallback, for the
// flask-systems service and LB-10 only, with the provider that trains on inputs kept away from
// every visitor's content. They run on the test routing file's fake providers.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { completion } from '../support/fake-provider.ts'
import { chatBody, startGateway } from '../support/gateway.ts'
import type { TestGateway } from '../support/gateway.ts'

let gw: TestGateway

beforeEach(async () => {
  gw = await startGateway()
})

afterEach(async () => {
  await gw.close()
})

/** Sends a chat call for an alias as LB-10 (the flask-systems service), with some headers overridden. */
async function asLab(alias: string, overrides: Record<string, string | undefined> = {}) {
  const headers = await gw.headers({ 'authorization': `Bearer ${await gw.token('flask-systems')}`, 'x-lb-system': 'lb-10', ...overrides })
  return gw.app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: chatBody({ model: alias }) })
}

describe('a pinned alias', () => {
  it('is served by its one model, for LB-10', async () => {
    const response = await asLab('lb-eval-alpha')

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(completion('alpha answer'))
    expect(response.headers['x-lb-model']).toBe('alpha/small')
    expect(response.headers['x-lb-attempts']).toBe('1')
  })

  it('never falls back: when its model fails, the call fails and no other model is asked', async () => {
    gw.providers.alpha.enqueue({ kind: 'json', status: 503, body: { error: { message: 'overloaded' } } })

    const response = await asLab('lb-eval-alpha')

    expect(response.statusCode).toBe(502)
    expect(response.json()).toMatchObject({ error: { code: 'upstream_failed' } })
    expect(gw.providers.beta.requests).toHaveLength(0)
    expect(gw.providers.gamma.requests).toHaveLength(0)
  })

  it('is refused to LB-05, the other system of the same service', async () => {
    const response = await asLab('lb-eval-alpha', { 'x-lb-system': 'lb-05' })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'alias_not_allowed' } })
    expect(gw.providers.alpha.requests).toHaveLength(0)
  })

  it('is refused to another service, whichever system it names', async () => {
    const asDjango = async (system: string) => gw.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: await gw.headers({ 'x-lb-system': system }),
      payload: chatBody({ model: 'lb-eval-alpha' }),
    })

    const itsOwnSystem = await asDjango('lb-01')
    expect(itsOwnSystem.statusCode).toBe(403)
    expect(itsOwnSystem.json()).toMatchObject({ error: { code: 'alias_not_allowed' } })

    const labsSystem = await asDjango('lb-10')
    expect(labsSystem.statusCode).toBe(403)
    expect(labsSystem.json()).toMatchObject({ error: { code: 'system_not_allowed' } })
    expect(gw.providers.alpha.requests).toHaveLength(0)
  })
})

describe('a pinned alias on the provider that trains on inputs', () => {
  it('serves synthetic content, which is what the nightly runs and CI send', async () => {
    const response = await asLab('lb-eval-gamma', { 'x-lb-data-class': 'synthetic', 'x-lb-session': undefined })

    expect(response.statusCode).toBe(200)
    expect(response.headers['x-lb-model']).toBe('gamma/big')
    expect(gw.providers.gamma.requests).toHaveLength(1)
  })

  it('refuses a visitor\'s content before any provider is asked, with or without a label', async () => {
    const asVisitor = await asLab('lb-eval-gamma', { 'x-lb-data-class': 'visitor' })
    expect(asVisitor.statusCode).toBe(400)
    expect(asVisitor.json()).toMatchObject({ error: { code: 'unsupported_request' } })

    // Unlabelled content is a visitor's: the stricter routing is the default.
    const unlabelled = await asLab('lb-eval-gamma', { 'x-lb-data-class': undefined })
    expect(unlabelled.statusCode).toBe(400)

    expect(gw.providers.gamma.requests).toHaveLength(0)
  })

  it('costs nothing: the refusal comes before the call is counted, and leaves no span', async () => {
    const runId = 'run-visitor-gamma-0001'
    // The run's cap is four calls: five refusals in a row would use it up if they were counted.
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await asLab('lb-eval-gamma', { 'x-lb-run-id': runId, 'x-lb-data-class': 'visitor' })
      expect(response.statusCode).toBe(400)
    }

    expect(await gw.runSpans(runId)).toEqual([])
    const afterwards = await asLab('lb-eval-alpha', { 'x-lb-run-id': runId, 'x-lb-data-class': 'visitor' })
    expect(afterwards.statusCode).toBe(200)
  })
})
