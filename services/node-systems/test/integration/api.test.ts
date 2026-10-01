// Tests for LB-08's HTTP API, end to end through the real app: visitor tokens, request
// checking, every route's answers and errors, the visitor's limits, and what another
// visitor can and can't see. The database is real, the queue is driven by hand, and the model
// behind "describe a workflow" is a script.
import { randomBytes } from 'node:crypto'

import { GatewayCallError, Tracer } from '@lb/common'
import { buildCatalogue, runEventSchema, workflowViewSchema } from '@lb/contracts'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { SECURITY_HEADERS } from '../../src/core/security-headers.ts'
import { createDescribeWorkflow } from '../../src/modules/lb08/generate/pipeline.ts'
import type { ModelReply } from '../../src/modules/lb08/generate/prompts.ts'
import { createApiHarness } from '../support/api.ts'
import type { ApiHarness } from '../support/api.ts'
import { loadSamples } from '../support/data.ts'
import { drive, MemorySpans } from '../support/engine.ts'
import { ScriptedModel } from '../support/fake-model.ts'

// What the scripted model says next: the test sets it, and the model hands each reply out once.
let said: (ModelReply | Error)[] = []
const model = new ScriptedModel(() => {
  const next = said.shift()
  if (next === undefined) throw new Error('The model was asked, but nothing was scripted.')
  if (next instanceof Error) throw next
  return next
})

let api: ApiHarness

beforeAll(async () => {
  const describeWorkflow = createDescribeWorkflow({ model, tracer: new Tracer(new MemorySpans()) })
  api = await createApiHarness(inject('databaseUrl'), describeWorkflow)
})

afterAll(async () => {
  await api.close()
})

/** Makes a visitor session of its own. */
function newSession(): string {
  return `session-${randomBytes(8).toString('hex')}`
}

const wholesale = (() => {
  const found = loadSamples().find(sample => sample.id === 'wholesale-order')
  if (!found) throw new Error('missing sample')
  return found
})()

/** Makes a workflow from a sample through the API, and returns its id. */
async function fromSample(session: string, sampleId: string): Promise<string> {
  const response = await api.call('POST', '/workflows', session, { from: 'sample', sampleId })
  expect(response.statusCode).toBe(201)
  return response.json().id as string
}

/** Starts a run through the API with the sample's own payload, and returns its id. */
async function startRun(session: string, workflowId: string, sampleId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const sample = loadSamples().find(candidate => candidate.id === sampleId)
  const response = await api.call('POST', `/workflows/${workflowId}/runs`, session, { input: sample?.input, ...extra })
  expect(response.statusCode, response.body).toBe(202)
  return response.json().id as string
}

describe('who may call', () => {
  const routes: [method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string][] = [
    ['GET', '/catalogue'],
    ['GET', '/samples'],
    ['GET', '/limits'],
    ['POST', '/workflows'],
    ['GET', '/workflows'],
    ['GET', '/workflows/11111111-1111-4111-8111-111111111111'],
    ['PUT', '/workflows/11111111-1111-4111-8111-111111111111'],
    ['DELETE', '/workflows/11111111-1111-4111-8111-111111111111'],
    ['POST', '/workflows/11111111-1111-4111-8111-111111111111/runs'],
    ['GET', '/runs'],
    ['GET', '/runs/11111111-1111-4111-8111-111111111111'],
    ['GET', '/runs/11111111-1111-4111-8111-111111111111/events'],
    ['POST', '/runs/11111111-1111-4111-8111-111111111111/replay'],
    ['POST', '/runs/11111111-1111-4111-8111-111111111111/steps/a/decision'],
    ['GET', '/sent'],
    ['GET', '/dead-letters'],
    ['POST', '/dead-letters/11111111-1111-4111-8111-111111111111/replay'],
  ]

  it.each(routes)('answers %s %s with 401 and no token', async (method, url) => {
    const response = await api.call(method, url, undefined, method === 'GET' || method === 'DELETE' ? undefined : {})

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: { code: 'unauthorized', message: 'This route needs a valid visitor token for its system.' } })
  })

  it('answers 401 for a token minted for another system', async () => {
    const response = await api.app.inject({ url: '/api/lb08/limits', headers: { authorization: `Bearer ${api.tokenFor(newSession(), 'lb-01')}` } })

    expect(response.statusCode).toBe(401)
  })

  it('puts the security headers on every answer, errors included', async () => {
    for (const response of [await api.call('GET', '/limits', newSession()), await api.call('GET', '/limits', undefined), await api.call('GET', '/runs/not-a-uuid', newSession())]) {
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(response.headers[name], name).toBe(value)
    }
  })
})

