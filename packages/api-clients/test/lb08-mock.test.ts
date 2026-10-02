// Tests of the mock back end's LB-08: opening a sample, describing a process, editing and saving
// versions, running with a test payload, the retries, the dead-letter list and the replay, an
// approval, what the sandbox sent, the daily allowances and the Scope's trace. Every answer is
// checked against the committed OpenAPI document by the mock itself (`violations`), and the events
// of a run are read with the contracts' own schema, so a change to either shows up here.
import { generateKeyPairSync } from 'node:crypto'

import { mintServiceToken } from '@lb/common/tokens'
import { mintVisitorToken } from '@lb/common/visitors'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { runEventSchema, workflowViewSchema } from '../../contracts/src/index.ts'
import { readLb08Seed, startMockBackend } from '../src/testing/index.ts'
import type { MockBackend } from '../src/testing/index.ts'

const site = generateKeyPairSync('ed25519')
const web = generateKeyPairSync('ed25519')
const seed = readLb08Seed()
let clock = Date.UTC(2026, 9, 5, 9, 0, 0)
let mock: MockBackend

beforeAll(async () => {
  mock = await startMockBackend({
    siteKey: site.publicKey.export({ format: 'jwk' }).x ?? '',
    webKey: web.publicKey.export({ format: 'jwk' }).x ?? '',
    now: () => clock,
  })
})

afterAll(async () => {
  await mock.close()
})

beforeEach(() => {
  mock.reset()
  clock = Date.UTC(2026, 9, 5, 9, 0, 0)
})

