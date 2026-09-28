import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { chatBody, startGateway } from '../support/gateway.ts'
import type { TestGateway } from '../support/gateway.ts'

let gw: TestGateway

beforeEach(async () => {
  gw = await startGateway()
})

afterEach(async () => {
  await gw.close()
})

async function chat(body: Record<string, unknown>, headers: Record<string, string | undefined> = {}) {
  return gw.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: await gw.headers(headers), payload: body })
}

interface UsageMeter {
  scope: string
  unit: string
  window: string
  used: number
  limit: number
  ceiling: number
  share: number
  alert: boolean
}

async function usage(): Promise<UsageMeter[]> {
  const response = await gw.app.inject({ method: 'GET', url: '/v1/usage', headers: { authorization: `Bearer ${await gw.token()}` } })
  return response.json<{ meters: UsageMeter[] }>().meters
}

function msUntilUtcMidnight(now: number): number {
  return 86_400_000 - (now % 86_400_000)
}

describe('provider budgets', () => {
  it('answers budget_exhausted with Retry-After once every model is spent, and charges the visitor nothing', async () => {
    expect((await chat(chatBody({ model: 'lb-tiny' }))).statusCode).toBe(200)

    const spent = await chat(chatBody({ model: 'lb-tiny' }))

    expect(spent.statusCode).toBe(503)
    expect(spent.json()).toMatchObject({ error: { code: 'budget_exhausted', message: expect.stringContaining('Serve a replay') } })
    const retryAfter = Number(spent.headers['retry-after'])
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(Math.ceil(msUntilUtcMidnight(gw.now()) / 1000))
    expect(gw.providers.alpha.requests).toHaveLength(1)
    // Only the call that reached a provider counts against the visitor.
    const session = (await usage()).find(meter => meter.scope === 'system:lb-01')
    expect(session?.used).toBe(1)
  })

  it('opens a new day at 00:00 UTC', async () => {
    await chat(chatBody({ model: 'lb-tiny' }))
    expect((await chat(chatBody({ model: 'lb-tiny' }))).statusCode).toBe(503)

    gw.advance(msUntilUtcMidnight(gw.now()) + 1_000)

    expect((await chat(chatBody({ model: 'lb-tiny' }))).statusCode).toBe(200)
  })

  it('meters Neurons against the provider\'s shared daily pool, then settles them with real usage', async () => {
    gw.providers.alpha.setDefault({ kind: 'json', status: 500, body: {} })

    const response = await chat(chatBody())

    expect(response.headers['x-lb-model']).toBe('beta/small')
    // The fake reports 20 prompt and 8 completion tokens: 20 x 10 + 8 x 20 per 1,000.
    const neurons = (await usage()).find(meter => meter.scope === 'provider:beta' && meter.unit === 'neurons')
    expect(neurons).toMatchObject({ window: 'day', used: 0.36, limit: 10_000, ceiling: 9_500 })
  })

  it('refunds the reservation of an attempt the provider refused', async () => {
    gw.providers.alpha.enqueue({ kind: 'json', status: 429, headers: { 'retry-after': '5' }, body: {} })

    await chat(chatBody())

    const alphaTokens = (await usage()).find(meter => meter.scope === 'model:alpha/small' && meter.unit === 'tokens' && meter.window === 'day')
    const alphaRequests = (await usage()).find(meter => meter.scope === 'model:alpha/small' && meter.unit === 'requests' && meter.window === 'day')
    expect(alphaTokens?.used).toBe(0)
    expect(alphaRequests?.used).toBe(1)
  })

  it('flags daily budgets past the alert share', async () => {
    await chat(chatBody({ model: 'lb-tiny' }))

    const tiny = (await usage()).find(meter => meter.scope === 'model:alpha/tiny')
    expect(tiny).toMatchObject({ used: 1, limit: 2, share: 0.5, alert: false })
  })
})

describe('quotas', () => {
  it('caps the model calls in one run', async () => {
    const run = { 'x-lb-run-id': 'run-capped-0001' }
    for (let call = 0; call < 4; call += 1) expect((await chat(chatBody(), run)).statusCode).toBe(200)

    const capped = await chat(chatBody(), run)

    expect(capped.statusCode).toBe(429)
    expect(capped.json()).toMatchObject({ error: { code: 'quota_exceeded', type: 'rate_limit_error', message: expect.stringContaining('run') } })
    expect(capped.headers['retry-after']).toBeUndefined()
    expect(gw.providers.alpha.requests).toHaveLength(4)
  })

  it('caps each visitor\'s calls per day, across runs', async () => {
    for (let call = 0; call < 6; call += 1) expect((await chat(chatBody())).statusCode).toBe(200)

    const capped = await chat(chatBody())

    expect(capped.statusCode).toBe(429)
    expect(capped.json()).toMatchObject({ error: { message: expect.stringContaining('session') } })
    expect(Number(capped.headers['retry-after'])).toBeGreaterThan(0)
    // Another visitor is unaffected.
    expect((await chat(chatBody(), { 'x-lb-session': 'session-fedcba9876543210' })).statusCode).toBe(200)
  })
})

describe('when Redis is down', () => {
  it('fails closed instead of spending unmetered quota', async () => {
    await gw.close()
    gw = await startGateway({ redisUrl: 'redis://127.0.0.1:1' })

    const response = await chat(chatBody())
    const ready = await gw.app.inject({ method: 'GET', url: '/readyz' })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: { code: 'gateway_unavailable' } })
    expect(gw.providers.alpha.requests).toHaveLength(0)
    expect(ready.statusCode).toBe(503)
    expect(ready.json()).toMatchObject({ status: 'unavailable', redis: false })
  })

  it('reports ready when Redis answers and a provider is configured', async () => {
    const ready = await gw.app.inject({ method: 'GET', url: '/readyz' })

    expect(ready.json()).toEqual({ status: 'ready', redis: true, providers: ['alpha', 'beta', 'gamma'] })
  })
})