describe('what LB-08 offers', () => {
  it('lists what a workflow may be made of, from the same lists the validator uses', async () => {
    const response = await api.call('GET', '/catalogue', newSession())

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(buildCatalogue())
  })

  it('lists the curated samples with the event that starts each and a payload to test it with', async () => {
    const response = await api.call('GET', '/samples', newSession())

    expect(response.statusCode).toBe(200)
    const samples = response.json() as { id: string, event: string, language: string, input: Record<string, unknown> }[]
    expect(samples.map(sample => sample.id)).toEqual(['wholesale-order', 'low-stock-reorder', 'refund-approval', 'wholesale-order-cs'])
    expect(samples.find(sample => sample.id === 'refund-approval')).toMatchObject({ event: 'refund_request', language: 'en', input: { amountEur: 120 } })
    expect(samples.find(sample => sample.id === 'wholesale-order-cs')?.language).toBe('cs')
  })

  it('shows a fresh visitor all their allowances, and when they reset', async () => {
    const response = await api.call('GET', '/limits', newSession())

    expect(response.json()).toMatchObject({ runs: { limit: 10, used: 0, remaining: 10 }, generations: { limit: 10, used: 0, remaining: 10 } })
    expect(Date.parse(response.json().resetsAt)).toBeGreaterThan(Date.now())
  })
})