/** What a call to the mock answered. */
interface Reply {
  status: number
  json: any // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Calls LB-08 as a visitor. */
async function call(method: string, path: string, body?: unknown, visitor = 'visitor-aaaaaaaaaaaaaaaa'): Promise<Reply> {
  const token = mintVisitorToken(site.privateKey, { system: 'lb-08', sessionKey: visitor }, clock / 1000)
  const response = await fetch(`${mock.url}/api/lb08${path}`, {
    method,
    headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, json: text === '' ? undefined : JSON.parse(text) }
}

/** Opens a curated sample as a new workflow and returns it. */
async function openSample(id: string, visitor?: string): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const answer = await call('POST', '/workflows', { from: 'sample', sampleId: id }, visitor)
  expect(answer.status).toBe(201)
  return answer.json
}

/** Starts a run of a workflow with the sample's own payload. */
async function startRun(workflowId: string, sampleId: string, failures?: { nodeId: string, times: number }[], visitor?: string): Promise<Reply> {
  const sample = seed.samples.find(candidate => candidate.id === sampleId)!
  return call('POST', `/workflows/${workflowId}/runs`, { input: sample.input, ...(failures ? { failures } : {}) }, visitor)
}

/** Reads a run's events until it has finished or waits for a person, as the site's poll does, and returns them all. */
async function follow(runId: string, until: string[] = ['succeeded', 'failed']): Promise<{ status: string, events: any[] }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const events: any[] = [] // eslint-disable-line @typescript-eslint/no-explicit-any
  let after = 0
  for (let poll = 0; poll < 60; poll += 1) {
    // A second goes by between two reads, as it does while a visitor's page waits on a retry.
    clock += 1_000
    const answer = await call('GET', `/runs/${runId}/events?after=${after}`)
    expect(answer.status).toBe(200)
    for (const event of answer.json.events) {
      expect(runEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(true)
      events.push(event)
      after = event.seq
    }
    if (until.includes(answer.json.status)) return { status: answer.json.status, events }
  }
  throw new Error('The run did not finish.')
}

/** The kinds of the events of a run, with the step they are about when they have one. */
function story(events: readonly { type: string, nodeId?: string }[]): string[] {
  return events.map(event => (event.nodeId ? `${event.type}:${event.nodeId}` : event.type))
}

/** Reads a run's spans from the mock's Scope route as the `web` service. */
async function scope(runId: string): Promise<Reply> {
  const authorization = `Bearer ${mintServiceToken('web', web.privateKey, clock / 1000)}`
  const response = await fetch(`${mock.url}/v1/runs/${runId}/spans`, { headers: { authorization } })
  return { status: response.status, json: await response.json() }
}

describe('what LB-08 offers before anything is run', () => {
  it('lists the curated samples of the seed, each with its event and its test payload', async () => {
    const answer = await call('GET', '/samples')

    expect(answer.status).toBe(200)
    expect(answer.json.map((sample: { id: string }) => sample.id)).toEqual(seed.samples.map(sample => sample.id))
    expect(answer.json[0]).toMatchObject({ id: 'wholesale-order', language: 'en', event: 'wholesale_order' })
    expect(answer.json[0].input.totalEur).toBe(640)
  })

  it('serves the catalogue the validator is built from and a visitor\'s full allowances', async () => {
    const catalogue = await call('GET', '/catalogue')
    const limits = await call('GET', '/limits')

    expect(catalogue.json.connectors.map((connector: { id: string }) => connector.id)).toEqual(['stock_check', 'slack_alert', 'email', 'webhook', 'create_task'])
    expect(catalogue.json.limits).toMatchObject({ maxNodes: 16, maxEdges: 32, maxAttempts: 3, maxInjectedFailures: 5 })
    expect(limits.json.runs).toEqual({ limit: 10, used: 0, remaining: 10 })
    expect(limits.json.generations).toEqual({ limit: 10, used: 0, remaining: 10 })
    expect(limits.json.resetsAt).toBe('2026-10-06T00:00:00.000Z')
  })
})

describe('workflows', () => {
  it('opens a sample as version 1, written by hand and costing no model call', async () => {
    const workflow = await openSample('wholesale-order')

    expect(workflowViewSchema.safeParse(workflow).success).toBe(true)
    expect(workflow.version).toBe(1)
    expect(workflow.description).toBeNull()
    expect(workflow.versions).toEqual([{ version: 1, origin: 'sample', createdAt: '2026-10-05T09:00:00.000Z', modelCalls: 0, traceRunId: null }])
    expect(workflow.graph.nodes).toHaveLength(5)
    expect((await call('GET', '/limits')).json.generations.used).toBe(0)
  })

  it('answers an unknown sample with the documented 404', async () => {
    expect((await call('POST', '/workflows', { from: 'sample', sampleId: 'nothing' })).status).toBe(404)
  })

  it('lists a visitor\'s workflows and shows nobody else\'s', async () => {
    const mine = await openSample('wholesale-order')
    await openSample('low-stock-reorder', 'visitor-bbbbbbbbbbbbbbbb')

    expect((await call('GET', '/workflows')).json.map((workflow: { id: string }) => workflow.id)).toEqual([mine.id])
    expect((await call('GET', `/workflows/${mine.id}`, undefined, 'visitor-bbbbbbbbbbbbbbbb')).status).toBe(404)
  })

  it('describes a process the golden set knows as the workflow it expects, in one model call it names in its trace', async () => {
    const sample = seed.samples.find(candidate => candidate.id === 'low-stock-reorder')!
    const answer = await call('POST', '/workflows', { from: 'description', description: sample.description })

    expect(answer.status).toBe(201)
    expect(answer.json.graph).toEqual(sample.graph)
    expect(answer.json.description).toBe(sample.description)
    expect(answer.json.versions[0]).toMatchObject({ version: 1, origin: 'generated', modelCalls: 1 })
    const trace = await scope(answer.json.versions[0].traceRunId)
    expect(trace.status).toBe(200)
    expect(trace.json.finished).toBe(true)
    expect(trace.json.spans.some((span: { kind: string, name: string }) => span.kind === 'gateway.call' && span.name === 'lb-tools')).toBe(true)
  })

  it('refuses a description that cannot be built, with every problem the validator found and nothing stored', async () => {
    const answer = await call('POST', '/workflows', { from: 'description', description: 'When a wholesale order arrives, text the roastery owner by SMS.' })

    expect(answer.status).toBe(422)
    expect(answer.json.error.code).toBe('workflow_rejected')
    expect(answer.json.error.problems.map((problem: { code: string }) => problem.code)).toContain('unknown_connector')
    expect((await call('GET', '/workflows')).json).toEqual([])
    expect((await call('GET', '/limits')).json.generations.used).toBe(1)
  })

  it('builds a small generic workflow for any other description', async () => {
    const answer = await call('POST', '/workflows', { from: 'description', description: 'Whenever somebody asks, tell the roastery about it.' })

    expect(answer.status).toBe(201)
    expect(answer.json.graph.nodes.map((node: { type: string }) => node.type)).toEqual(['trigger', 'action'])
  })

  it('refuses the eleventh description of the day, and counts again the next day', async () => {
    for (let count = 0; count < 10; count += 1) {
      expect((await call('POST', '/workflows', { from: 'description', description: `Tell the roastery, number ${count + 1}.` })).status).toBe(201)
      await call('DELETE', `/workflows/${(await call('GET', '/workflows')).json[0].id}`)
    }
    const refused = await call('POST', '/workflows', { from: 'description', description: 'Tell the roastery once more.' })
    expect(refused.status).toBe(429)
    expect(refused.json.error.code).toBe('daily_limit')
    // It says when the day starts again, as the real service does: the next midnight in UTC.
    expect(refused.json.error.resets_at).toBe(new Date(new Date(clock).setUTCHours(24, 0, 0, 0)).toISOString())

    clock += 24 * 3_600_000
    expect((await call('POST', '/workflows', { from: 'description', description: 'Tell the roastery once more.' })).status).toBe(201)
  })

  it('refuses a twenty-first workflow', async () => {
    for (let count = 0; count < 20; count += 1) await openSample('wholesale-order')

    const refused = await call('POST', '/workflows', { from: 'sample', sampleId: 'wholesale-order' })
    expect(refused.status).toBe(409)
    expect(refused.json.error.code).toBe('workflow_limit')
  })

  it('saves an edit as the next version, refuses a graph that fails validation and a stale edit', async () => {
    const workflow = await openSample('wholesale-order')
    const edited = { ...workflow.graph, name: 'Wholesale order over 900' }
    edited.nodes = edited.nodes.map((node: any) => (node.id === 'big_order' ? { ...node, value: 900 } : node)) // eslint-disable-line @typescript-eslint/no-explicit-any

    const saved = await call('PUT', `/workflows/${workflow.id}`, { baseVersion: 1, graph: edited })
    expect(saved.status).toBe(200)
    expect(saved.json.version).toBe(2)
    expect(saved.json.name).toBe('Wholesale order over 900')
    expect(saved.json.versions.map((version: { version: number, origin: string }) => `${version.version}:${version.origin}`)).toEqual(['2:edited', '1:sample'])

    const stale = await call('PUT', `/workflows/${workflow.id}`, { baseVersion: 1, graph: edited })
    expect(stale.status).toBe(409)
    expect(stale.json.error.code).toBe('version_conflict')

    const loop = { ...edited, edges: [...edited.edges, { from: 'email_cafe', to: 'check_stock' }] }
    const invalid = await call('PUT', `/workflows/${workflow.id}`, { baseVersion: 2, graph: loop })
    expect(invalid.status).toBe(422)
    expect(invalid.json.error.problems.map((problem: { code: string }) => problem.code)).toContain('cycle')
    expect((await call('GET', `/workflows/${workflow.id}`)).json.version).toBe(2)
  })

  it('deletes a workflow with its runs', async () => {
    const workflow = await openSample('low-stock-reorder')
    const run = (await startRun(workflow.id, 'low-stock-reorder')).json

    expect((await call('DELETE', `/workflows/${workflow.id}`)).status).toBe(204)
    expect((await call('GET', `/workflows/${workflow.id}`)).status).toBe(404)
    expect((await call('GET', `/runs/${run.id}`)).status).toBe(404)
  })
})

describe('a run', () => {
  it('is queued at once and moves on as its events are read, ending with the real order of events', async () => {
    const workflow = await openSample('low-stock-reorder')
    const started = await startRun(workflow.id, 'low-stock-reorder')

    expect(started.status).toBe(202)
    expect(started.json.status).toBe('queued')
    expect(started.json.steps.map((step: { nodeId: string, status: string }) => `${step.nodeId}:${step.status}`)).toEqual([
      'stock_alert:succeeded', 'tell_purchasing:ready', 'reorder_task:ready',
    ])
    const { status, events } = await follow(started.json.id)

    expect(status).toBe('succeeded')
    expect(story(events)).toEqual([
      'run.queued', 'step.succeeded:stock_alert',
      'run.started', 'step.started:tell_purchasing', 'step.started:reorder_task',
      'effect.sent:tell_purchasing', 'step.succeeded:tell_purchasing', 'effect.sent:reorder_task', 'step.succeeded:reorder_task',
      'run.succeeded',
    ])
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index + 1))
  })

