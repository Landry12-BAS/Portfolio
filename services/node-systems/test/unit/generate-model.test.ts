// Tests for how LB-08 asks a chat model for JSON (generate/model.ts), through the real AI
// SDK with a mock model underneath: what is sent (temperature 0, one try, the whole
// conversation), what counts as a JSON answer (a bare object, one in a Markdown fence, one
// after a sentence or after the model's reasoning) and what doesn't (it comes back as text
// for the repair, not as an error).
import { APICallError } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'

import { GatewayJsonModel, jsonObjectIn } from '../../src/modules/lb08/generate/model.ts'
import { DESCRIBE_MAX_OUTPUT_TOKENS } from '../../src/modules/lb08/generate/prompts.ts'
import type { PromptMessage } from '../../src/modules/lb08/generate/prompts.ts'

const conversation: PromptMessage[] = [
  { role: 'system', content: 'You write workflows.' },
  { role: 'user', content: '<process>\nAlert the roastery.\n</process>' },
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

describe('asking for JSON', () => {
  it('returns the object a model answers with', async () => {
    const mock = answering('{"name": "Alert", "nodes": [], "edges": []}')

    const reply = await new GatewayJsonModel(mock).ask(conversation)

    expect(reply).toEqual({ kind: 'json', value: { name: 'Alert', nodes: [], edges: [] } })
  })

  it('sends the conversation as it is, at temperature 0, with a limit on the answer and no retry', async () => {
    const mock = answering('{}')

    await new GatewayJsonModel(mock).ask([...conversation, { role: 'assistant', content: '{"half"' }, { role: 'user', content: 'Again, please.' }])

    expect(mock.doGenerateCalls).toHaveLength(1)
    const call = mock.doGenerateCalls[0]
    expect(call?.temperature).toBe(0)
    expect(call?.maxOutputTokens).toBe(DESCRIBE_MAX_OUTPUT_TOKENS)
    expect(call?.prompt.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(call?.prompt[0]).toMatchObject({ role: 'system', content: 'You write workflows.' })
    expect(call?.prompt[1]).toMatchObject({ role: 'user', content: [{ type: 'text', text: '<process>\nAlert the roastery.\n</process>' }] })
  })

  it('never retries by itself: the gateway fails over between providers, and a retry here would spend a counted call', async () => {
    const mock = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({ message: 'overloaded', url: 'http://gateway/v1/chat/completions', requestBodyValues: {}, statusCode: 503, isRetryable: true })
      },
    })

    await expect(new GatewayJsonModel(mock).ask(conversation)).rejects.toBeInstanceOf(APICallError)
    expect(mock.doGenerateCalls).toHaveLength(1)
  })

  it.each([
    ['in a Markdown fence', '```json\n{"name": "Alert"}\n```'],
    ['in a fence with no language', '```\n{"name": "Alert"}\n```'],
    ['after a sentence', 'Here is the workflow: {"name": "Alert"}'],
    ['before a sentence', '{"name": "Alert"}\nHope that helps!'],
    ['after the model\'s reasoning, which has braces of its own', '<think>Maybe {"a": 1} or {the other}</think>\n{"name": "Alert"}'],
    ['with surrounding whitespace', '\n\n  {"name": "Alert"}  \n'],
  ])('still counts an answer %s', async (_how, text) => {
    const reply = await new GatewayJsonModel(answering(text)).ask(conversation)

    expect(reply).toEqual({ kind: 'json', value: { name: 'Alert' } })
  })

  it.each([
    ['prose with no object', 'I am sorry, I cannot do that.'],
    ['an object that is not JSON', '{name: Alert, nodes: [}'],
    ['two objects', '{"a": 1} and then {"b": 2}'],
    ['an empty reply', ''],
  ])('hands back %s as text, for the repair, and not as an error', async (_what, text) => {
    const reply = await new GatewayJsonModel(answering(text)).ask(conversation)

    expect(reply).toEqual({ kind: 'text', text })
  })

  it('hands back JSON that is not an object as JSON, for validation to refuse', async () => {
    expect(await new GatewayJsonModel(answering('[1, 2, 3]')).ask(conversation)).toMatchObject({ kind: 'json' })
  })
})

describe('finding the object in a reply', () => {
  it('returns the text from the first brace to the last, when that is JSON', () => {
    expect(jsonObjectIn('x {"a": {"b": 1}} y')).toBe('{"a": {"b": 1}}')
  })

  it('returns null for anything else', () => {
    for (const text of ['', 'no braces', '} {', '{"unclosed": ', '{"a": 1} {"b": 2}']) expect(jsonObjectIn(text), text).toBeNull()
  })

  it('looks only after the last closing reasoning tag', () => {
    expect(jsonObjectIn('<think>{"decoy": true}</think>{"real": true}')).toBe('{"real": true}')
    expect(jsonObjectIn('<think>{"decoy": true}</think>')).toBeNull()
  })
})