describe('making a workflow', () => {
  it('copies a sample for the visitor, at no cost', async () => {
    const session = newSession()

    const response = await api.call('POST', '/workflows', session, { from: 'sample', sampleId: 'wholesale-order' })

    expect(response.statusCode).toBe(201)
    const workflow = workflowViewSchema.parse(response.json())
    expect(workflow).toMatchObject({ name: 'Wholesale order over €500', version: 1, description: null })
    expect(workflow.graph).toEqual(wholesale.graph)
    expect(workflow.versions).toMatchObject([{ version: 1, origin: 'sample', modelCalls: 0, traceRunId: null }])
    expect(Date.parse(workflow.expiresAt) - Date.parse(workflow.createdAt)).toBe(24 * 3_600_000)
    expect((await api.call('GET', '/limits', session)).json().generations.used).toBe(0)
  })

  it('answers 404 for a sample that does not exist, and 422 for a request that is neither a description nor a sample', async () => {
    const session = newSession()

    const unknown = await api.call('POST', '/workflows', session, { from: 'sample', sampleId: 'no-such-sample' })
    const both = await api.call('POST', '/workflows', session, { from: 'sample', sampleId: 'wholesale-order', description: 'also this, please' })
    const short = await api.call('POST', '/workflows', session, { from: 'description', description: 'too short' })

    expect(unknown.statusCode).toBe(404)
    expect(unknown.json().error.code).toBe('unknown_sample')
    expect(both.statusCode).toBe(422)
    expect(both.json().error.code).toBe('invalid_request')
    expect(short.statusCode).toBe(422)
  })

  it('describes a workflow with the model, and saves what validation accepted, with the trace it was made under', async () => {
    const session = newSession()
    said = [{ kind: 'json', value: wholesale.graph }]

    const response = await api.call('POST', '/workflows', session, { from: 'description', description: wholesale.description })

    expect(response.statusCode).toBe(201)
    const workflow = response.json()
    expect(workflow.description).toBe(wholesale.description)
    expect(workflow.versions).toMatchObject([{ version: 1, origin: 'generated', modelCalls: 1 }])
    expect(workflow.versions[0].traceRunId).toMatch(/^[\w-]{8,64}$/)
    expect((await api.call('GET', '/limits', session)).json().generations).toEqual(expect.objectContaining({ used: 1, remaining: 9 }))
  })

  it('refuses, with the problems found and nothing saved, a description the model could not turn into a valid workflow', async () => {
    const session = newSession()
    const invalid = { name: 'Text the owner', nodes: [{ id: 'a', type: 'trigger', label: 'Order', event: 'wholesale_order' }, { id: 'b', type: 'action', label: 'Text', connector: 'sms', params: {} }], edges: [{ from: 'a', to: 'b' }] }
    said = [{ kind: 'json', value: invalid }, { kind: 'json', value: invalid }]

    const response = await api.call('POST', '/workflows', session, { from: 'description', description: 'When an order arrives, text the owner by SMS.' })

    expect(response.statusCode).toBe(422)
    const { error } = response.json()
    expect(error.code).toBe('workflow_rejected')
    expect(error.problems.map((problem: { code: string }) => problem.code)).toContain('unknown_connector')
    expect((await api.call('GET', '/workflows', session)).json()).toEqual([])
    // The description used its calls, so it counts.
    expect((await api.call('GET', '/limits', session)).json().generations.used).toBe(1)
  })

  it('gives the description back, and says to try a sample, when the model cannot be reached', async () => {
    const session = newSession()
    said = [new GatewayCallError('upstream_failed', 502, 30)]

    const response = await api.call('POST', '/workflows', session, { from: 'description', description: wholesale.description })

    expect(response.statusCode).toBe(503)
    expect(response.json().error).toMatchObject({ code: 'generation_unavailable' })
    expect(response.json().error.message).toContain('samples')
    expect(response.headers['retry-after']).toBe('30')
    expect((await api.call('GET', '/limits', session)).json().generations.used).toBe(0)
  })

  it('allows ten descriptions a day, and says when the allowance returns', async () => {
    const session = newSession()
    for (let described = 0; described < 10; described += 1) {
      said = [{ kind: 'json', value: wholesale.graph }]
      expect((await api.call('POST', '/workflows', session, { from: 'description', description: wholesale.description })).statusCode).toBe(201)
      // Keep the visitor under the limit on workflows kept, so only the daily allowance is tested.
      const [made] = (await api.call('GET', '/workflows', session)).json()
      await api.call('DELETE', `/workflows/${made.id}`, session)
    }
    said = [{ kind: 'json', value: wholesale.graph }]

    const response = await api.call('POST', '/workflows', session, { from: 'description', description: wholesale.description })

    expect(response.statusCode).toBe(429)
    expect(response.json().error.code).toBe('daily_limit')
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0)
    expect(said).toHaveLength(1)
  })

  it('keeps twenty workflows a visitor, and says so before spending a model call on the twenty-first', async () => {
    const session = newSession()
    for (let made = 0; made < 20; made += 1) await fromSample(session, 'low-stock-reorder')
    said = [{ kind: 'json', value: wholesale.graph }]

    const response = await api.call('POST', '/workflows', session, { from: 'description', description: wholesale.description })

    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('workflow_limit')
    expect(said).toHaveLength(1)
    expect((await api.call('GET', '/limits', session)).json().generations.used).toBe(0)
  })

  it('refuses text no database could store, before any route sees it', async () => {
    const response = await api.app.inject({
      method: 'POST',
      url: '/api/lb08/workflows',
      headers: { 'authorization': `Bearer ${api.tokenFor(newSession())}`, 'content-type': 'application/json' },
      payload: '{"from": "description", "description": "When an order arrives, alert the roastery\\u0000 now."}',
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().error.code).toBe('invalid_request')
  })
})