  it('branches on a condition, skips what the other branch would have run, and reads a step\'s output from the stock list', async () => {
    const workflow = await openSample('wholesale-order')
    const started = await startRun(workflow.id, 'wholesale-order')
    const { events } = await follow(started.json.id)
    const view = (await call('GET', `/runs/${started.json.id}`)).json

    expect(story(events).slice(0, 4)).toEqual(['run.queued', 'step.succeeded:order_received', 'step.succeeded:big_order', 'run.started'])
    expect(view.steps.find((step: { nodeId: string }) => step.nodeId === 'big_order').output).toEqual({ checked: 640, branch: 'true' })
    expect(view.steps.find((step: { nodeId: string }) => step.nodeId === 'check_stock').output).toEqual({ inStock: true, availableKg: 180, etaDays: 2, productName: 'Basalt Blend 1 kg' })
    expect(view.status).toBe('succeeded')

    const small = await call('POST', `/workflows/${workflow.id}/runs`, { input: { ...seed.samples[0]!.input, totalEur: 120 } })
    const skipped = await follow(small.json.id)
    expect(skipped.events.filter(event => event.type === 'step.skipped').map(event => `${event.nodeId}:${event.reason}`)).toEqual([
      'check_stock:branch_not_taken', 'alert_roastery:upstream_skipped', 'email_cafe:upstream_skipped',
    ])
    expect(skipped.status).toBe('succeeded')
  })

