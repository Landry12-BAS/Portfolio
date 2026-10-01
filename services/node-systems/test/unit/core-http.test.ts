// Tests for what every HTTP answer of the Node systems carries: the security headers, JSON
// bodies in the platform's error shape, visitor authentication and the health checks. The
// systems are faked, so nothing here needs a database, a queue or a model.
import { createVisitorVerifier } from '@lb/common'
import { makeSiteKeys, mintVisitorToken } from '@lb/common/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../src/core/app.ts'
import { SECURITY_HEADERS } from '../../src/core/security-headers.ts'
import { bodyTextIsSafe, isSafeText } from '../../src/core/text-guard.ts'
import { fakeModule } from '../support/fake-module.ts'

const site = makeSiteKeys()
const NOW = Math.floor(Date.now() / 1000)
const token = mintVisitorToken(site.privateKey, { iss: 'lb-web', aud: 'lb-99', sub: 'session-0123456789abcdef', iat: NOW, exp: NOW + 300 })
const authorised = { authorization: `Bearer ${token}` }

let app: FastifyInstance
let ready = true

beforeAll(async () => {
  app = await buildApp({ modules: [fakeModule(createVisitorVerifier('lb-99', site.encodedPublicKey), async () => ready)] })
})

afterAll(async () => {
  await app.close()
})

describe('every answer', () => {
  it.each([
    ['GET', '/api/healthz', 200],
    ['GET', '/api/openapi.json', 200],
    ['GET', '/api/lb99/whoami', 401],
    ['GET', '/nowhere', 404],
    ['POST', '/api/healthz', 404],
  ])('carries the security headers: %s %s (%i)', async (method, url, status) => {
    const response = await app.inject({ method: method as 'GET', url })

    expect(response.statusCode).toBe(status)
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(response.headers[name], name).toBe(value)
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('allows no content, no framing and no caching', async () => {
    const { headers } = await app.inject({ url: '/api/healthz' })

    expect(headers['content-security-policy']).toBe('default-src \'none\'; frame-ancestors \'none\'')
    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['cache-control']).toBe('no-store')
    expect(headers['x-content-type-options']).toBe('nosniff')
  })
})

describe('errors', () => {
  it('answer an unknown path with a JSON 404 that does not repeat it', async () => {
    const response = await app.inject({ url: '/api/nowhere/<script>alert(1)</script>' })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: { code: 'not_found', message: 'There is nothing at this address.' } })
    expect(response.body).not.toContain('script')
  })

  it('answer a malformed request with 422 naming the fields at fault, and never their values', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/lb99/echo', headers: authorised, payload: { text: 'x'.repeat(21), extra: 'secret-marker' } })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toEqual({ error: { code: 'invalid_request', message: 'The request doesn\'t have the expected form.', fields: 'body, body.text' } })
    expect(response.body).not.toContain('secret-marker')
  })

  it('answer a body that is not JSON with 400, a body that is too large with 413 and the wrong media type with 415', async () => {
    const notJson = await app.inject({ method: 'POST', url: '/api/lb99/echo', headers: { ...authorised, 'content-type': 'application/json' }, payload: '{"text": ' })
    const tooLarge = await app.inject({ method: 'POST', url: '/api/lb99/echo', headers: { ...authorised, 'content-type': 'application/json' }, payload: JSON.stringify({ text: 'x'.repeat(300_000) }) })
    const wrongType = await app.inject({ method: 'POST', url: '/api/lb99/echo', headers: { ...authorised, 'content-type': 'application/xml' }, payload: '<text>hello</text>' })

    expect(notJson.json().error.code).toBe('invalid_json')
    expect(tooLarge.statusCode).toBe(413)
    expect(tooLarge.json().error.code).toBe('payload_too_large')
    expect(wrongType.statusCode).toBe(415)
    expect(wrongType.json().error.code).toBe('unsupported_media_type')
  })

  it('answer an error the service raised on purpose with its own code, and a Retry-After when it has one', async () => {
    const response = await app.inject({ url: '/api/lb99/limit', headers: authorised })

    expect(response.statusCode).toBe(429)
    expect(response.json()).toEqual({ error: { code: 'daily_limit', message: 'A visitor may do this 10 times a day.' } })
    expect(response.headers['retry-after']).toBe('90')
  })

  it('answer an unexpected failure with a generic 500 that reveals nothing', async () => {
    const response = await app.inject({ url: '/api/lb99/crash', headers: authorised })

    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({ error: { code: 'internal_error', message: 'The service hit an internal error.' } })
    expect(response.body).not.toContain('private')
  })

  it('never send a field the response schema does not list', async () => {
    const response = await app.inject({ url: '/api/lb99/leaky', headers: authorised })

    expect(response.statusCode).toBe(500)
    expect(response.body).not.toContain('must not be sent')
  })
})

