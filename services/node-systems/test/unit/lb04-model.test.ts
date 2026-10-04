// Tests for how LB-04 asks a chat model for JSON (analysis/model.ts), through the real AI SDK with a
// mock model underneath: what is sent (temperature 0, one try, the whole conversation, the limit on the
// answer the alias allows), what counts as a JSON answer (a bare object, one in a Markdown fence, one
// after a sentence or after the model's reasoning) and what does not (it comes back as text for the one
// repair, not as an error).
import { APICallError } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'

import { analysisAnswerSchema } from '../../src/modules/lb04/analysis/answers.ts'
import { ALIASES, GatewayJsonModel, jsonObjectIn, MAX_OUTPUT_TOKENS } from '../../src/modules/lb04/analysis/model.ts'
import type { PromptMessage } from '../../src/modules/lb04/analysis/model.ts'

const conversation: PromptMessage[] = [
  { role: 'system', content: 'You review contracts.' },
  { role: 'user', content: '<contract>\n[1] Pay in thirty days.\n</contract>' },
]

/** Builds a mock model that answers with the given texts, one per call. */
function answering(...texts: string[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: texts.map(text => ({
      content: [{ type: 'text' as const, text }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      },
      warnings: [],
    })),
  })
}

describe('the aliases and their limits', () => {
  it('are the three virtual models of the gateway, each with the longest answer its entry in routing.yaml allows', () => {
    expect(ALIASES).toEqual({ long: 'lb-long', reason: 'lb-reason', fast: 'lb-fast' })
    expect(MAX_OUTPUT_TOKENS).toEqual({ long: 4_096, reason: 3_072, fast: 1_024 })
  })
})

describe('asking for JSON', () => {
  it('returns the object a model answers with', async () => {
    const reply = await new GatewayJsonModel(answering('{"notes": [], "missing": []}'), 1_000).ask(conversation)

    expect(reply).toEqual({ kind: 'json', value: { notes: [], missing: [] } })
  })

  it('sends the conversation as it is, at temperature 0, with the limit on the answer it was built with, and no retry', async () => {
    const mock = answering('{}')

    await new GatewayJsonModel(mock, MAX_OUTPUT_TOKENS.reason).ask([...conversation, { role: 'assistant', content: '{"half"' }, { role: 'user', content: 'Again, please.' }])

    expect(mock.doGenerateCalls).toHaveLength(1)
    const call = mock.doGenerateCalls[0]
    expect(call?.temperature).toBe(0)
    expect(call?.maxOutputTokens).toBe(3_072)
    expect(call?.prompt.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(call?.prompt[0]).toMatchObject({ role: 'system', content: 'You review contracts.' })
    expect(call?.prompt[1]).toMatchObject({ role: 'user', content: [{ type: 'text', text: '<contract>\n[1] Pay in thirty days.\n</contract>' }] })
  })

  it('never retries by itself: the gateway fails over between providers, and a retry here would spend a counted call', async () => {
    const mock = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({ message: 'overloaded', url: 'http://gateway/v1/chat/completions', requestBodyValues: {}, statusCode: 503, isRetryable: true })
      },
    })

    await expect(new GatewayJsonModel(mock, 1_000).ask(conversation)).rejects.toBeInstanceOf(APICallError)
    expect(mock.doGenerateCalls).toHaveLength(1)
  })

  it.each([
    ['in a Markdown fence', '```json\n{"notes": []}\n```'],
    ['in a fence with no language', '```\n{"notes": []}\n```'],
    ['after a sentence', 'Here is the review: {"notes": []}'],
    ['before a sentence', '{"notes": []}\nHope that helps!'],
    ['after the model\'s reasoning, which has braces of its own', '<think>Maybe {"a": 1} or {the other}</think>\n{"notes": []}'],
    ['with surrounding white space', '\n\n  {"notes": []}  \n'],
  ])('still counts an answer %s', async (_how, text) => {
    const reply = await new GatewayJsonModel(answering(text), 1_000).ask(conversation)

    expect(reply).toEqual({ kind: 'json', value: { notes: [] } })
  })

  it.each([
    ['prose with no JSON at all', 'I cannot review this contract.'],
    ['an object that is cut off', '{"notes": [{"rule": "payment-slow"'],
    ['two objects', '{"notes": []} and {"missing": []}'],
    ['an empty answer', ''],
  ])('hands back %s as text, for the one repair, and does not throw', async (_how, text) => {
    const reply = await new GatewayJsonModel(answering(text), 1_000).ask(conversation)

    expect(reply.kind).toBe('text')
  })

  it('hands back a list as JSON, and leaves it to the schema of the answer to refuse it', async () => {
    const reply = await new GatewayJsonModel(answering('[1, 2, 3]'), 1_000).ask(conversation)

    expect(reply).toEqual({ kind: 'json', value: [1, 2, 3] })
    expect(analysisAnswerSchema.safeParse(reply.kind === 'json' ? reply.value : undefined).success).toBe(false)
  })

  it('refuses a conversation that does not begin with its one system prompt', async () => {
    const model = new GatewayJsonModel(answering('{}'), 1_000)

    await expect(model.ask([{ role: 'user', content: 'No system prompt.' }])).rejects.toBeInstanceOf(RangeError)
    await expect(model.ask([...conversation, { role: 'system', content: 'A second system prompt.' }])).rejects.toBeInstanceOf(RangeError)
    await expect(model.ask([])).rejects.toBeInstanceOf(RangeError)
  })
})

describe('finding the JSON in an answer', () => {
  it('takes from the first brace to the last, and returns nothing when what lies between is not JSON', () => {
    expect(jsonObjectIn('text {"a": {"b": 1}} text')).toBe('{"a": {"b": 1}}')
    expect(jsonObjectIn('text {not json} text')).toBeNull()
    expect(jsonObjectIn('no braces')).toBeNull()
    expect(jsonObjectIn('} backwards {')).toBeNull()
  })

  it('reads only what follows the last end of the model\'s reasoning', () => {
    expect(jsonObjectIn('<think>{"a": 1}</think>{"b": 2}')).toBe('{"b": 2}')
    expect(jsonObjectIn('<think>{"a": 1}</think>')).toBeNull()
  })
})
