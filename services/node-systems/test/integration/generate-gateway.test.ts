// LB-08's describe pipeline against the real gateway: services/gateway's own app, on a real
// Redis, in front of a fake provider. A scripted model can't show that the request the
// pipeline builds is one the gateway accepts, or that the calls it makes land in the
// right quotas and the right trace. This can: what the service sends is checked by the
// gateway's own checks, and what the provider receives is read off the wire.
import { randomBytes } from 'node:crypto'

import { createRun, gatewayErrorOf, newRunId, RedisSpanWriter, runScope, Tracer } from '@lb/common'
import { GRAPH_LIMITS, validateWorkflow } from '@lb/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'

import { GatewayJsonModel } from '../../src/modules/lb08/generate/model.ts'
import { createDescribeWorkflow } from '../../src/modules/lb08/generate/pipeline.ts'
import { describeUserMessage } from '../../src/modules/lb08/generate/prompts.ts'
import { startContractGateway } from '../../../../packages/common/test/support/contract-gateway.ts'
import type { ContractGateway } from '../../../../packages/common/test/support/contract-gateway.ts'
import { loadSamples } from '../support/data.ts'

let gw: ContractGateway

beforeAll(async () => {
  gw = await startContractGateway(inject('redisUrl'), new URL('../support/routing.lb08.yaml', import.meta.url))
})

afterAll(async () => {
  await gw.close()
})

beforeEach(() => {
  gw.provider.reset()
})

const wholesale = (() => {
  const found = loadSamples().find(sample => sample.id === 'wholesale-order')
  if (!found) throw new Error('The wholesale sample is missing.')
  return found
})()

/** Makes a visitor's run of its own, so no test spends another's daily calls. */
function visitorRun() {
  return createRun({ system: 'lb-08', runId: newRunId(), session: `session-${randomBytes(8).toString('hex')}` })
}

/** Builds the real pipeline over the gateway client, tracing to the gateway's own Redis streams. */
function pipeline() {
  return createDescribeWorkflow({ model: new GatewayJsonModel(gw.client.chat('lb-tools')), tracer: new Tracer(new RedisSpanWriter(gw.redis, gw.prefix)) })
}

/** The graph of a sample as the text a model would write. */
const goodAnswer = JSON.stringify(wholesale.graph)
/** A workflow the model might write that validation refuses. */
const badAnswer = JSON.stringify({ name: 'Text the owner', nodes: [{ id: 'order_in', type: 'trigger', label: 'Order', event: 'wholesale_order' }, { id: 'text_owner', type: 'action', label: 'Text', connector: 'sms', params: {} }], edges: [{ from: 'order_in', to: 'text_owner' }] })

