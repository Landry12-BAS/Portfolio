// Unit tests for request handling: the chat schema, the upstream body, token estimates
// and the environment.
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { estimateChatInput, estimateEmbeddingInput, textTokens } from '../../src/budget/estimate.ts'
import { loadEnv } from '../../src/env.ts'
import { loadRouting } from '../../src/routing/load.ts'
import { outputLimit, requiredCapabilities, upstreamChatBody } from '../../src/routes/chat.ts'
import { chatRequestSchema } from '../../src/schemas/chat.ts'
import type { ChatRequest } from '../../src/schemas/chat.ts'

const routing = loadRouting(readFileSync(new URL('../../routing.yaml', import.meta.url), 'utf8'), {
  GROQ_API_KEY: 'k', CLOUDFLARE_API_TOKEN: 'k', CLOUDFLARE_ACCOUNT_ID: 'acc', OPENROUTER_API_KEY: 'k',
})

/** Builds a validated chat request, with any field overridden. */
function request(overrides: Record<string, unknown> = {}): ChatRequest {
  return chatRequestSchema.parse({ model: 'lb-tools', messages: [{ role: 'user', content: 'Where is my order?' }], ...overrides })
}

describe('the chat request schema', () => {
  it('accepts what the AI SDK and the openai client send, and drops the rest', () => {
    const parsed = request({
      tools: [{ type: 'function', function: { name: 'lookup_order', parameters: { type: 'object' } } }],
      tool_choice: 'auto',
      stream: true,
      stream_options: { include_usage: true },
      n: 4,
      user: 'visitor-42',
      logit_bias: { 1: 100 },
      store: true,
    })
    expect(parsed).not.toHaveProperty('n')
    expect(parsed).not.toHaveProperty('user')
    expect(parsed).not.toHaveProperty('logit_bias')
    expect(parsed).not.toHaveProperty('store')
    expect(parsed.tools?.[0]?.function.name).toBe('lookup_order')
  })

  it('carries a tool conversation', () => {
    expect(() => request({
      messages: [
        { role: 'user', content: 'Where is order 1042?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup_order', arguments: '{"id":1042}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"status":"shipped"}' },
      ],
    })).not.toThrow()
  })

  it('refuses roles and fields a provider would misread', () => {
    expect(chatRequestSchema.safeParse({ model: 'lb-tools', messages: [{ role: 'root', content: 'hi' }] }).success).toBe(false)
    expect(chatRequestSchema.safeParse({ model: 'lb-tools', messages: [] }).success).toBe(false)
    expect(chatRequestSchema.safeParse({ model: 'lb-tools', messages: [{ role: 'user', content: 'hi' }], temperature: 7 }).success).toBe(false)
  })
})

describe('shaping the upstream call', () => {
  it('works out the capabilities a call needs', () => {
    expect([...requiredCapabilities(request())]).toEqual(['chat'])
    expect([...requiredCapabilities(request({
      tools: [{ type: 'function', function: { name: 'lookup_order' } }],
      response_format: { type: 'json_schema', json_schema: { name: 'reply', schema: {} } },
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
    }))]).toEqual(['chat', 'tools', 'vision', 'json_schema'])
  })

  it('caps the answer at the alias\'s limit', () => {
    const alias = routing.aliases.get('lb-tools')!
    expect(outputLimit(request(), alias)).toBe(2048)
    expect(outputLimit(request({ max_completion_tokens: 300 }), alias)).toBe(300)
    expect(() => outputLimit(request({ max_tokens: 5000 }), alias)).toThrow('lb-tools\'s limit of 2048')
  })

  it('names the provider\'s model and token cap, and asks for usage on streams', () => {
    const groq = routing.models.get('groq/gpt-oss-120b')!
    const workers = routing.models.get('workers-ai/gpt-oss-120b')!
    const call = request({ reasoning_effort: 'low', max_tokens: 700, stream: true })

    expect(upstreamChatBody(call, groq, 700, true)).toEqual({
      model: 'openai/gpt-oss-120b',
      messages: call.messages,
      max_completion_tokens: 700,
      reasoning_effort: 'low',
      stream: true,
      stream_options: { include_usage: true },
    })
    expect(upstreamChatBody(call, workers, 700, false)).toEqual({ model: '@cf/openai/gpt-oss-120b', messages: call.messages, max_tokens: 700 })
  })
})

describe('token estimates', () => {
  it('errs on the high side of four characters a token', () => {
    expect(textTokens('x'.repeat(350))).toBe(100)
    expect(estimateEmbeddingInput(['x'.repeat(35), 'x'.repeat(70)])).toBe(30)
  })

  it('counts messages, tool schemas and images', () => {
    const plain = estimateChatInput(request())
    const withTools = estimateChatInput(request({ tools: [{ type: 'function', function: { name: 'lookup_order', description: 'x'.repeat(350) } }] }))
    const withImage = estimateChatInput(request({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] }))
    expect(plain).toBe(3 + 4 + textTokens('Where is my order?'))
    expect(withTools - plain).toBeGreaterThan(100)
    expect(withImage).toBeGreaterThanOrEqual(1600)
  })
})

describe('the environment', () => {
  const publicKey = 'A'.repeat(43)

  it('defaults to the production profile and the lb: prefix', () => {
    const env = loadEnv({ LB_REDIS_URL: 'redis://redis:6379', LB_SERVICE_KEYS: JSON.stringify({ 'django-systems': publicKey }) })
    expect(env).toMatchObject({ LB_GATEWAY_PROFILE: 'production', LB_REDIS_PREFIX: 'lb:', LB_GATEWAY_PORT: 8080 })
    expect(env.LB_SERVICE_KEYS).toEqual({ 'django-systems': publicKey })
  })

  it('refuses service keys that aren\'t a JSON map of Ed25519 public keys', () => {
    expect(() => loadEnv({ LB_REDIS_URL: 'redis://redis:6379', LB_SERVICE_KEYS: 'django-systems=abc' })).toThrow('LB_SERVICE_KEYS')
    expect(() => loadEnv({ LB_REDIS_URL: 'redis://redis:6379', LB_SERVICE_KEYS: '{"django-systems":"short"}' })).toThrow('Ed25519')
    expect(() => loadEnv({ LB_REDIS_URL: 'redis://redis:6379', LB_SERVICE_KEYS: '{}' })).toThrow('at least one service')
  })

  it('needs a Redis URL', () => {
    expect(() => loadEnv({ LB_SERVICE_KEYS: JSON.stringify({ 'django-systems': publicKey }) })).toThrow('LB_REDIS_URL')
  })
})