  it('records what the connectors sent, with the text filled in and a sandbox address', async () => {
    const workflow = await openSample('wholesale-order')
    const started = await startRun(workflow.id, 'wholesale-order')
    await follow(started.json.id)
    const sent = (await call('GET', `/sent?rootRunId=${started.json.rootRunId}`)).json

    expect(sent.map((row: { connector: string }) => row.connector).sort()).toEqual(['email', 'slack_alert'])
    const email = sent.find((row: { connector: string }) => row.connector === 'email')
    expect(email.payload).toEqual({
      to: 'orders@lumen.test',
      subject: 'Your order WO-2041',
      body: 'Thank you for your order. Based on our stock, it should reach you in 2 days.',
    })
    const slack = sent.find((row: { connector: string }) => row.connector === 'slack_alert')
    expect(slack.payload.message).toContain('Wholesale order WO-2041 from Café Lumen: 20 kg of Basalt Blend 1 kg')
  })

  it('retries a step the visitor made fail, with a doubling wait, and still sends once', async () => {
    const workflow = await openSample('low-stock-reorder')
    const started = await startRun(workflow.id, 'low-stock-reorder', [{ nodeId: 'tell_purchasing', times: 2 }])
    const { status, events } = await follow(started.json.id)

    expect(status).toBe('succeeded')
    const failures = events.filter(event => event.type === 'step.failed')
    expect(failures.map(event => `${event.attempt}/${event.maxAttempts} in ${event.retryInMs}`)).toEqual(['1/3 in 1000', '2/3 in 2000'])
    expect(failures.every(event => event.code === 'connector_unavailable')).toBe(true)
    expect(events.filter(event => event.type === 'step.started' && event.nodeId === 'tell_purchasing').map(event => event.attempt)).toEqual([1, 2, 3])
    expect(events.filter(event => event.type === 'effect.sent' && event.nodeId === 'tell_purchasing')).toHaveLength(1)
    expect((await call('GET', `/sent?rootRunId=${started.json.rootRunId}`)).json).toHaveLength(2)
    expect((await call('GET', '/dead-letters')).json).toEqual([])
  })

