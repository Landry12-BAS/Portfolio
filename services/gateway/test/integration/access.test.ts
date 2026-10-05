// Integration tests: who may call the gateway, for which system, with which alias,
// and how malformed calls are answered.
import { generateKeyPair, SignJWT } from 'jose'
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

/** Sends a chat call with LB-01's default headers, some overridden or removed. */
async function chatWith(headers: Record<string, string | undefined>, body = chatBody()) {
  return gw.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: await gw.headers(headers), payload: body })
}

describe('service tokens', () => {
  it('refuses calls without a token', async () => {
    const response = await chatWith({ authorization: undefined })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: { message: expect.any(String), type: 'authentication_error', code: 'invalid_service_token' } })
    expect(gw.providers.alpha.requests).toHaveLength(0)
  })

  it('refuses a token signed by a key the gateway doesn\'t know', async () => {
    const stranger = await generateKeyPair('EdDSA', { crv: 'Ed25519' })
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'EdDSA', kid: 'django-systems' })
      .setIssuer('django-systems')
      .setAudience('lb-gateway')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(stranger.privateKey)

    expect((await chatWith({ authorization: `Bearer ${token}` })).statusCode).toBe(401)
  })

  it('refuses an expired token', async () => {
    const token = await gw.token()
    gw.advance(11 * 60_000)

    expect((await chatWith({ authorization: `Bearer ${token}` })).statusCode).toBe(401)
  })

  it('leaves health checks open, for the container runtime', async () => {
    const response = await gw.app.inject({ method: 'GET', url: '/healthz' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
  })
})

describe('systems and aliases', () => {
  it('lets a service call only for its own systems', async () => {
    const response = await chatWith({ 'authorization': `Bearer ${await gw.token('flask-systems')}`, 'x-lb-system': 'lb-01' })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'system_not_allowed', type: 'permission_error' } })
  })

  it('lets a system use only its own aliases', async () => {
    const response = await chatWith({ 'authorization': `Bearer ${await gw.token('flask-systems')}`, 'x-lb-system': 'lb-05' }, chatBody({ model: 'lb-tools' }))

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'alias_not_allowed' } })
  })

  it('answers unknown models the way OpenAI does', async () => {
    const response = await chatWith({}, chatBody({ model: 'gpt-4o' }))

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: { code: 'model_not_found', type: 'not_found_error' } })
  })

  it('keeps chat and embedding aliases apart', async () => {
    const response = await chatWith({}, chatBody({ model: 'lb-embed' }))

    expect(response.statusCode).toBe(404)
  })

  it('lists the aliases a service may use', async () => {
    const response = await gw.app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${await gw.token('flask-systems')}` } })

    expect(response.json()).toEqual({
      object: 'list',
      data: [
        { id: 'lb-eval-alpha', object: 'model', created: 0, owned_by: 'lb-gateway', kind: 'chat', description: 'Eval Lab, pinned to the first provider' },
        { id: 'lb-eval-gamma', object: 'model', created: 0, owned_by: 'lb-gateway', kind: 'chat', description: 'Eval Lab, pinned to the provider that trains' },
        { id: 'lb-fast', object: 'model', created: 0, owned_by: 'lb-gateway', kind: 'chat', description: 'Classification' },
      ],
    })
  })
})

describe('call headers and bodies', () => {
  it('needs a system and a run ID', async () => {
    const response = await chatWith({ 'x-lb-run-id': 'short' })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'invalid_request', message: expect.stringContaining('x-lb-run-id') } })
  })

  it('answers malformed JSON in the OpenAI error format', async () => {
    const response = await gw.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { ...(await gw.headers()), 'content-type': 'application/json' },
      payload: '{"model": ',
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'invalid_request', type: 'invalid_request_error' } })
  })

  it('answers unknown routes with a JSON 404', async () => {
    const response = await gw.app.inject({ method: 'GET', url: '/v1/completions?x=1', headers: { authorization: `Bearer ${await gw.token()}` } })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } })
  })
})
