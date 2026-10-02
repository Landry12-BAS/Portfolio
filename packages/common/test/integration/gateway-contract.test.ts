// Contract tests: @lb/common against the real gateway, on a fake provider.
//
// The gateway is services/gateway's own app, running in this process on a real Redis.
// These tests prove that what @lb/common signs, sends and reads is what the gateway
// checks, accepts and answers: tokens, run headers, chat and structured output, error
// codes, and spans that nest across the two sides. They are the TypeScript counterpart of
// python/lb-common's test_gateway_contract.py.
import { generateKeyPairSync, randomBytes } from 'node:crypto'

import { generateObject, generateText } from 'ai'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'

import { Gateway, gatewayErrorOf } from '../../src/gateway.ts'
import { createRun, newRunId, OutsideRunError, runScope } from '../../src/run.ts'
import type { Run } from '../../src/run.ts'
import { ServiceTokens } from '../../src/tokens.ts'
import { RedisSpanWriter, spanSchema, Tracer } from '../../src/tracing.ts'
import { startContractGateway } from '../support/contract-gateway.ts'
import type { ContractGateway } from '../support/contract-gateway.ts'

let gw: ContractGateway

beforeAll(async () => {
  gw = await startContractGateway(inject('redisUrl'))
})

afterAll(async () => {
  await gw.close()
})

beforeEach(() => {
  gw.provider.reset()
})

/** Makes a visitor run with a session of its own, so no test spends another's quota. */
function visitorRun(): Run {
  return createRun({ system: 'lb-08', runId: newRunId(), session: `session-${randomBytes(8).toString('hex')}` })
}

/** Asks the fast alias one question through the AI SDK, the way a system does. */
function ask(client: Gateway = gw.client, alias = 'lb-fast') {
  return generateText({ model: client.chat(alias), prompt: 'Classify: my bag arrived torn', maxRetries: 0 })
}

/** Catches what a call throws, so a test can look at it. */
async function failureOf(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work()
  }
  catch (error) {
    return error
  }
  throw new Error('The call was expected to fail.')
}

describe('a call the gateway accepts', () => {
  it('is routed, and the provider sees only its own key', async () => {
    const { text } = await runScope(visitorRun(), () => ask())

    expect(text).toBe('alpha answer')
    const [sent] = gw.provider.requests
    expect(gw.provider.requests).toHaveLength(1)
    expect(sent?.headers.authorization).toBe('Bearer alpha-key')
    expect(sent?.body).toMatchObject({ model: 'alpha/small-model', max_completion_tokens: 512 })
    expect(JSON.stringify(sent?.body.messages)).toContain('my bag arrived torn')
    expect(Object.keys(sent?.headers ?? {}).filter(name => name.startsWith('x-lb-'))).toEqual([])
  })

  it('needs no session for a synthetic run', async () => {
    const { text } = await runScope(createRun({ system: 'lb-08', runId: newRunId(), dataClass: 'synthetic' }), () => ask())

    expect(text).toBe('alpha answer')
  })

  it('reads a JSON answer through generateObject, and sends no response format for the providers to disagree about', async () => {
    gw.provider.answerNext('{"category": "damaged", "order": null}')

    const { object } = await runScope(visitorRun(), () => generateObject({ model: gw.client.chat('lb-fast'), output: 'no-schema', prompt: 'Reply with one JSON object', maxRetries: 0 }))

    expect(object).toEqual({ category: 'damaged', order: null })
    expect(gw.provider.requests[0]?.body).not.toHaveProperty('response_format')
  })
})

