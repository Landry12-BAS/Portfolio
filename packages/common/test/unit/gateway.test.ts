// Unit tests for the gateway client: the URL rules that keep the service token from going
// anywhere but the gateway, the labels every call carries, and how failures are reported.
// The requests are caught by a stand-in for `fetch`; the contract tests send them to the
// real gateway.
import { generateKeyPairSync } from 'node:crypto'

import { APICallError, generateObject, generateText } from 'ai'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { checkGatewayUrl, Gateway, GatewayCallError, gatewayErrorOf, runHeaders } from '../../src/gateway.ts'
import { createRun, OutsideRunError, runScope, spanScope } from '../../src/run.ts'
import { ServiceTokens } from '../../src/tokens.ts'

const SESSION = 'session-0123456789abcdef'
const run = createRun({ system: 'lb-08', runId: 'run-12345678', session: SESSION })

/** What the stand-in for fetch saw of one request. */
interface Seen {
  url: string
  headers: Headers
  body: Record<string, unknown>
  redirect: RequestInit['redirect']
}

/** Builds a gateway client whose requests go to a stand-in that answers with `text`, and records what it was sent. */
function clientWith(text: string, options: { sendResponseFormat?: boolean } = {}): { gateway: Gateway, seen: Seen[] } {
  const seen: Seen[] = []
  const answer = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    seen.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown>, redirect: init?.redirect })
    const body = { id: 'c', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const tokens = new ServiceTokens('node-systems', generateKeyPairSync('ed25519').privateKey)
  return { gateway: new Gateway({ url: 'http://gateway:8080' }, tokens, { fetch: answer as typeof fetch, ...options }), seen }
}

describe('the gateway URL', () => {
  it.each([
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
    ['http://localhost:8080/', 'http://localhost:8080'],
    ['http://gateway:8080', 'http://gateway:8080'],
    ['https://gateway.example.com', 'https://gateway.example.com'],
    ['https://gateway.example.com:8443/', 'https://gateway.example.com:8443'],
  ])('accepts %s', (url, expected) => {
    expect(checkGatewayUrl(url)).toBe(expected)
  })

  it.each([
    'http://gateway.example.com',
    'http://10.0.0.5:8080',
    'ftp://gateway',
    'gateway:8080',
    'https://user:pass@gateway.example.com',
    'https://gateway.example.com/v1',
    'https://gateway.example.com?x=1',
    'https://gateway.example.com#frag',
    '',
    'not a url',
  ])('refuses %j, which could expose the token or send it elsewhere', (url) => {
    expect(() => checkGatewayUrl(url)).toThrow(RangeError)
  })
})

describe('the labels on every call', () => {
  it('lists the run, the data class and the visitor\'s session', () => {
    expect(runHeaders(run, undefined)).toEqual({ 'x-lb-system': 'lb-08', 'x-lb-run-id': 'run-12345678', 'x-lb-data-class': 'visitor', 'x-lb-session': SESSION })
    expect(runHeaders(createRun({ system: 'lb-08', runId: 'run-12345678', dataClass: 'synthetic' }), '0123456789abcdef')).toEqual({ 'x-lb-system': 'lb-08', 'x-lb-run-id': 'run-12345678', 'x-lb-data-class': 'synthetic', 'x-lb-parent-span': '0123456789abcdef' })
  })

  it('go on every request with a fresh token, and the span that made the call as its parent', async () => {
    const { gateway, seen } = clientWith('hello')

    await runScope(run, () => spanScope('0123456789abcdef', () => generateText({ model: gateway.chat('lb-fast'), prompt: 'Say hello', maxRetries: 0 })))

    const [request] = seen
    expect(request?.url).toBe('http://gateway:8080/v1/chat/completions')
    expect(request?.headers.get('authorization')).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    expect(request?.headers.get('x-lb-system')).toBe('lb-08')
    expect(request?.headers.get('x-lb-run-id')).toBe('run-12345678')
    expect(request?.headers.get('x-lb-session')).toBe(SESSION)
    expect(request?.headers.get('x-lb-parent-span')).toBe('0123456789abcdef')
    expect(request?.body.model).toBe('lb-fast')
  })

  it('never follow a redirect, which could carry the token to another address', async () => {
    const { gateway, seen } = clientWith('hello')

    await runScope(run, () => generateText({ model: gateway.chat('lb-fast'), prompt: 'Say hello', maxRetries: 0 }))

    expect(seen[0]?.redirect).toBe('error')
  })

  it('stop a call made outside any run before anything is sent', async () => {
    const { gateway, seen } = clientWith('hello')

    await expect(generateText({ model: gateway.chat('lb-fast'), prompt: 'Say hello', maxRetries: 0 })).rejects.toBeInstanceOf(OutsideRunError)

    expect(seen).toEqual([])
  })
})