describe('the check on request text', () => {
  it('lets ordinary text through: accents, emoji, tabs and line breaks', () => {
    for (const text of ['Café Lumen', 'Velkoobchodní objednávka nad 500 €', 'two\nlines\tand a tab', 'a coffee \u{2615} and a pair \u{1F600}']) expect(isSafeText(text), text).toBe(true)
  })

  it.each([
    ['a NUL character, which Postgres cannot store', 'a\u0000b'],
    ['an escape character', 'a\u001Bb'],
    ['a delete character', 'a\u007Fb'],
    ['a C1 control character', 'a\u0085b'],
    ['a right-to-left override', 'a\u202Eb'],
    ['a bidirectional isolate', 'a\u2066b'],
    ['half of an emoji', 'a\uD83Db'],
  ])('refuses text with %s', (_name, text) => {
    expect(isSafeText(text)).toBe(false)
  })

  it('checks every string and every key, however deep they sit', () => {
    expect(bodyTextIsSafe({ a: [{ b: 'fine' }] })).toBe(true)
    expect(bodyTextIsSafe({ a: [{ b: 'bad\u0000' }] })).toBe(false)
    expect(bodyTextIsSafe({ 'bad\u0000key': 'fine' })).toBe(false)
    expect(bodyTextIsSafe(['x', 'y', 'z\u202E'])).toBe(false)
  })

  it('gives up on a body deeper or wider than any honest request, without recursing', () => {
    let deep: unknown = 'leaf'
    for (let level = 0; level < 100_000; level += 1) deep = [deep]
    const wide = Array.from({ length: 6_000 }, () => 'x')

    expect(bodyTextIsSafe(deep)).toBe(false)
    expect(bodyTextIsSafe(wide)).toBe(false)
  })

  it('answers a body with unsafe text with 422 before any route validates it, and never repeats the text', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/lb99/echo', headers: { ...authorised, 'content-type': 'application/json' }, payload: '{"text": "a\\u0000b"}' })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toEqual({ error: { code: 'invalid_request', message: 'Text can\'t hold control characters or unpaired surrogates.' } })
  })

  it('refuses a lone surrogate sent as an escape in the JSON', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/lb99/echo', headers: { ...authorised, 'content-type': 'application/json' }, payload: '{"text": "\\ud83d"}' })

    expect(response.statusCode).toBe(422)
    expect(response.json().error.code).toBe('invalid_request')
  })
})

describe('visitor authentication', () => {
  it('lets a visitor in with a token the site minted for this system, and knows them by their session hash', async () => {
    const response = await app.inject({ url: '/api/lb99/whoami', headers: authorised })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ session: 'session-0123456789abcdef' })
  })

  it('answers every failure with the same 401, so a caller cannot probe which check failed', async () => {
    const other = makeSiteKeys()
    const bad = [
      undefined,
      'Bearer',
      'Bearer not-a-token',
      `Bearer ${mintVisitorToken(other.privateKey, { iss: 'lb-web', aud: 'lb-99', sub: 'session-0123456789abcdef', iat: NOW, exp: NOW + 300 })}`,
      `Bearer ${mintVisitorToken(site.privateKey, { iss: 'lb-web', aud: 'lb-01', sub: 'session-0123456789abcdef', iat: NOW, exp: NOW + 300 })}`,
      `Bearer ${mintVisitorToken(site.privateKey, { iss: 'lb-web', aud: 'lb-99', sub: 'session-0123456789abcdef', iat: NOW - 4_000, exp: NOW - 3_700 })}`,
    ]

    const bodies = new Set<string>()
    for (const authorization of bad) {
      const response = await app.inject({ url: '/api/lb99/whoami', headers: authorization === undefined ? {} : { authorization } })
      expect(response.statusCode).toBe(401)
      bodies.add(response.body)
    }

    expect(bodies.size).toBe(1)
    expect(JSON.parse([...bodies][0] ?? '{}')).toEqual({ error: { code: 'unauthorized', message: 'This route needs a valid visitor token for its system.' } })
  })

  it('checks the token before the body, so an unauthenticated caller learns nothing about the route', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/lb99/echo', payload: { wrong: 'shape' } })

    expect(response.statusCode).toBe(401)
  })

  it('refuses everyone when the site\'s key is not configured', async () => {
    const closed = await buildApp({ modules: [fakeModule(createVisitorVerifier('lb-99', undefined))] })

    const response = await closed.inject({ url: '/api/lb99/whoami', headers: authorised })

    expect(response.statusCode).toBe(401)
    await closed.close()
  })

  it('leaves the health checks and the OpenAPI document open', async () => {
    for (const url of ['/api/healthz', '/api/readyz', '/api/openapi.json']) expect((await app.inject({ url })).statusCode, url).toBe(200)
  })
})

describe('the health checks', () => {
  it('answers liveness without asking any system', async () => {
    ready = false

    const response = await app.inject({ url: '/api/healthz' })

    expect(response.json()).toEqual({ status: 'ok' })
    ready = true
  })

  it('answers readiness per system, and 503 when one cannot reach what it needs', async () => {
    expect((await app.inject({ url: '/api/readyz' })).json()).toEqual({ lb99: true })

    ready = false
    const response = await app.inject({ url: '/api/readyz' })
    ready = true

    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ lb99: false })
  })
})

describe('the OpenAPI document', () => {
  it('describes the routes, and hides the route that serves it', async () => {
    const document = (await app.inject({ url: '/api/openapi.json' })).json()

    expect(document.openapi).toBe('3.1.0')
    expect(Object.keys(document.paths)).toEqual(expect.arrayContaining(['/api/healthz', '/api/readyz', '/api/lb99/whoami']))
    expect(Object.keys(document.paths)).not.toContain('/api/openapi.json')
    expect(document.components.securitySchemes.visitorToken).toMatchObject({ type: 'http', scheme: 'bearer' })
  })
})