describe('a call the gateway refuses', () => {
  it('never leaves the process when it is made outside a run', async () => {
    const error = await failureOf(() => ask())

    expect(error).toBeInstanceOf(OutsideRunError)
    expect(gw.provider.requests).toEqual([])
  })

  it('reaches the caller as the gateway\'s own code when a run\'s calls are spent', async () => {
    await runScope(visitorRun(), async () => {
      // The test routing allows three calls a run.
      for (let call = 0; call < 3; call += 1) await ask()
      const error = gatewayErrorOf(await failureOf(() => ask()))

      expect(error).toMatchObject({ status: 429, code: 'quota_exceeded' })
    })
  })

  it('reaches the caller with its retry-after when a budget is spent', async () => {
    await runScope(visitorRun(), async () => {
      await ask(gw.client, 'lb-tiny')
      const error = gatewayErrorOf(await failureOf(() => ask(gw.client, 'lb-tiny')))

      expect(error).toMatchObject({ status: 503, code: 'budget_exhausted' })
      expect(error?.retryAfterSeconds).toBeGreaterThan(0)
    })
  })

  it('carries the gateway\'s code for a provider that fails, and nothing the visitor wrote', async () => {
    gw.provider.enqueue({ status: 500, body: { error: { message: 'a private description leaked here' } } })

    await runScope(visitorRun(), async () => {
      const error = gatewayErrorOf(await failureOf(() => ask()))

      expect(error).toMatchObject({ status: 502, code: 'upstream_failed' })
      expect(error?.message).not.toContain('private')
    })
  })

  it('turns away a token signed with another key', async () => {
    const impostor = new Gateway({ url: gw.url }, new ServiceTokens('node-systems', generateKeyPairSync('ed25519').privateKey))

    await runScope(visitorRun(), async () => {
      const error = gatewayErrorOf(await failureOf(() => ask(impostor)))

      expect(error).toMatchObject({ status: 401, code: 'invalid_service_token' })
    })
    expect(gw.provider.requests).toEqual([])
  })

  it('refuses to call for a system the service does not own', async () => {
    await runScope(createRun({ system: 'lb-01', runId: newRunId(), dataClass: 'synthetic' }), async () => {
      const error = gatewayErrorOf(await failureOf(() => ask()))

      expect(error).toMatchObject({ status: 403, code: 'system_not_allowed' })
    })
  })

  it('refuses an alias the system may not use', async () => {
    await runScope(visitorRun(), async () => {
      const error = gatewayErrorOf(await failureOf(() => ask(gw.client, 'lb-tools')))

      expect(error).toMatchObject({ status: 404, code: 'model_not_found' })
    })
  })
})

