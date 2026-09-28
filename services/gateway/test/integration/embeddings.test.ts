import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { embeddings } from '../support/fake-provider.ts'
import { startGateway } from '../support/gateway.ts'
import type { TestGateway } from '../support/gateway.ts'

let gw: TestGateway

beforeEach(async () => {
  gw = await startGateway()
})

afterEach(async () => {
  await gw.close()
})

async function embed(input: string | string[]) {
  return gw.app.inject({ method: 'POST', url: '/v1/embeddings', headers: await gw.headers(), payload: { model: 'lb-embed', input, dimensions: 256 } })
}

describe('embeddings', () => {
  it('returns one vector per input from the pinned model', async () => {
    gw.providers.beta.enqueue({ kind: 'json', body: embeddings(2) })

    const response = await embed(['torn bag', 'late delivery'])

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(embeddings(2))
    expect(response.headers['x-lb-model']).toBe('beta/embed')
    expect(gw.providers.beta.requests[0]).toMatchObject({ path: '/v1/embeddings', body: { model: '@beta/embed-model', input: ['torn bag', 'late delivery'] } })
    expect(gw.providers.beta.requests[0]?.body).not.toHaveProperty('dimensions')
  })

  it('has no fallback, since vectors from another model would not match the index', async () => {
    gw.providers.beta.enqueue({ kind: 'json', status: 500, body: {} })

    const response = await embed('torn bag')

    expect(response.statusCode).toBe(502)
    expect(gw.providers.beta.requests).toHaveLength(1)
  })

  it('rejects a response that doesn\'t pair every input with a vector', async () => {
    gw.providers.beta.enqueue({ kind: 'json', body: embeddings(1) })

    const response = await embed(['torn bag', 'late delivery'])

    expect(response.statusCode).toBe(502)
  })
})