  it('dead-letters a step that fails three times, fails the run once the rest has finished, and sends nothing for it', async () => {
    const workflow = await openSample('low-stock-reorder')
    const started = await startRun(workflow.id, 'low-stock-reorder', [{ nodeId: 'tell_purchasing', times: 3 }])
    const { status, events } = await follow(started.json.id)

    expect(status).toBe('failed')
    expect(story(events).slice(-5)).toEqual(['step.failed:tell_purchasing', 'step.started:tell_purchasing', 'step.failed:tell_purchasing', 'step.dead_lettered:tell_purchasing', 'run.failed:tell_purchasing'])
    expect(events.filter(event => event.type === 'step.failed').at(-1)).toMatchObject({ attempt: 3, retryInMs: null })
    expect(events.at(-1)).toMatchObject({ type: 'run.failed', nodeId: 'tell_purchasing' })
    const letters = (await call('GET', '/dead-letters')).json
    expect(letters).toHaveLength(1)
    expect(letters[0]).toMatchObject({ runId: started.json.id, nodeId: 'tell_purchasing', attempts: 3, replayedRunId: null, error: { code: 'connector_unavailable' } })
    const sent = (await call('GET', `/sent?rootRunId=${started.json.rootRunId}`)).json
    expect(sent.map((row: { nodeId: string }) => row.nodeId)).toEqual(['reorder_task'])
  })

  it('replays from a dead letter once: what went out before is recognised and not sent again, what failed goes out now', async () => {
    const workflow = await openSample('low-stock-reorder')
    const started = await startRun(workflow.id, 'low-stock-reorder', [{ nodeId: 'tell_purchasing', times: 3 }])
    await follow(started.json.id)
    const letter = (await call('GET', '/dead-letters')).json[0]

    const replay = await call('POST', `/dead-letters/${letter.id}/replay`)
    expect(replay.status).toBe(202)
    expect(replay.json).toMatchObject({ replayOf: started.json.id, rootRunId: started.json.rootRunId })
    const { status, events } = await follow(replay.json.id)

    expect(status).toBe('succeeded')
    const effects = events.filter(event => event.type.startsWith('effect.'))
    expect(effects.map(event => `${event.type}:${event.nodeId}`).sort()).toEqual(['effect.duplicate_suppressed:reorder_task', 'effect.sent:tell_purchasing'])
    expect(effects.find(event => event.type === 'effect.duplicate_suppressed').originalRunId).toBe(started.json.id)
    expect((await call('GET', `/sent?rootRunId=${started.json.rootRunId}`)).json).toHaveLength(2)
    expect((await call('GET', '/dead-letters')).json[0].replayedRunId).toBe(replay.json.id)
    expect((await call('GET', `/runs/${started.json.id}`)).json.replayedBy).toBe(replay.json.id)

    const again = await call('POST', `/dead-letters/${letter.id}/replay`)
    expect(again.status).toBe(409)
    expect(again.json.error.code).toBe('already_replayed')
  })

  it('keeps the failures the visitor asked for across a replay: three asked, five asked leaves two', async () => {
    const workflow = await openSample('low-stock-reorder')
    const started = await startRun(workflow.id, 'low-stock-reorder', [{ nodeId: 'tell_purchasing', times: 4 }])
    await follow(started.json.id)
    const replay = await call('POST', `/runs/${started.json.id}/replay`)
    const { status, events } = await follow(replay.json.id)

    expect(status).toBe('succeeded')
    expect(events.filter(event => event.type === 'step.failed').map(event => event.attempt)).toEqual([1])
  })

  it('replays a succeeded run with every write recognised and nothing sent twice', async () => {
    const workflow = await openSample('wholesale-order')
    const started = await startRun(workflow.id, 'wholesale-order')
    await follow(started.json.id)
    const replay = await call('POST', `/runs/${started.json.id}/replay`)
    const { events } = await follow(replay.json.id)

    expect(events.filter(event => event.type === 'effect.sent')).toEqual([])
    expect(events.filter(event => event.type === 'effect.duplicate_suppressed')).toHaveLength(2)
    expect((await call('GET', `/sent?rootRunId=${started.json.rootRunId}`)).json).toHaveLength(2)
    expect((await call('GET', '/limits')).json.runs).toEqual({ limit: 10, used: 2, remaining: 8 })
  })

