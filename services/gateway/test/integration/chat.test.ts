// Integration tests for chat completions: serving, fallback, streaming, the data-class
// and terms rules, capability routing and the spans a call leaves behind.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { chunk, completion } from '../support/fake-provider.ts'
import { chatBody, sseEvents, startGateway } from '../support/gateway.ts'
import type { TestGateway } from '../support/gateway.ts'

let gw: TestGateway

beforeEach(async () => {
  gw = await startGateway()
})

afterEach(async () => {
  await gw.close()
})

/** Sends a chat call with LB-01's default headers, some overridden or removed. */
async function chat(body: Record<string, unknown>, overrides: Record<string, string | undefined> = {}) {
  return gw.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: await gw.headers(overrides), payload: body })
}

describe('a call that succeeds', () => {
  it('is served by the first model on the chain, as that provider answered', async () => {
    const response = await chat(chatBody({ reasoning_effort: 'low', user: 'visitor-42', n: 3, logit_bias: { 50256: -100 } }))

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(completion('alpha answer'))
    expect(response.headers['x-lb-provider']).toBe('alpha')
    expect(response.headers['x-lb-model']).toBe('alpha/small')
    expect(response.headers['x-lb-attempts']).toBe('1')
    expect(response.headers['cache-control']).toBe('no-store')

    const [sent] = gw.providers.alpha.requests
    expect(sent?.path).toBe('/v1/chat/completions')
    expect(sent?.headers.authorization).toBe('Bearer alpha-key')
    expect(sent?.body).toEqual({
      model: 'alpha/small-model',
      messages: chatBody().messages,
      max_completion_tokens: 512,
      reasoning_effort: 'low',
    })
  })

  it('drops options the model cannot take and uses the provider\'s name for the token cap', async () => {
    gw.providers.alpha.enqueue({ kind: 'json', status: 503, body: { error: { message: 'overloaded' } } })
    const response = await chat(chatBody({ reasoning_effort: 'high', max_tokens: 100 }))

    expect(response.statusCode).toBe(200)
    expect(response.headers['x-lb-model']).toBe('beta/small')
    const [sent] = gw.providers.beta.requests
    expect(sent?.body).toMatchObject({ model: '@beta/small-model', max_tokens: 100 })
    expect(sent?.body).not.toHaveProperty('reasoning_effort')
    expect(sent?.body).not.toHaveProperty('max_completion_tokens')
  })
})

describe('fallback', () => {
  it('moves to the next model on a 429 and lets the first one cool down', async () => {
    gw.providers.alpha.enqueue({ kind: 'json', status: 429, headers: { 'retry-after': '30' }, body: { error: { message: 'rate limited' } } })

    const first = await chat(chatBody())
    expect(first.statusCode).toBe(200)
    expect(first.headers['x-lb-model']).toBe('beta/small')
    expect(first.headers['x-lb-attempts']).toBe('2')

    // Within the Retry-After window the cooling model is skipped without a request.
    const runId = 'run-cooling-0001'
    const second = await chat(chatBody(), { 'x-lb-run-id': runId })
    expect(second.headers['x-lb-model']).toBe('beta/small')
    expect(second.headers['x-lb-attempts']).toBe('1')
    expect(gw.providers.alpha.requests).toHaveLength(1)
    const skipped = (await gw.runSpans(runId)).find(span => span.attrs.model === 'alpha/small')
    expect(skipped).toMatchObject({ status: 'skipped', attrs: { outcome: 'breaker_open' } })
  })

  it('moves to the next model when the first token is late', async () => {
    gw.providers.alpha.enqueue({ kind: 'stream', delayMs: 700, steps: [chunk('too late'), '[DONE]'] })
    gw.providers.beta.enqueue({ kind: 'stream', steps: [chunk('beta '), chunk('streams'), '[DONE]'] })

    const response = await chat(chatBody({ stream: true }))

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')
    expect(response.headers['x-lb-model']).toBe('beta/small')
    expect(sseEvents(response.body)).toEqual([chunk('beta '), chunk('streams'), '[DONE]'])
    expect(gw.providers.beta.requests[0]?.body).toMatchObject({ stream: true, stream_options: { include_usage: true } })
  })

  it('never switches provider once the answer is streaming', async () => {
    // The pause lets the first chunk reach the gateway before the connection drops.
    gw.providers.alpha.enqueue({ kind: 'stream', steps: [chunk('Your order'), { pauseMs: 50 }], end: 'drop' })

    const response = await chat(chatBody({ stream: true }))

    const events = sseEvents(response.body)
    expect(events[0]).toBe(chunk('Your order'))
    expect(JSON.parse(events.at(-1) ?? '{}')).toMatchObject({ error: { code: 'upstream_failed' } })
    expect(events).not.toContain('[DONE]')
    expect(gw.providers.beta.requests).toHaveLength(0)
  })

  it('moves to the next model when a provider refuses the request, since providers take different shapes', async () => {
    gw.providers.alpha.enqueue({ kind: 'json', status: 400, body: { error: { message: 'Failed to parse tool call arguments as JSON' } } })

    const response = await chat(chatBody())

    expect(response.statusCode).toBe(200)
    expect(response.headers['x-lb-model']).toBe('beta/small')
    expect(gw.providers.beta.requests).toHaveLength(1)
  })

  it('passes the last refusal back when every model tried refuses the request', async () => {
    gw.providers.alpha.enqueue({ kind: 'json', status: 400, body: { error: { message: 'response_format schema is not supported' } } })
    gw.providers.beta.enqueue({ kind: 'json', status: 422, body: { error: { message: 'schema is not supported here either' } } })

    const response = await chat(chatBody())

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'upstream_rejected', message: expect.stringContaining('schema is not supported here either') } })
  })
})