describe('describing a workflow through the gateway', () => {
  it('sends one call, as the gateway expects it, and stores what the model wrote', async () => {
    gw.provider.answerNext(goodAnswer)
    const run = visitorRun()

    const outcome = await runScope(run, () => pipeline()(wholesale.description))

    expect(outcome).toMatchObject({ status: 'accepted', modelCalls: 1 })
    expect(gw.provider.requests).toHaveLength(1)
    const sent = gw.provider.requests[0]?.body as { messages: { role: string, content: string }[], [key: string]: unknown }
    expect(sent).toMatchObject({ model: 'alpha/small-model', max_completion_tokens: 2048, temperature: 0 })
    expect(sent).not.toHaveProperty('response_format')
    expect(sent.messages.map(message => message.role)).toEqual(['system', 'user'])
    expect(sent.messages[0]?.content).toContain('untrusted data')
    expect(sent.messages[1]?.content).toBe(describeUserMessage(wholesale.description))
    expect(gw.provider.requests[0]?.headers.authorization).toBe('Bearer alpha-key')
  })

  it('reads a model that wraps its JSON in a Markdown fence', async () => {
    gw.provider.answerNext(`Here you go:\n\`\`\`json\n${goodAnswer}\n\`\`\``)

    const outcome = await runScope(visitorRun(), () => pipeline()(wholesale.description))

    expect(outcome).toMatchObject({ status: 'accepted', modelCalls: 1 })
  })

  it('repairs once, in a second call that quotes the first answer and its problems', async () => {
    gw.provider.answerNext(badAnswer)
    gw.provider.answerNext(goodAnswer)

    const outcome = await runScope(visitorRun(), () => pipeline()('When a wholesale order arrives, text the owner by SMS.'))

    expect(outcome).toMatchObject({ status: 'accepted', modelCalls: 2 })
    const repair = (gw.provider.requests[1]?.body as { messages: { role: string, content: string }[] }).messages
    expect(repair.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(repair[2]?.content).toBe(JSON.stringify(JSON.parse(badAnswer)))
    expect(repair[3]?.content).toContain('Problems:')
  })

  it('stops after the repair: two refusals are final, and the gateway sees exactly two calls', async () => {
    gw.provider.answerNext(badAnswer)
    gw.provider.answerNext(badAnswer)
    const run = visitorRun()

    const outcome = await runScope(run, () => pipeline()('When a wholesale order arrives, text the owner by SMS.'))

    expect(outcome.status).toBe('rejected')
    expect(outcome.modelCalls).toBe(2)
    expect(gw.provider.requests).toHaveLength(2)
    const calls = (await gw.runSpans(run.runId)).filter(span => span.kind === 'gateway.call')
    expect(calls).toHaveLength(2)
  })

  it('is within the gateway\'s input limit even in the worst case: the repair of the longest description after a huge reply', async () => {
    gw.provider.answerNext(JSON.stringify({ name: 'Huge', junk: 'x'.repeat(30_000) }))
    gw.provider.answerNext(goodAnswer)
    const description = `${'When a wholesale order arrives, alert the roastery on Slack. '.repeat(30)}`.slice(0, GRAPH_LIMITS.maxDescriptionLength)

    const outcome = await runScope(visitorRun(), () => pipeline()(description))

    expect(outcome).toMatchObject({ status: 'accepted', modelCalls: 2 })
  })

  it('nests each gateway call under the pipeline step that made it, all in one trace', async () => {
    gw.provider.answerNext(badAnswer)
    gw.provider.answerNext(goodAnswer)
    const run = visitorRun()

    await runScope(run, () => pipeline()('When a wholesale order arrives, text the owner by SMS.'))

    const spans = await gw.runSpans(run.runId)
    const describe = spans.find(span => span.name === 'describe')
    const generate = spans.find(span => span.name === 'generate')
    const repair = spans.find(span => span.name === 'repair')
    const calls = spans.filter(span => span.kind === 'gateway.call')
    expect(describe).toMatchObject({ kind: 'system.run', system: 'lb-08', attrs: { calls: 2, outcome: 'accepted' } })
    expect(generate?.parentId).toBe(describe?.spanId)
    expect(repair?.parentId).toBe(describe?.spanId)
    expect(calls.map(call => call.parentId)).toEqual([generate?.spanId, repair?.spanId])
    expect(calls.every(call => (call.attrs as { alias: string }).alias === 'lb-tools')).toBe(true)
    // Nothing the visitor wrote reaches the trace.
    expect(JSON.stringify(spans)).not.toContain('SMS')
  })

  it('serves the trace to the site\'s server, which the Scope reads it as, and calls it finished once the pipeline\'s root span is written', async () => {
    gw.provider.answerNext(goodAnswer)
    const run = visitorRun()

    await runScope(run, () => pipeline()(wholesale.description))

    // A routing table that lists no trace readers (or leaves `web` out) refuses this read with 403, which the site shows as a 502.
    const answer = await gw.readTrace(run.runId)
    expect(answer.status).toBe(200)
    const trace = await answer.json() as { finished: boolean, spans: { kind: string, name: string }[] }
    expect(trace.finished).toBe(true)
    expect(trace.spans.map(span => span.name)).toEqual(expect.arrayContaining(['describe', 'generate']))
  })

  it('reaches the caller as the gateway\'s own code when the provider is down, and spends no repair on it', async () => {
    gw.provider.enqueue({ status: 500, body: { error: { message: 'a private description leaked here' } } })

    const failure = await runScope(visitorRun(), () => pipeline()(wholesale.description).catch((error: unknown) => error))

    expect(gatewayErrorOf(failure)).toMatchObject({ status: 502, code: 'upstream_failed' })
    expect(gatewayErrorOf(failure)?.message).not.toContain('private')
  })

  it('counts a visitor\'s calls, not their descriptions: thirty calls a day, then the gateway refuses with its own code', async () => {
    const session = `session-${randomBytes(8).toString('hex')}`
    const describeAsVisitor = () => runScope(createRun({ system: 'lb-08', runId: newRunId(), session }), () => pipeline()(wholesale.description))
    // Fifteen descriptions that each need their repair use the thirty calls.
    for (let described = 0; described < 15; described += 1) {
      gw.provider.answerNext(badAnswer)
      gw.provider.answerNext(goodAnswer)
      expect(await describeAsVisitor()).toMatchObject({ status: 'accepted', modelCalls: 2 })
    }
    const before = gw.provider.requests.length

    const refusal = await describeAsVisitor().catch((error: unknown) => error)

    expect(gatewayErrorOf(refusal)).toMatchObject({ status: 429, code: 'quota_exceeded' })
    expect(gw.provider.requests).toHaveLength(before)
  })

  it('checks the workflow itself, whatever the gateway says: the stored graph is the validated one', async () => {
    gw.provider.answerNext(goodAnswer)

    const outcome = await runScope(visitorRun(), () => pipeline()(wholesale.description))

    expect(outcome.status).toBe('accepted')
    if (outcome.status === 'accepted') expect(validateWorkflow(outcome.graph).ok).toBe(true)
  })
})