describe('reading and editing workflows', () => {
  it('lists a visitor\'s workflows newest first, and shows one in full', async () => {
    const session = newSession()
    const first = await fromSample(session, 'low-stock-reorder')
    const second = await fromSample(session, 'refund-approval')

    const list = (await api.call('GET', '/workflows', session)).json()
    const one = await api.call('GET', `/workflows/${first}`, session)

    expect(list.map((workflow: { id: string }) => workflow.id)).toEqual([second, first])
    expect(one.statusCode).toBe(200)
    expect(one.json()).toMatchObject({ id: first, name: 'Low stock reorder' })
  })

  it('saves an edit as a new version, and refuses an edit that started from an old one', async () => {
    const session = newSession()
    const id = await fromSample(session, 'low-stock-reorder')
    const graph = (await api.call('GET', `/workflows/${id}`, session)).json().graph

    const saved = await api.call('PUT', `/workflows/${id}`, session, { baseVersion: 1, graph: { ...graph, name: 'Low stock, edited' } })
    const stale = await api.call('PUT', `/workflows/${id}`, session, { baseVersion: 1, graph })

    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toMatchObject({ name: 'Low stock, edited', version: 2 })
    expect(saved.json().versions.map((version: { version: number, origin: string }) => [version.version, version.origin])).toEqual([[2, 'edited'], [1, 'sample']])
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error.code).toBe('version_conflict')
  })

  it('checks an edited graph as strictly as the model\'s: a loop is refused with the problem named', async () => {
    const session = newSession()
    const id = await fromSample(session, 'wholesale-order')
    const graph = (await api.call('GET', `/workflows/${id}`, session)).json().graph
    const looped = { ...graph, edges: [...graph.edges, { from: 'email_cafe', to: 'check_stock' }] }

    const response = await api.call('PUT', `/workflows/${id}`, session, { baseVersion: 1, graph: looped })

    expect(response.statusCode).toBe(422)
    expect(response.json().error.code).toBe('workflow_invalid')
    expect(response.json().error.problems.map((problem: { code: string }) => problem.code)).toContain('cycle')
    expect((await api.call('GET', `/workflows/${id}`, session)).json().version).toBe(1)
  })

  it('refuses a graph that is not even shaped like one, naming the fields and never quoting them', async () => {
    const session = newSession()
    const id = await fromSample(session, 'low-stock-reorder')

    const response = await api.call('PUT', `/workflows/${id}`, session, { baseVersion: 1, graph: { name: 'x', nodes: 'PRIVATE-MARKER', edges: [] } })

    expect(response.statusCode).toBe(422)
    expect(response.json().error.code).toBe('invalid_request')
    expect(response.body).not.toContain('PRIVATE-MARKER')
  })

  it('deletes a workflow, and every run of it', async () => {
    const session = newSession()
    const id = await fromSample(session, 'low-stock-reorder')
    const runId = await startRun(session, id, 'low-stock-reorder')
    await drive(api.engine)

    const deleted = await api.call('DELETE', `/workflows/${id}`, session)

    expect(deleted.statusCode).toBe(204)
    expect(deleted.body).toBe('')
    expect((await api.call('GET', `/workflows/${id}`, session)).statusCode).toBe(404)
    expect((await api.call('GET', `/runs/${runId}`, session)).statusCode).toBe(404)
    expect((await api.call('DELETE', `/workflows/${id}`, session)).statusCode).toBe(404)
  })
})