describe('data class and terms', () => {
  /** Makes the two providers that never train on inputs fail every call. */
  function failEverywhereButGammaAndDelta() {
    gw.providers.alpha.setDefault({ kind: 'json', status: 500, body: { error: { message: 'down' } } })
    gw.providers.beta.setDefault({ kind: 'json', status: 500, body: { error: { message: 'down' } } })
  }

  it('never sends visitor content to a provider that may train on it', async () => {
    failEverywhereButGammaAndDelta()
    const runId = 'run-visitor-0001'

    const response = await chat(chatBody({ model: 'lb-tools' }), { 'x-lb-run-id': runId })

    expect(response.statusCode).toBe(502)
    expect(response.json()).toMatchObject({ error: { code: 'upstream_failed' } })
    expect(gw.providers.gamma.requests).toHaveLength(0)
    expect(gw.providers.delta.requests).toHaveLength(0)
    const outcomes = Object.fromEntries((await gw.runSpans(runId))
      .filter(span => span.kind === 'gateway.attempt')
      .map(span => [span.attrs.model, span.attrs.outcome]))
    expect(outcomes).toEqual({ 'alpha/big': 'server_error', 'beta/big': 'server_error', 'gamma/big': 'visitor-data', 'delta/big': 'terms' })
  })

  it('lets synthetic samples use the whole production chain', async () => {
    failEverywhereButGammaAndDelta()

    const response = await chat(chatBody({ model: 'lb-tools' }), { 'x-lb-data-class': 'synthetic', 'x-lb-session': undefined })

    expect(response.statusCode).toBe(200)
    expect(response.headers['x-lb-model']).toBe('gamma/big')
    expect(gw.providers.gamma.requests[0]?.headers['x-title']).toBe('LB tests')
    expect(gw.providers.delta.requests).toHaveLength(0)
  })

  it('reaches dev-only providers in the dev profile, with synthetic data only', async () => {
    await gw.close()
    gw = await startGateway({ profile: 'dev' })
    failEverywhereButGammaAndDelta()
    gw.providers.gamma.setDefault({ kind: 'json', status: 500, body: { error: { message: 'down' } } })

    const synthetic = await chat(chatBody({ model: 'lb-tools' }), { 'x-lb-data-class': 'synthetic' })
    expect(synthetic.headers['x-lb-model']).toBe('delta/big')

    const visitor = await chat(chatBody({ model: 'lb-tools' }))
    expect(visitor.statusCode).toBe(502)
    expect(gw.providers.delta.requests).toHaveLength(1)
  })

  it('treats unlabelled content as visitor content', async () => {
    const response = await chat(chatBody(), { 'x-lb-session': undefined })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'invalid_request', message: expect.stringContaining('x-lb-session') } })
  })
})

describe('what a request needs', () => {
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }

  it('sends images only to models that can see', async () => {
    const vision = await chat(chatBody({ model: 'lb-vision', messages: [{ role: 'user', content: [{ type: 'text', text: 'Read this receipt.' }, image] }] }))
    expect(vision.statusCode).toBe(200)
    expect(vision.headers['x-lb-model']).toBe('beta/vision')

    const tools = await chat(chatBody({ model: 'lb-tools', messages: [{ role: 'user', content: [image] }] }))
    expect(tools.statusCode).toBe(400)
    expect(tools.json()).toMatchObject({ error: { code: 'unsupported_request' } })
  })

  it('refuses images by URL, which would make the provider fetch a page', async () => {
    const response = await chat(chatBody({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/receipt.png' } }] }] }))

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'invalid_request', message: expect.stringContaining('data URL') } })
  })

  it('skips models without structured output when a JSON schema is required', async () => {
    const response = await chat(chatBody({
      model: 'lb-fast',
      response_format: { type: 'json_schema', json_schema: { name: 'triage', schema: { type: 'object' } } },
    }))

    expect(response.headers['x-lb-model']).toBe('alpha/small')
    gw.providers.alpha.setDefault({ kind: 'json', status: 500, body: {} })
    const fallback = await chat(chatBody({
      model: 'lb-fast',
      response_format: { type: 'json_schema', json_schema: { name: 'triage', schema: { type: 'object' } } },
    }))
    expect(fallback.statusCode).toBe(502)
    expect(gw.providers.beta.requests).toHaveLength(0)
  })

  it('refuses prompts bigger than the alias allows before spending anything', async () => {
    const response = await chat(chatBody({ messages: [{ role: 'user', content: 'x'.repeat(20_000) }] }))

    expect(response.statusCode).toBe(413)
    expect(response.json()).toMatchObject({ error: { code: 'input_too_large' } })
    expect(gw.providers.alpha.requests).toHaveLength(0)
  })

  it('refuses a token cap above the alias limit', async () => {
    const response = await chat(chatBody({ max_tokens: 4096 }))

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { message: expect.stringContaining('lb-fast\'s limit of 512') } })
  })
})