  it('refuses to replay a run that has not finished', async () => {
    const workflow = await openSample('low-stock-reorder')
    const started = await startRun(workflow.id, 'low-stock-reorder')

    const refused = await call('POST', `/runs/${started.json.id}/replay`)
    expect(refused.status).toBe(409)
    expect(refused.json.error.code).toBe('run_not_finished')
  })

  it('waits for an approval, then carries on down the branch the person chose, once', async () => {
    const workflow = await openSample('refund-approval')
    const started = await startRun(workflow.id, 'refund-approval')
    const waiting = await follow(started.json.id, ['awaiting_approval'])

    expect(waiting.status).toBe('awaiting_approval')
    expect(story(waiting.events).slice(-2)).toEqual(['run.started', 'run.awaiting_approval:finance_ok'])
    expect(story(waiting.events)).toContain('step.awaiting_approval:finance_ok')
    const view = (await call('GET', `/runs/${started.json.id}`)).json
    expect(view.steps.find((step: { nodeId: string }) => step.nodeId === 'finance_ok').output.question).toBe('Approve a refund of €120 for order BB-1043?')

    const decided = await call('POST', `/runs/${started.json.id}/steps/finance_ok/decision`, { decision: 'rejected' })
    expect(decided.status).toBe(200)
    const { status, events } = await follow(started.json.id)
    expect(status).toBe('succeeded')
    expect(events.filter(event => event.type === 'effect.sent').map(event => event.nodeId)).toEqual(['email_declined'])
    expect(events.filter(event => event.type === 'step.skipped').map(event => event.nodeId).sort()).toEqual(['email_refunded', 'email_small', 'tell_accounting'])

    const twice = await call('POST', `/runs/${started.json.id}/steps/finance_ok/decision`, { decision: 'approved' })
    expect(twice.status).toBe(409)
    expect((await call('POST', `/runs/${started.json.id}/steps/over_100/decision`, { decision: 'approved' })).status).toBe(404)
  })

  it('refuses a payload that does not fit the event, naming the fields and not the values, and a failure on a step that is not an action', async () => {
    const workflow = await openSample('wholesale-order')

    const payload = await call('POST', `/workflows/${workflow.id}/runs`, { input: { ...seed.samples[0]!.input, totalEur: 'a lot', extra: 1 } })
    expect(payload.status).toBe(422)
    expect(payload.json.error.fields).toContain('totalEur')
    expect(JSON.stringify(payload.json)).not.toContain('a lot')

    const failure = await startRun(workflow.id, 'wholesale-order', [{ nodeId: 'big_order', times: 1 }])
    expect(failure.status).toBe(422)
    expect(failure.json.error.code).toBe('invalid_failure')
    expect((await call('GET', '/limits')).json.runs.used).toBe(0)
  })

  it('fails a step for good, with no retry and no dead letter, when the product is not in the stock list', async () => {
    const workflow = await openSample('wholesale-order')
    const input = { ...seed.samples[0]!.input, sku: 'ghost-roast-1kg' }
    const started = await call('POST', `/workflows/${workflow.id}/runs`, { input })
    const { status, events } = await follow(started.json.id)

    expect(status).toBe('failed')
    expect(events.find(event => event.type === 'step.failed')).toMatchObject({ nodeId: 'check_stock', code: 'unknown_product', attempt: 1, retryInMs: null })
    expect(events.some(event => event.type === 'step.dead_lettered')).toBe(false)
    expect((await call('GET', '/dead-letters')).json).toEqual([])
  })

  it('counts the tenth run and refuses the eleventh, a replay counting as a run', async () => {
    const workflow = await openSample('low-stock-reorder')
    for (let count = 0; count < 9; count += 1) expect((await startRun(workflow.id, 'low-stock-reorder')).status).toBe(202)
    const last = await startRun(workflow.id, 'low-stock-reorder')
    expect(last.status).toBe(202)
    expect((await call('GET', '/limits')).json.runs).toEqual({ limit: 10, used: 10, remaining: 0 })

    const refused = await startRun(workflow.id, 'low-stock-reorder')
    expect(refused.status).toBe(429)
    expect(refused.json.error.resets_at).toBe(new Date(new Date(clock).setUTCHours(24, 0, 0, 0)).toISOString())
    await follow(last.json.id)
    expect((await call('POST', `/runs/${last.json.id}/replay`)).status).toBe(429)
  })