describe('running a workflow', () => {
  it('queues a run and answers at once, then shows each step and the whole log as the workers get through it', async () => {
    const session = newSession()
    const workflowId = await fromSample(session, 'wholesale-order')

    const started = await api.call('POST', `/workflows/${workflowId}/runs`, session, { input: wholesale.input })

    expect(started.statusCode).toBe(202)
    const queued = started.json()
    expect(queued).toMatchObject({ status: 'queued', workflowId, workflowName: 'Wholesale order over €500', version: 1, replayOf: null, replayedBy: null, input: wholesale.input })
    expect(queued.rootRunId).toBe(queued.id)
    expect(queued.steps.map((step: { nodeId: string, status: string }) => `${step.nodeId}:${step.status}`)).toEqual([
      'order_received:succeeded', 'big_order:succeeded', 'check_stock:queued', 'alert_roastery:pending', 'email_cafe:pending',
    ])

    await drive(api.engine)
    const done = (await api.call('GET', `/runs/${queued.id}`, session)).json()

    expect(done.status).toBe('succeeded')
    expect(done.events.map((event: { seq: number }) => event.seq)).toEqual(Array.from({ length: done.events.length }, (_, index) => index + 1))
    for (const event of done.events) expect(runEventSchema.safeParse(event).success).toBe(true)
    expect(done.steps.find((step: { nodeId: string }) => step.nodeId === 'check_stock')).toMatchObject({ status: 'succeeded', attempts: 1, output: { inStock: true, etaDays: 2 }, error: null })
    expect((await api.call('GET', '/runs', session)).json()).toMatchObject([{ id: queued.id, status: 'succeeded' }])
  })

  it('lets a page follow a run by asking for the events after the last one it saw', async () => {
    const session = newSession()
    const workflowId = await fromSample(session, 'low-stock-reorder')
    const runId = await startRun(session, workflowId, 'low-stock-reorder')

    const early = (await api.call('GET', `/runs/${runId}/events`, session)).json()
    await drive(api.engine)
    const later = (await api.call('GET', `/runs/${runId}/events?after=${early.events.at(-1).seq}`, session)).json()
    const none = (await api.call('GET', `/runs/${runId}/events?after=9999`, session)).json()

    expect(early.status).toBe('queued')
    expect(early.events.map((event: { type: string }) => event.type)).toEqual(['run.queued', 'step.succeeded'])
    expect(later.status).toBe('succeeded')
    expect(later.events[0].seq).toBe(early.events.length + 1)
    expect(later.events.at(-1).type).toBe('run.succeeded')
    expect(none).toEqual({ status: 'succeeded', events: [] })
    expect((await api.call('GET', `/runs/${runId}/events?after=-1`, session)).statusCode).toBe(422)
    expect((await api.call('GET', `/runs/${runId}/events?after=abc`, session)).statusCode).toBe(422)
    expect((await api.call('GET', `/runs/${runId}/events?extra=1`, session)).statusCode).toBe(422)
  })

  it('checks the test payload against the trigger\'s event, names the fields at fault, and spends no run on it', async () => {
    const session = newSession()
    const workflowId = await fromSample(session, 'wholesale-order')

    const response = await api.call('POST', `/workflows/${workflowId}/runs`, session, { input: { ...wholesale.input, contactEmail: 'someone@gmail.com', totalEur: -5 } })

    expect(response.statusCode).toBe(422)
    expect(response.json().error).toMatchObject({ code: 'invalid_input', fields: 'contactEmail, totalEur' })
    expect(response.body).not.toContain('gmail')
    expect((await api.call('GET', '/limits', session)).json().runs.used).toBe(0)
  })

  it('refuses a request body with a field nobody defined', async () => {
    const session = newSession()
    const workflowId = await fromSample(session, 'wholesale-order')

    const response = await api.call('POST', `/workflows/${workflowId}/runs`, session, { input: wholesale.input, runAsAdmin: true })

    expect(response.statusCode).toBe(422)
    expect(response.json().error.code).toBe('invalid_request')
  })

  it('allows ten runs a day and answers the eleventh with 429 and Retry-After', async () => {
    const session = newSession()
    const workflowId = await fromSample(session, 'low-stock-reorder')
    for (let run = 0; run < 10; run += 1) await startRun(session, workflowId, 'low-stock-reorder')

    const response = await api.call('POST', `/workflows/${workflowId}/runs`, session, { input: loadSamples().find(sample => sample.id === 'low-stock-reorder')?.input })

    expect(response.statusCode).toBe(429)
    expect(response.json().error.code).toBe('daily_limit')
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0)
    await drive(api.engine)
  })

  it('walks an approval through the API: it waits, it is answered once, and the run carries on', async () => {
    const session = newSession()
    const workflowId = await fromSample(session, 'refund-approval')
    const runId = await startRun(session, workflowId, 'refund-approval')

    const waiting = (await api.call('GET', `/runs/${runId}`, session)).json()
    expect(waiting.status).toBe('awaiting_approval')
    expect(waiting.steps.find((step: { nodeId: string }) => step.nodeId === 'finance_ok')).toMatchObject({ status: 'awaiting_approval', output: { question: 'Approve a refund of €120 for order BB-1043?' } })

    const decided = await api.call('POST', `/runs/${runId}/steps/finance_ok/decision`, session, { decision: 'approved' })
    await drive(api.engine)
    const again = await api.call('POST', `/runs/${runId}/steps/finance_ok/decision`, session, { decision: 'rejected' })
    const nonsense = await api.call('POST', `/runs/${runId}/steps/finance_ok/decision`, session, { decision: 'maybe' })

    expect(decided.statusCode).toBe(200)
    expect(decided.json().steps.find((step: { nodeId: string }) => step.nodeId === 'finance_ok').status).toBe('succeeded')
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('not_waiting')
    expect(nonsense.statusCode).toBe(422)
    expect((await api.call('GET', `/runs/${runId}`, session)).json().status).toBe('succeeded')
  })
})