describe('streams', () => {
  it('copies Groq-style streaming usage into the standard field and settles the budget with it', async () => {
    const final = chunk('', { choices: [], x_groq: { id: 'req_1', usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } } })
    gw.providers.alpha.enqueue({ kind: 'stream', steps: [{ comment: 'keep-alive' }, chunk('Hello'), final, '[DONE]'] })

    const response = await chat(chatBody({ stream: true }))

    const events = sseEvents(response.body)
    expect(events).toHaveLength(3)
    expect(JSON.parse(events[1] ?? '{}')).toMatchObject({ usage: { prompt_tokens: 100, completion_tokens: 40 } })
    const usage = await gw.app.inject({ method: 'GET', url: '/v1/usage', headers: { authorization: `Bearer ${await gw.token()}` } })
    const tokens = usage.json<{ meters: { scope: string, unit: string, window: string, used: number }[] }>().meters
      .find(meter => meter.scope === 'model:alpha/small' && meter.unit === 'tokens' && meter.window === 'minute')
    expect(tokens?.used).toBe(140)
  })

  it('relays a provider\'s mid-stream error and stops', async () => {
    const failure = JSON.stringify({ id: 'gen-1', error: { code: 'server_error', message: 'Provider disconnected' }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] })
    gw.providers.alpha.enqueue({ kind: 'stream', steps: [chunk('Your'), failure, chunk('never sent'), '[DONE]'] })

    const response = await chat(chatBody({ stream: true }))

    expect(sseEvents(response.body)).toEqual([chunk('Your'), failure])
  })

  it('falls back when a stream opens with an error', async () => {
    gw.providers.alpha.enqueue({ kind: 'stream', steps: [JSON.stringify({ error: { message: 'no capacity' } })] })
    gw.providers.beta.enqueue({ kind: 'stream', steps: [chunk('beta'), '[DONE]'] })

    const response = await chat(chatBody({ stream: true }))

    expect(response.headers['x-lb-model']).toBe('beta/small')
    expect(sseEvents(response.body)).toEqual([chunk('beta'), '[DONE]'])
  })

  it('ends a stream that goes quiet with an error event', async () => {
    gw.providers.alpha.enqueue({ kind: 'stream', steps: [chunk('Your order')], end: 'hang' })

    const response = await chat(chatBody({ stream: true }))

    const events = sseEvents(response.body)
    expect(events[0]).toBe(chunk('Your order'))
    expect(JSON.parse(events[1] ?? '{}')).toMatchObject({ error: { code: 'upstream_failed' } })
    expect(gw.providers.beta.requests).toHaveLength(0)
  })
})

describe('spans', () => {
  it('records the call and every attempt under the run, without any prompt text', async () => {
    gw.providers.alpha.enqueue({ kind: 'json', status: 502, body: {} })
    const runId = 'run-spans-00001'

    await chat(chatBody(), { 'x-lb-run-id': runId, 'x-lb-parent-span': '0123456789abcdef' })

    const spans = await gw.runSpans(runId)
    const call = spans.find(span => span.kind === 'gateway.call')
    expect(call).toMatchObject({
      runId, system: 'lb-01', name: 'lb-fast', status: 'ok', parentId: '0123456789abcdef',
      attrs: { alias: 'lb-fast', dataClass: 'visitor', attempts: 2, model: 'beta/small', inputTokens: 20, outputTokens: 8, usage: 'reported' },
    })
    expect(spans.filter(span => span.kind === 'gateway.attempt').map(span => [span.attrs.model, span.status, span.attrs.outcome, span.parentId]))
      .toEqual([['alpha/small', 'error', 'server_error', call?.spanId], ['beta/small', 'ok', 'ok', call?.spanId]])
    expect(JSON.stringify(spans)).not.toContain('Basalt Blend')
  })
})