describe('the trace', () => {
  const tracer = () => new Tracer(new RedisSpanWriter(gw.redis, gw.prefix))

  it('holds the system\'s step with the gateway\'s call nested under it, both in the gateway\'s span format', async () => {
    const run = visitorRun()

    await runScope(run, () => tracer().span('generate graph', () => ask()))

    const spans = await gw.runSpans(run.runId)
    for (const span of spans) expect(spanSchema.parse(span)).toEqual(span)
    const step = spans.find(span => span.kind === 'system.step')
    const call = spans.find(span => span.kind === 'gateway.call')
    expect(step).toMatchObject({ name: 'generate graph', runId: run.runId, system: 'lb-08', status: 'ok' })
    expect(call?.parentId).toBe(step?.spanId)
    expect(call).toMatchObject({ name: 'lb-fast', status: 'ok', attrs: { alias: 'lb-fast', dataClass: 'visitor' } })
    // The gateway's attempt spans hang under its call span, one level further down.
    const attempts = spans.filter(span => span.kind === 'gateway.attempt')
    expect(attempts.length).toBeGreaterThan(0)
    expect(attempts.every(span => span.parentId === call?.spanId)).toBe(true)
  })

  it('nests a call under the innermost step that made it', async () => {
    const run = visitorRun()

    await runScope(run, () => tracer().span('describe workflow', () => tracer().span('generate graph', () => ask())))

    const spans = await gw.runSpans(run.runId)
    const outer = spans.find(span => span.name === 'describe workflow')
    const inner = spans.find(span => span.name === 'generate graph')
    const call = spans.find(span => span.kind === 'gateway.call')
    expect(inner?.parentId).toBe(outer?.spanId)
    expect(call?.parentId).toBe(inner?.spanId)
    expect(outer?.parentId).toBeUndefined()
  })

  it('records a step whose call failed as an error, with the error\'s name and no text', async () => {
    const run = visitorRun()
    gw.provider.enqueue({ status: 500, body: { error: { message: 'a private description leaked here' } } })

    await runScope(run, () => failureOf(() => tracer().span('generate graph', () => ask())))

    const spans = await gw.runSpans(run.runId)
    expect(spans.find(span => span.kind === 'system.step')).toMatchObject({ status: 'error', attrs: { error: 'AI_APICallError' } })
    expect(JSON.stringify(spans)).not.toContain('private')
  })

  it('reads back through the gateway\'s Scope route, nested and finished, with nothing a visitor or a model said', async () => {
    const run = visitorRun()
    gw.provider.enqueue({ status: 500, body: { error: { message: 'bad request: my gate code is 4471-PRIVATE-TICKET-TEXT' } } })
    gw.provider.answerNext('PRIVATE-ANSWER-TEXT: refund approved for Sam Carter')

    await runScope(run, () => tracer().span('support ticket', async () => {
      await tracer().span('classify', async (step) => {
        step.set('category', 'damaged')
        await generateText({ model: gw.client.chat('lb-fast'), prompt: 'my gate code is 4471-PRIVATE-TICKET-TEXT', maxRetries: 0 }).catch(() => undefined)
        await ask()
      })
    }, { kind: 'system.run', attrs: { language: 'en' } }))

    const response = await gw.readTrace(run.runId)
    const page = await response.json() as { runId: string, spans: unknown[], cursor: string, more: boolean, finished: boolean }

    expect(response.status).toBe(200)
    // The route's own checks and this package's schema describe one format.
    const spans = page.spans.map(span => spanSchema.parse(span))
    expect(page).toMatchObject({ runId: run.runId, more: false, finished: true })
    expect(spans.map(span => span.kind).filter(kind => kind.startsWith('system'))).toEqual(['system.step', 'system.run'])
    const root = spans.find(span => span.kind === 'system.run')
    const step = spans.find(span => span.name === 'classify')
    const calls = spans.filter(span => span.kind === 'gateway.call')
    expect(root).toMatchObject({ name: 'support ticket', attrs: { language: 'en' } })
    expect(root?.parentId).toBeUndefined()
    expect(step?.parentId).toBe(root?.spanId)
    expect(calls).toHaveLength(2)
    expect(calls.every(call => call.parentId === step?.spanId)).toBe(true)
    // The cursor of a finished run hands back nothing new.
    const later = await (await gw.readTrace(run.runId, `after=${page.cursor}`)).json() as typeof page
    expect(later).toMatchObject({ spans: [], finished: true, cursor: page.cursor })
    const body = JSON.stringify(page)
    for (const words of ['PRIVATE-TICKET-TEXT', 'PRIVATE-ANSWER-TEXT', 'Sam Carter', 'gate code']) expect(body).not.toContain(words)
  })

  it('shows a reader nothing of a run of a system it may not read, as if the run were not there', async () => {
    const other = createRun({ system: 'lb-08', runId: newRunId(), session: 'session-0123456789abcdef' })
    await runScope(other, () => tracer().span('support ticket', () => ask(), { kind: 'system.run' }))
    // The contract routing lets `web` read LB-08, so write a run of a system it does not list.
    await gw.redis.xadd(`${gw.prefix}run:other-system-run:spans`, '*', 'span', JSON.stringify({
      v: 1, runId: 'other-system-run', system: 'lb-03', spanId: '00000000000000a1', kind: 'system.run', name: 'invoice', status: 'ok', startMs: 1, endMs: 2, attrs: {},
    }))

    expect((await gw.readTrace(other.runId)).status).toBe(200)
    expect((await gw.readTrace('other-system-run')).status).toBe(404)
  })

  it('keeps two runs that overlap apart, each with its own spans and its own calls', async () => {
    const [first, second] = [visitorRun(), visitorRun()]

    await Promise.all([
      runScope(first, () => tracer().span('first run', () => ask())),
      runScope(second, () => tracer().span('second run', () => ask())),
    ])

    for (const [run, name] of [[first, 'first run'], [second, 'second run']] as const) {
      const spans = await gw.runSpans(run.runId)
      expect(spans.filter(span => span.kind === 'system.step').map(span => span.name)).toEqual([name])
      expect(spans.filter(span => span.kind === 'gateway.call')).toHaveLength(1)
      expect(new Set(spans.map(span => span.runId))).toEqual(new Set([run.runId]))
    }
  })
})
