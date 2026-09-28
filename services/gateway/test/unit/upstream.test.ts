// Unit tests for talking to providers: endpoints, Retry-After, failure classification,
// error messages and token usage.
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { loadRouting } from '../../src/routing/load.ts'
import { classifyStatus, endpointUrl, parseRetryAfter, upstreamMessage } from '../../src/upstream/client.ts'
import { readUsage } from '../../src/upstream/usage.ts'

const now = Date.UTC(2026, 8, 28, 12)

describe('Retry-After', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('7', now)).toBe(7_000)
    expect(parseRetryAfter('2.5', now)).toBe(2_500)
    expect(parseRetryAfter(new Date(now + 90_000).toUTCString(), now)).toBe(90_000)
  })

  it('ignores junk and keeps the wait between a second and a day', () => {
    expect(parseRetryAfter(null, now)).toBeUndefined()
    expect(parseRetryAfter('soon', now)).toBeUndefined()
    expect(parseRetryAfter('0', now)).toBe(1_000)
    expect(parseRetryAfter('9999999', now)).toBe(86_400_000)
  })
})

describe('classifying provider failures', () => {
  const headers = new Headers({ 'retry-after': '12' })

  it('retries elsewhere on 429, 5xx, and a provider that can\'t serve the model', () => {
    expect(classifyStatus(429, headers, '', now)).toEqual({ kind: 'retry', reason: 'rate_limited', status: 429, retryAfterMs: 12_000 })
    expect(classifyStatus(503, headers, '', now)).toEqual({ kind: 'retry', reason: 'server_error', status: 503 })
    for (const status of [401, 402, 403, 404, 408, 413]) {
      expect(classifyStatus(status, headers, '', now)).toEqual({ kind: 'retry', reason: 'unavailable', status })
    }
  })

  it('hands a malformed request back to the caller with the provider\'s reason', () => {
    expect(classifyStatus(400, headers, '{"error":{"message":"tools[0] is invalid"}}', now))
      .toEqual({ kind: 'reject', status: 400, message: 'tools[0] is invalid' })
  })

  it('reads Cloudflare\'s error list as well as the OpenAI envelope', () => {
    expect(upstreamMessage('{"success":false,"errors":[{"code":5006,"message":"contexts must not be empty"}]}')).toBe('contexts must not be empty')
  })

  it('cleans up the provider\'s message before passing it on', () => {
    expect(upstreamMessage('{"error":"bad\\u0000input"}')).toBe('bad input')
    expect(upstreamMessage(`{"message":"${'x'.repeat(500)}"}`)).toHaveLength(300)
    expect(upstreamMessage('<html>Bad Gateway</html>')).toBe('The provider rejected the request.')
  })
})

describe('provider endpoints', () => {
  const routing = loadRouting(readFileSync(new URL('../../routing.yaml', import.meta.url), 'utf8'), {
    GROQ_API_KEY: 'k', CLOUDFLARE_API_TOKEN: 'k', CLOUDFLARE_ACCOUNT_ID: 'acc',
  })

  it('calls OpenAI-compatible endpoints under the base URL, and Workers AI\'s own endpoint with the model ID', () => {
    const groq = routing.models.get('groq/llama-prompt-guard-2-86m')!
    const reranker = routing.models.get('workers-ai/bge-reranker-base')!
    expect(endpointUrl(groq, 'chat')).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(endpointUrl(routing.models.get('workers-ai/bge-m3')!, 'embeddings')).toBe('https://api.cloudflare.com/client/v4/accounts/acc/ai/v1/embeddings')
    expect(endpointUrl(reranker, 'run')).toBe('https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/baai/bge-reranker-base')
  })
})

describe('reading usage', () => {
  it('reads the standard usage field and Groq\'s streaming one', () => {
    expect(readUsage({ usage: { prompt_tokens: 10, completion_tokens: 4 } })).toEqual({ input: 10, output: 4 })
    expect(readUsage({ usage: null, x_groq: { usage: { prompt_tokens: 7, completion_tokens: 2 } } })).toEqual({ input: 7, output: 2 })
    expect(readUsage({ usage: { prompt_tokens: 12, total_tokens: 12 } })).toEqual({ input: 12, output: 0 })
  })

  it('returns nothing for chunks without usage or with nonsense in it', () => {
    expect(readUsage({ choices: [] })).toBeUndefined()
    expect(readUsage({ usage: { prompt_tokens: -3 } })).toBeUndefined()
    expect(readUsage('text')).toBeUndefined()
  })
})