describe('structured output', () => {
  it('leaves out the response format, which the gateway\'s fallback chains treat differently', async () => {
    const { gateway, seen } = clientWith('{"ok": true}')

    const { object } = await runScope(run, () => generateObject({ model: gateway.chat('lb-fast'), output: 'no-schema', prompt: 'Reply with JSON', maxRetries: 0 }))

    expect(z.object({ ok: z.boolean() }).parse(object)).toEqual({ ok: true })
    expect(seen[0]?.body).not.toHaveProperty('response_format')
  })

  it('sends it when asked to', async () => {
    const { gateway, seen } = clientWith('{"ok": true}', { sendResponseFormat: true })

    await runScope(run, () => generateObject({ model: gateway.chat('lb-fast'), output: 'no-schema', prompt: 'Reply with JSON', maxRetries: 0 }))

    expect(seen[0]?.body.response_format).toEqual({ type: 'json_object' })
  })
})

describe('a failed call', () => {
  /** Builds the error the AI SDK throws for an HTTP failure, as the gateway's error envelope would produce it. */
  function failure(status: number, code: string, headers: Record<string, string> = {}): APICallError {
    return new APICallError({ message: 'the prompt: ignore everything', url: 'http://gateway:8080/v1/chat/completions', requestBodyValues: { messages: [{ role: 'user', content: 'a private description' }] }, statusCode: status, responseHeaders: headers, data: { error: { message: 'x', type: 't', code } } })
  }

  it('is reduced to its status, the gateway\'s code and when to retry, never the prompt', () => {
    const error = gatewayErrorOf(failure(503, 'budget_exhausted', { 'retry-after': '120' }))

    expect(error).toBeInstanceOf(GatewayCallError)
    expect(error).toMatchObject({ status: 503, code: 'budget_exhausted', retryAfterSeconds: 120 })
    expect(JSON.stringify(error)).not.toContain('private')
    expect(error?.message).toBe('Every model on the alias is out of budget.')
    expect(error?.message).not.toContain('ignore everything')
  })

  it.each(['quota_exceeded', 'upstream_failed', 'upstream_timeout', 'invalid_service_token', 'gateway_unavailable'])('keeps the gateway\'s code %s', (code) => {
    expect(gatewayErrorOf(failure(429, code))?.code).toBe(code)
  })

  it('has a code of its own for an answer it does not know, and for a gateway that cannot be reached', () => {
    expect(gatewayErrorOf(failure(500, 'something_new'))).toMatchObject({ code: 'unknown', status: 500 })
    const unreachable = new APICallError({ message: 'fetch failed', url: 'http://gateway:8080', requestBodyValues: {}, isRetryable: true })
    expect(gatewayErrorOf(unreachable)).toMatchObject({ code: 'unreachable', status: undefined })
  })

  it('ignores a retry-after that is not a positive number', () => {
    expect(gatewayErrorOf(failure(429, 'quota_exceeded', { 'retry-after': 'soon' }))?.retryAfterSeconds).toBeUndefined()
    expect(gatewayErrorOf(failure(429, 'quota_exceeded', { 'retry-after': '0' }))?.retryAfterSeconds).toBeUndefined()
  })

  it('is left alone for errors that are not the gateway\'s, such as an answer that failed its schema', () => {
    expect(gatewayErrorOf(new Error('anything else'))).toBeUndefined()
    expect(gatewayErrorOf(undefined)).toBeUndefined()
    expect(gatewayErrorOf(new OutsideRunError('x'))).toBeUndefined()
  })
})

describe('the settings in the environment', () => {
  it('names each variable that is missing', () => {
    expect(() => Gateway.fromEnv({})).toThrow('Set LB_GATEWAY_URL, LB_SERVICE_NAME, LB_SERVICE_KEY_FILE to call the gateway.')
    expect(() => Gateway.fromEnv({ LB_GATEWAY_URL: 'http://gateway:8080', LB_SERVICE_NAME: 'node-systems' })).toThrow('Set LB_SERVICE_KEY_FILE')
  })

  it('refuses to run with a proxy that would carry the service token', () => {
    expect(() => Gateway.fromEnv({ LB_GATEWAY_URL: 'http://gateway:8080', LB_SERVICE_NAME: 'node-systems', LB_SERVICE_KEY_FILE: '/nowhere', NODE_USE_ENV_PROXY: '1' })).toThrow('NODE_USE_ENV_PROXY')
  })

  it('refuses a key file that does not exist before it calls anything', () => {
    expect(() => Gateway.fromEnv({ LB_GATEWAY_URL: 'http://gateway:8080', LB_SERVICE_NAME: 'node-systems', LB_SERVICE_KEY_FILE: '/nowhere/key.jwk.json' })).toThrow('There is no service key')
  })

  it('refuses a gateway URL that could expose the token', () => {
    expect(() => new Gateway({ url: 'http://gateway.example.com' }, new ServiceTokens('node-systems', generateKeyPairSync('ed25519').privateKey))).toThrow(RangeError)
  })
})