describe('making it fail, and putting it right', () => {
  it('shows a step\'s retries, parks it in the dead-letter queue, and replays it in one click', async () => {
    const session = newSession()
    const workflowId = await fromSample(session, 'wholesale-order')
    const runId = await startRun(session, workflowId, 'wholesale-order', { failures: [{ nodeId: 'alert_roastery', times: 3 }] })
    await drive(api.engine)

    const failed = (await api.call('GET', `/runs/${runId}`, session)).json()
    const letters = (await api.call('GET', '/dead-letters', session)).json()

    expect(failed.status).toBe('failed')
    expect(failed.events.filter((event: { type: string }) => event.type === 'step.failed')).toHaveLength(3)
    expect(letters).toMatchObject([{ runId, workflowId, nodeId: 'alert_roastery', attempts: 3, error: { code: 'connector_unavailable', message: 'The connector is unavailable.' }, replayedRunId: null }])
    expect((await api.call('GET', `/sent?rootRunId=${runId}`, session)).json()).toHaveLength(1)

    const replay = await api.call('POST', `/dead-letters/${letters[0].id}/replay`, session)
    await drive(api.engine)
    const replayed = (await api.call('GET', `/runs/${replay.json().id}`, session)).json()
    const again = await api.call('POST', `/dead-letters/${letters[0].id}/replay`, session)

    expect(replay.statusCode).toBe(202)
    expect(replayed).toMatchObject({ status: 'succeeded', replayOf: runId, rootRunId: runId })
    expect(replayed.events.some((event: { type: string }) => event.type === 'effect.duplicate_suppressed')).toBe(true)
    expect((await api.call('GET', `/sent?rootRunId=${runId}`, session)).json()).toHaveLength(2)
    expect((await api.call('GET', `/runs/${runId}`, session)).json().replayedBy).toBe(replay.json().id)
    expect((await api.call('GET', '/dead-letters', session)).json()[0].replayedRunId).toBe(replay.json().id)
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('already_replayed')
  })

  it('replays any finished run, and refuses one that is still going', async () => {
    const session = newSession()
    const workflowId = await fromSample(session, 'low-stock-reorder')
    const runId = await startRun(session, workflowId, 'low-stock-reorder')

    const early = await api.call('POST', `/runs/${runId}/replay`, session)
    await drive(api.engine)
    const late = await api.call('POST', `/runs/${runId}/replay`, session)

    expect(early.statusCode).toBe(409)
    expect(early.json().error.code).toBe('run_not_finished')
    expect(late.statusCode).toBe(202)
    await drive(api.engine)
  })

  it('refuses failures asked for on a step that is not an action, or on a step twice', async () => {
    const session = newSession()
    const workflowId = await fromSample(session, 'wholesale-order')

    const notAnAction = await api.call('POST', `/workflows/${workflowId}/runs`, session, { input: wholesale.input, failures: [{ nodeId: 'big_order', times: 1 }] })
    const tooMany = await api.call('POST', `/workflows/${workflowId}/runs`, session, { input: wholesale.input, failures: [{ nodeId: 'check_stock', times: 6 }] })

    expect(notAnAction.statusCode).toBe(422)
    expect(notAnAction.json().error.code).toBe('invalid_failure')
    expect(tooMany.statusCode).toBe(422)
    expect(tooMany.json().error.code).toBe('invalid_request')
  })
})