  it('writes a span for each attempt, and a root span last that makes the trace finished, as the engine does; a run nobody has started has no trace', async () => {
    const workflow = await openSample('low-stock-reorder')
    const started = await startRun(workflow.id, 'low-stock-reorder', [{ nodeId: 'tell_purchasing', times: 1 }])

    expect((await scope(started.json.id)).status).toBe(404)
    await follow(started.json.id)
    const trace = await scope(started.json.id)

    expect(trace.status).toBe(200)
    expect(trace.json.finished).toBe(true)
    /** The part of a span this test reads. */
    interface Span {
      name: string
      kind: string
      status: string
      spanId: string
      parentId?: string
      attrs: { attempt: number }
    }
    const steps = trace.json.spans.filter((span: Span) => span.kind === 'system.step')
    expect(steps.map((span: Span) => `${span.name}#${span.attrs.attempt}:${span.status}`)).toEqual([
      'step.tell_purchasing#1:error', 'step.reorder_task#1:ok', 'step.tell_purchasing#2:ok',
    ])
    const root = trace.json.spans.at(-1)
    expect(root).toMatchObject({ kind: 'system.run', name: 'workflow run', status: 'ok', attrs: { outcome: 'succeeded', attempts: 3, replay: false } })
    expect(root.parentId).toBeUndefined()
    expect(steps.every((span: Span) => span.parentId === root.spanId)).toBe(true)
    expect(trace.json.spans.every((span: { system: string }) => span.system === 'lb-08')).toBe(true)
  })

  it('has the trace of a run that is still going unfinished, and of a run that failed finished with a root that says error', async () => {
    const workflow = await openSample('low-stock-reorder')
    const going = await startRun(workflow.id, 'low-stock-reorder', [{ nodeId: 'tell_purchasing', times: 1 }])
    // Two reads a second apart: the first starts the steps, the second finishes their first attempts, and a retry is still to come.
    let status = ''
    for (let read = 0; read < 2; read += 1) {
      clock += 1_000
      status = (await call('GET', `/runs/${going.json.id}/events?after=0`)).json.status
    }
    const midway = await scope(going.json.id)
    const failing = await startRun(workflow.id, 'low-stock-reorder', [{ nodeId: 'tell_purchasing', times: 3 }])
    await follow(failing.json.id)
    const failed = await scope(failing.json.id)

    expect(status).toBe('running')
    expect(midway.json.spans.length).toBeGreaterThan(0)
    expect(midway.json.finished).toBe(false)
    expect(failed.json.finished).toBe(true)
    expect(failed.json.spans.at(-1)).toMatchObject({ kind: 'system.run', status: 'error', attrs: { outcome: 'failed' } })
  })

  it('shows a visitor only their own runs, sandbox rows and dead letters', async () => {
    const workflow = await openSample('low-stock-reorder')
    const started = await startRun(workflow.id, 'low-stock-reorder', [{ nodeId: 'tell_purchasing', times: 3 }])
    await follow(started.json.id)
    const stranger = 'visitor-bbbbbbbbbbbbbbbb'

    expect((await call('GET', `/runs/${started.json.id}`, undefined, stranger)).status).toBe(404)
    expect((await call('GET', `/runs/${started.json.id}/events`, undefined, stranger)).status).toBe(404)
    expect((await call('GET', '/sent', undefined, stranger)).json).toEqual([])
    expect((await call('GET', '/dead-letters', undefined, stranger)).json).toEqual([])
    expect((await call('POST', `/runs/${started.json.id}/replay`, undefined, stranger)).status).toBe(404)
    expect((await call('POST', `/workflows/${workflow.id}/runs`, { input: {} }, stranger)).status).toBe(404)
  })

  it('answers every request with what its document says', async () => {
    expect(mock.violations).toEqual([])
  })
})