describe('one visitor against another', () => {
  it('shows Bob nothing of Alice\'s, whichever route he asks, and answers the same 404 whether a thing exists or not', async () => {
    const alice = newSession()
    const bob = newSession()
    const workflowId = await fromSample(alice, 'wholesale-order')
    const runId = await startRun(alice, workflowId, 'wholesale-order', { failures: [{ nodeId: 'alert_roastery', times: 3 }] })
    await drive(api.engine)
    const letterId = (await api.call('GET', '/dead-letters', alice)).json()[0].id
    const nothing = '11111111-1111-4111-8111-111111111111'

    const attempts: [method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown][] = [
      ['GET', `/workflows/${workflowId}`],
      ['DELETE', `/workflows/${workflowId}`],
      ['POST', `/workflows/${workflowId}/runs`, { input: wholesale.input }],
      ['GET', `/runs/${runId}`],
      ['GET', `/runs/${runId}/events`],
      ['POST', `/runs/${runId}/replay`],
      ['POST', `/runs/${runId}/steps/check_stock/decision`, { decision: 'approved' }],
      ['POST', `/dead-letters/${letterId}/replay`],
    ]
    for (const [method, url, payload] of attempts) {
      const hers = await api.call(method, url, bob, payload)
      const none = await api.call(method, url.replace(workflowId, nothing).replace(runId, nothing).replace(letterId, nothing), bob, payload)
      expect(hers.statusCode, `${method} ${url}`).toBe(404)
      expect(none.statusCode, `${method} ${url}`).toBe(404)
      expect(hers.json().error.code, `${method} ${url}`).toBe(none.json().error.code)
    }
    for (const url of ['/workflows', '/runs', '/dead-letters', '/sent', `/sent?rootRunId=${runId}`]) expect((await api.call('GET', url, bob)).json(), url).toEqual([])
    expect((await api.call('GET', `/workflows/${workflowId}`, alice)).statusCode).toBe(200)
  })

  it('never puts a session hash, or any field the views do not list, in an answer', async () => {
    const session = newSession()
    const workflowId = await fromSample(session, 'wholesale-order')
    const runId = await startRun(session, workflowId, 'wholesale-order')
    await drive(api.engine)

    for (const url of [`/workflows/${workflowId}`, `/runs/${runId}`, `/runs/${runId}/events`, '/sent', '/runs', '/workflows']) {
      const body = (await api.call('GET', url, session)).body
      expect(body, url).not.toContain(session)
      expect(body, url).not.toMatch(/session/i)
    }
  })
})

describe('the OpenAPI document', () => {
  it('describes every route, with the schemas under readable names', async () => {
    const document = (await api.app.inject({ url: '/api/openapi.json' })).json()

    expect(Object.keys(document.paths).filter(path => path.startsWith('/api/lb08')).sort()).toEqual([
      '/api/lb08/catalogue',
      '/api/lb08/dead-letters',
      '/api/lb08/dead-letters/{id}/replay',
      '/api/lb08/limits',
      '/api/lb08/runs',
      '/api/lb08/runs/{id}',
      '/api/lb08/runs/{id}/events',
      '/api/lb08/runs/{id}/replay',
      '/api/lb08/runs/{id}/steps/{nodeId}/decision',
      '/api/lb08/samples',
      '/api/lb08/sent',
      '/api/lb08/workflows',
      '/api/lb08/workflows/{id}',
      '/api/lb08/workflows/{id}/runs',
    ])
    expect(Object.keys(document.components.schemas)).toEqual(expect.arrayContaining(['WorkflowView', 'RunView', 'RunEvent', 'ErrorBody', 'WorkflowGraph']))
  })
})
