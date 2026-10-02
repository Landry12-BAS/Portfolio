// Tests for LB-08's workflow engine against a real Postgres, with the queue driven by hand
// so every interleaving is the test's choice. They cover how a run moves (free steps inline,
// actions on workers, branches, approvals), what happens when steps fail (retries, the
// dead-letter queue, replay), the promise the engine exists to keep (a side effect happens
// once, even when a worker dies between sending it and writing it down), the visitor's
// limits, and what stays out of reach of another visitor.
import { randomBytes } from 'node:crypto'

import type { RunView, WorkflowGraph } from '@lb/contracts'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { deleteExpired, sweep } from '../../src/modules/lb08/engine/sweep.ts'
import { requeueStale } from '../../src/modules/lb08/engine/dispatch.ts'
import { StepKilled } from '../../src/modules/lb08/engine/errors.ts'
import { listDeadLetters, listRuns, listSent, readRunView, readWorkflowView } from '../../src/modules/lb08/engine/reads.ts'
import { decide, replayRun, startRun } from '../../src/modules/lb08/engine/runs.ts'
import { runStep } from '../../src/modules/lb08/engine/steps.ts'
import { createWorkflow, deleteWorkflow, saveVersion } from '../../src/modules/lb08/engine/store.ts'
import { rootSpanIdOf } from '../../src/modules/lb08/engine/trace.ts'
import { limitsOf } from '../../src/modules/lb08/engine/usage.ts'
import { ALICE, BOB, createHarness, drive, workflowFromSample } from '../support/engine.ts'
import type { Harness } from '../support/engine.ts'

let harness: Harness

beforeAll(async () => {
  harness = await createHarness(inject('databaseUrl'))
})

afterAll(async () => {
  await harness.close()
})

/** Makes a visitor session of its own, so one test's allowances and workflows never touch another's. */
function newSession(): string {
  return `session-${randomBytes(8).toString('hex')}`
}

/** Reads a run the visitor owns, in full. */
async function view(session: string, runId: string): Promise<RunView> {
  const found = await readRunView(harness.deps.db, session, runId)
  if (!found) throw new Error('The run is missing.')
  return found
}

/** Maps each step of a run to its status. */
function statuses(run: RunView): Record<string, string> {
  return Object.fromEntries(run.steps.map(step => [step.nodeId, step.status]))
}

/** Lists the types of a run's events, in order. */
function types(run: RunView): string[] {
  return run.events.map(event => event.type)
}

/** Counts rows of a table of LB-08's schema. */
async function count(table: string, where = 'true', values: unknown[] = []): Promise<number> {
  const { rows } = await harness.database.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, values)
  return rows[0]?.n as number
}

/** Starts a run of one of the samples for a visitor, with its own payload unless one is given. */
async function startSample(session: string, sampleId: string, changes: { input?: Record<string, string | number | boolean>, failures?: { nodeId: string, times: number }[] } = {}): Promise<{ workflowId: string, runId: string }> {
  const { workflowId, input } = await workflowFromSample(harness, session, sampleId)
  const runId = await startRun(harness.deps, session, workflowId, { input: changes.input ?? input, ...(changes.failures ? { failures: changes.failures } : {}) })
  return { workflowId, runId }
}

/** The spans the engine wrote for one run, in the order they were written. */
function spansOf(runId: string) {
  return harness.spans.spans.filter(span => span.runId === runId)
}

/** A workflow whose only way on is a yes: answering no ends the run in the request that carries the answer. */
const askOnly: WorkflowGraph = {
  name: 'Ask only',
  nodes: [
    { id: 'start', type: 'trigger', label: 'Start', event: 'manual' },
    { id: 'ask', type: 'approval', label: 'Ask', approver: 'roastery_manager', message: 'Go ahead?' },
    { id: 'go', type: 'action', label: 'Go', connector: 'slack_alert', params: { channel: '#alerts', message: 'go' } },
  ],
  edges: [
    { from: 'start', to: 'ask' },
    { from: 'ask', to: 'go', branch: 'approved' },
  ],
}

/** A diamond workflow: the trigger feeds two Slack alerts, and a task waits for both. */
const diamond: WorkflowGraph = {
  name: 'Diamond',
  nodes: [
    { id: 'start', type: 'trigger', label: 'Start', event: 'manual' },
    { id: 'left', type: 'action', label: 'Left', connector: 'slack_alert', params: { channel: '#alerts', message: 'left' } },
    { id: 'right', type: 'action', label: 'Right', connector: 'slack_alert', params: { channel: '#alerts', message: 'right' } },
    { id: 'join', type: 'action', label: 'Join', connector: 'create_task', params: { board: 'roasting', title: 'join' } },
  ],
  edges: [
    { from: 'start', to: 'left' },
    { from: 'start', to: 'right' },
    { from: 'left', to: 'join' },
    { from: 'right', to: 'join' },
  ],
}

describe('a run of the wholesale sample', () => {
  it('runs the free steps at once, leaves the actions to workers, and records every effect once', async () => {
    const session = newSession()
    const { runId } = await startSample(session, 'wholesale-order')

    const queued = await view(session, runId)
    expect(queued.status).toBe('queued')
    expect(statuses(queued)).toEqual({ order_received: 'succeeded', big_order: 'succeeded', check_stock: 'queued', alert_roastery: 'pending', email_cafe: 'pending' })
    expect(queued.steps.find(step => step.nodeId === 'big_order')?.output).toEqual({ checked: 640, branch: 'true' })
    expect(harness.scheduler.jobs).toEqual([{ runId, nodeId: 'check_stock' }])

    await drive(harness)

    const done = await view(session, runId)
    expect(done.status).toBe('succeeded')
    expect(statuses(done)).toEqual({ order_received: 'succeeded', big_order: 'succeeded', check_stock: 'succeeded', alert_roastery: 'succeeded', email_cafe: 'succeeded' })
    expect(types(done)).toEqual([
      'run.queued',
      'step.succeeded',
      'step.succeeded',
      'run.started',
      'step.started',
      'step.succeeded',
      'step.started',
      'effect.sent',
      'step.succeeded',
      'step.started',
      'effect.sent',
      'step.succeeded',
      'run.succeeded',
    ])
    expect(done.events.map(event => event.seq)).toEqual(Array.from({ length: 13 }, (_, index) => index + 1))
    expect(done.finishedAt).not.toBeNull()
  })

  it('reads the stock list, and renders what the later steps send from its answer', async () => {
    const session = newSession()
    const { runId } = await startSample(session, 'wholesale-order')
    await drive(harness)

    const run = await view(session, runId)
    const sent = await listSent(harness.deps.db, session)

    expect(run.steps.find(step => step.nodeId === 'check_stock')?.output).toEqual({ inStock: true, availableKg: 180, etaDays: 2, productName: 'Basalt Blend 1 kg' })
    expect(sent.map(delivery => delivery.connector).sort()).toEqual(['email', 'slack_alert'])
    expect(sent.find(delivery => delivery.connector === 'slack_alert')?.payload).toEqual({ channel: '#roastery', message: 'Wholesale order WO-2041 from Café Lumen: 20 kg of Basalt Blend 1 kg (€640).' })
    expect(sent.find(delivery => delivery.connector === 'email')?.payload).toEqual({
      to: 'orders@lumen.test',
      subject: 'Your order WO-2041',
      body: 'Thank you for your order. Based on our stock, it should reach you in 2 days.',
    })
  })

  it('works out a longer wait when the stock does not cover the order', async () => {
    const session = newSession()
    const { workflowId, input } = await workflowFromSample(harness, session, 'wholesale-order')
    const runId = await startRun(harness.deps, session, workflowId, { input: { ...input, sku: 'guji-filter-1kg', quantityKg: 500 } })
    await drive(harness)

    const run = await view(session, runId)

    expect(run.steps.find(step => step.nodeId === 'check_stock')?.output).toEqual({ inStock: false, availableKg: 22, etaDays: 8, productName: 'Ethiopia Guji Filter 1 kg' })
  })

  it('skips a whole branch the condition did not take, and ends succeeded having sent nothing', async () => {
    const session = newSession()
    const { workflowId, input } = await workflowFromSample(harness, session, 'wholesale-order')
    const runId = await startRun(harness.deps, session, workflowId, { input: { ...input, totalEur: 300 } })

    const run = await view(session, runId)

    expect(harness.scheduler.jobs.some(job => job.runId === runId)).toBe(false)
    expect(run.status).toBe('succeeded')
    expect(statuses(run)).toEqual({ order_received: 'succeeded', big_order: 'succeeded', check_stock: 'skipped', alert_roastery: 'skipped', email_cafe: 'skipped' })
    expect(run.events.filter(event => event.type === 'step.skipped').map(event => (event as { reason: string }).reason)).toEqual(['branch_not_taken', 'upstream_skipped', 'upstream_skipped'])
    expect(types(run).slice(-2)).toEqual(['run.started', 'run.succeeded'])
    expect(await listSent(harness.deps.db, session)).toEqual([])
  })

  it('writes spans that name the step, its attempt and its outcome, and never a visitor\'s words', async () => {
    const session = newSession()
    const { runId } = await startSample(session, 'wholesale-order')
    await drive(harness)

    const mine = spansOf(runId)
    const steps = mine.filter(span => span.kind === 'system.step')

    expect(steps.map(span => span.name).sort()).toEqual(['step.alert_roastery', 'step.check_stock', 'step.email_cafe'])
    expect(mine.every(span => span.system === 'lb-08' && span.status === 'ok')).toBe(true)
    expect(steps.find(span => span.name === 'step.alert_roastery')?.attrs).toEqual({ connector: 'slack_alert', attempt: 1, outcome: 'sent' })
    expect(steps.find(span => span.name === 'step.check_stock')?.attrs.outcome).toBe('read')
    expect(JSON.stringify(mine)).not.toMatch(/Lumen|WO-2041|orders@/)
  })
})

describe('the trace of a run', () => {
  it('has no root while the run goes on, and ends with one, written after the steps, that they nest under', async () => {
    const session = newSession()
    const { runId } = await startSample(session, 'wholesale-order')
    expect(spansOf(runId)).toEqual([])

    await drive(harness)

    const spans = spansOf(runId)
    const root = spans.at(-1)
    const steps = spans.filter(span => span.kind === 'system.step')
    expect(root).toMatchObject({ kind: 'system.run', name: 'workflow run', status: 'ok', system: 'lb-08', spanId: rootSpanIdOf(runId), attrs: { outcome: 'succeeded', steps: 5, attempts: 3, replay: false } })
    expect(root?.parentId).toBeUndefined()
    expect(spans.filter(span => span.kind === 'system.run')).toHaveLength(1)
    expect(steps).toHaveLength(3)
    expect(steps.every(step => step.parentId === root?.spanId)).toBe(true)
    // The root covers the run: from the moment it was made to the end of its last step.
    expect(root?.startMs).toBeLessThanOrEqual(Math.min(...steps.map(step => step.startMs)))
    expect(root?.endMs).toBeGreaterThanOrEqual(Math.max(...steps.map(step => step.endMs)))
  })

  it('writes the root at once for a run that ends in the request that starts it', async () => {
    const session = newSession()
    const { workflowId, input } = await workflowFromSample(harness, session, 'wholesale-order')

    const runId = await startRun(harness.deps, session, workflowId, { input: { ...input, totalEur: 300 } })

    expect(spansOf(runId)).toMatchObject([{ kind: 'system.run', status: 'ok', spanId: rootSpanIdOf(runId), attrs: { outcome: 'succeeded', steps: 5, attempts: 0, replay: false } }])
  })

  it('writes the root when a person\'s answer is what ends the run, and not before', async () => {
    const session = newSession()
    const workflowId = await createWorkflow(harness.deps, { sessionKey: session, graph: askOnly, origin: 'sample', description: null, modelCalls: 0, traceRunId: null })
    const runId = await startRun(harness.deps, session, workflowId, { input: { note: 'Test run' } })
    expect((await view(session, runId)).status).toBe('awaiting_approval')
    expect(spansOf(runId)).toEqual([])

    await decide(harness.deps, session, runId, 'ask', { decision: 'rejected' })

    expect((await view(session, runId)).status).toBe('succeeded')
    expect(spansOf(runId)).toMatchObject([{ kind: 'system.run', status: 'ok', attrs: { outcome: 'succeeded', steps: 3, attempts: 0 } }])
  })

  it('records every attempt of a failing step under the root, and ends the root as an error when the run fails', async () => {
    const session = newSession()
    const { runId } = await startSample(session, 'wholesale-order', { failures: [{ nodeId: 'alert_roastery', times: 3 }] })

    await drive(harness)

    const spans = spansOf(runId)
    const root = spans.at(-1)
    const attempts = spans.filter(span => span.name === 'step.alert_roastery')
    expect(attempts.map(span => [span.attrs.attempt, span.status])).toEqual([[1, 'error'], [2, 'error'], [3, 'error']])
    expect(attempts.every(span => span.parentId === root?.spanId)).toBe(true)
    expect(root).toMatchObject({ kind: 'system.run', status: 'error', attrs: { outcome: 'failed', attempts: 5 } })
    expect(spans.filter(span => span.kind === 'system.run')).toHaveLength(1)
  })

  it('gives a replay a trace of its own, with its own root that says it is a replay', async () => {
    const session = newSession()
    const { runId } = await startSample(session, 'wholesale-order', { failures: [{ nodeId: 'alert_roastery', times: 3 }] })
    await drive(harness)

    const replayId = await replayRun(harness.deps, session, runId)
    await drive(harness)

    const original = spansOf(runId).filter(span => span.kind === 'system.run')
    const replay = spansOf(replayId)
    expect(original).toMatchObject([{ status: 'error', spanId: rootSpanIdOf(runId), attrs: { replay: false } }])
    expect(replay.at(-1)).toMatchObject({ kind: 'system.run', status: 'ok', spanId: rootSpanIdOf(replayId), attrs: { outcome: 'succeeded', replay: true } })
    expect(replay.filter(span => span.kind === 'system.step').every(step => step.parentId === rootSpanIdOf(replayId))).toBe(true)
    expect(rootSpanIdOf(replayId)).not.toBe(rootSpanIdOf(runId))
  })

  it('still ends the run when the root cannot be written', async () => {
    const session = newSession()
    const write = harness.spans.write.bind(harness.spans)
    harness.spans.write = async () => {
      throw new Error('Redis is down')
    }
    try {
      const { runId } = await startSample(session, 'wholesale-order')
      await drive(harness)

      expect((await view(session, runId)).status).toBe('succeeded')
    }
    finally {
      harness.spans.write = write
    }
  })
})

describe('approvals', () => {
  it('waits for a person, then goes down the branch they choose and skips the other', async () => {
    const session = newSession()
    const { runId } = await startSample(session, 'refund-approval')

    const waiting = await view(session, runId)
    expect(waiting.status).toBe('awaiting_approval')
    expect(statuses(waiting)).toMatchObject({ over_100: 'succeeded', finance_ok: 'awaiting_approval', email_small: 'skipped', tell_accounting: 'pending' })
    expect(waiting.steps.find(step => step.nodeId === 'finance_ok')?.output).toEqual({ question: 'Approve a refund of €120 for order BB-1043?' })
    expect(types(waiting)).toEqual(['run.queued', 'step.succeeded', 'step.succeeded', 'step.skipped', 'step.awaiting_approval', 'run.started', 'run.awaiting_approval'])
    expect(harness.scheduler.jobs.some(job => job.runId === runId)).toBe(false)

    await decide(harness.deps, session, runId, 'finance_ok', { decision: 'approved' })
    await drive(harness)

    const done = await view(session, runId)
    expect(done.status).toBe('succeeded')
    expect(statuses(done)).toMatchObject({ finance_ok: 'succeeded', tell_accounting: 'succeeded', email_refunded: 'succeeded', email_declined: 'skipped', email_small: 'skipped' })
    expect(done.steps.find(step => step.nodeId === 'finance_ok')?.output).toEqual({ question: 'Approve a refund of €120 for order BB-1043?', branch: 'approved' })
    expect(done.events.filter(event => event.type === 'step.decided')).toHaveLength(1)
    const sent = await listSent(harness.deps.db, session)
    expect(sent.map(delivery => `${delivery.nodeId}:${delivery.connector}`).sort()).toEqual(['email_refunded:email', 'tell_accounting:webhook'])
    expect(sent.find(delivery => delivery.nodeId === 'tell_accounting')?.payload).toEqual({ 'endpoint': 'accounting', 'event': 'refund.approved', 'field.orderId': 'BB-1043', 'field.amountEur': '120' })
  })

  it('sends the polite no when the person rejects', async () => {
    const session = newSession()
    const { runId } = await startSample(session, 'refund-approval')

    await decide(harness.deps, session, runId, 'finance_ok', { decision: 'rejected' })
    await drive(harness)

    const done = await view(session, runId)
    expect(done.status).toBe('succeeded')
    expect(statuses(done)).toMatchObject({ email_declined: 'succeeded', tell_accounting: 'skipped', email_refunded: 'skipped' })
    const sent = await listSent(harness.deps.db, session)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.payload.subject).toBe('About your refund request')
  })

  it('never asks anyone about a small refund', async () => {
    const session = newSession()
    const { workflowId, input } = await workflowFromSample(harness, session, 'refund-approval')
    const runId = await startRun(harness.deps, session, workflowId, { input: { ...input, amountEur: 50 } })
    await drive(harness)

    const run = await view(session, runId)

    expect(run.status).toBe('succeeded')
    expect(statuses(run)).toMatchObject({ finance_ok: 'skipped', email_small: 'succeeded' })
    expect(types(run)).not.toContain('step.awaiting_approval')
  })

  it('takes one answer only: a second one, and one for a step that is not waiting, are refused', async () => {
    const session = newSession()
    const { runId } = await startSample(session, 'refund-approval')
    await decide(harness.deps, session, runId, 'finance_ok', { decision: 'approved' })

    await expect(decide(harness.deps, session, runId, 'finance_ok', { decision: 'rejected' })).rejects.toMatchObject({ status: 409, code: 'not_waiting' })
    await expect(decide(harness.deps, session, runId, 'tell_accounting', { decision: 'approved' })).rejects.toMatchObject({ status: 404, code: 'not_found' })
    await expect(decide(harness.deps, session, runId, 'no_such_step', { decision: 'approved' })).rejects.toMatchObject({ status: 404 })
  })

  it('takes one answer even when two arrive at the same moment', async () => {
    const session = newSession()
    const { runId } = await startSample(session, 'refund-approval')

    const answers = await Promise.allSettled([
      decide(harness.deps, session, runId, 'finance_ok', { decision: 'approved' }),
      decide(harness.deps, session, runId, 'finance_ok', { decision: 'rejected' }),
    ])

    expect(answers.filter(answer => answer.status === 'fulfilled')).toHaveLength(1)
    expect(answers.filter(answer => answer.status === 'rejected')).toHaveLength(1)
    expect((await view(session, runId)).events.filter(event => event.type === 'step.decided')).toHaveLength(1)
  })
})

describe('failing steps', () => {
  it('retries a failing connector with backoff, then dead-letters the step, while its sibling carries on', async () => {
    const session = newSession()
    const { runId } = await startSample(session, 'wholesale-order', { failures: [{ nodeId: 'alert_roastery', times: 3 }] })

    await drive(harness)

    const run = await view(session, runId)
    expect(run.status).toBe('failed')
    expect(statuses(run)).toMatchObject({ check_stock: 'succeeded', alert_roastery: 'failed', email_cafe: 'succeeded' })
    const alert = run.steps.find(step => step.nodeId === 'alert_roastery')
    expect(alert).toMatchObject({ attempts: 3, error: { code: 'connector_unavailable', message: 'The connector is unavailable.' } })
    const failures = run.events.filter(event => event.type === 'step.failed')
    expect(failures).toMatchObject([
      { nodeId: 'alert_roastery', attempt: 1, maxAttempts: 3, code: 'connector_unavailable', retryInMs: 40 },
      { nodeId: 'alert_roastery', attempt: 2, maxAttempts: 3, retryInMs: 80 },
      { nodeId: 'alert_roastery', attempt: 3, maxAttempts: 3, retryInMs: null },
    ])
    expect(types(run).slice(-3)).toEqual(['step.failed', 'step.dead_lettered', 'run.failed'])
    expect(types(run).filter(type => type === 'run.failed')).toHaveLength(1)
    expect(types(run).at(-1)).toBe('run.failed')
    expect(await listSent(harness.deps.db, session)).toHaveLength(1)
    const letters = await listDeadLetters(harness.deps.db, session)
    expect(letters).toMatchObject([{ runId, nodeId: 'alert_roastery', attempts: 3, error: { code: 'connector_unavailable' }, replayedRunId: null }])
    expect([...harness.scheduler.parked.keys()]).toContain(`${runId}/alert_roastery`)
  })

  it('replays the dead letter in one step: the new run finishes the work, and what was sent before is not sent again', async () => {
    const session = newSession()
    const { runId } = await startSample(session, 'wholesale-order', { failures: [{ nodeId: 'alert_roastery', times: 3 }] })
    await drive(harness)

    const replayId = await replayRun(harness.deps, session, runId)
    await drive(harness)

    const replay = await view(session, replayId)
    expect(replay).toMatchObject({ status: 'succeeded', replayOf: runId, rootRunId: runId, version: 1 })
    expect(types(replay)[0]).toBe('run.queued')
    expect((replay.events[0] as { replayOf: string | null }).replayOf).toBe(runId)
    expect(replay.steps.find(step => step.nodeId === 'alert_roastery')?.attempts).toBe(1)
    // The email went out in the original run; the replay recognises its key and sends nothing.
    const suppressed = replay.events.find(event => event.type === 'effect.duplicate_suppressed')
    expect(suppressed).toMatchObject({ nodeId: 'email_cafe', connector: 'email', originalRunId: runId })
    expect(replay.events.filter(event => event.type === 'effect.sent')).toMatchObject([{ nodeId: 'alert_roastery' }])
    expect(await listSent(harness.deps.db, session)).toHaveLength(2)
    expect(await count('outbox', 'root_run_id = $1', [runId])).toBe(2)
    expect(await count('outbox', 'root_run_id = $1 AND status = \'delivered\'', [runId])).toBe(2)
    expect((await view(session, runId)).replayedBy).toBe(replayId)
    expect(await listDeadLetters(harness.deps.db, session)).toMatchObject([{ replayedRunId: replayId }])
    expect(harness.scheduler.parked.has(`${runId}/alert_roastery`)).toBe(false)
  })

  it('carries the failures still left into the replay, so a replay can fail and retry too', async () => {
    const session = newSession()
    const { runId } = await startSample(session, 'wholesale-order', { failures: [{ nodeId: 'alert_roastery', times: 4 }] })
    await drive(harness)

    const replayId = await replayRun(harness.deps, session, runId)
    await drive(harness)

    const replay = await view(session, replayId)
    expect(replay.status).toBe('succeeded')
    expect(replay.steps.find(step => step.nodeId === 'alert_roastery')?.attempts).toBe(2)
    expect(replay.events.filter(event => event.type === 'step.failed')).toMatchObject([{ nodeId: 'alert_roastery', attempt: 1, retryInMs: 40 }])
  })

  it('can be told to fail a read connector too, and recovers on the retry', async () => {
    const session = newSession()
    const { runId } = await startSample(session, 'wholesale-order', { failures: [{ nodeId: 'check_stock', times: 2 }] })

    await drive(harness)

    const run = await view(session, runId)
    expect(run.status).toBe('succeeded')
    expect(run.steps.find(step => step.nodeId === 'check_stock')?.attempts).toBe(3)
    expect(run.events.filter(event => event.type === 'step.failed')).toHaveLength(2)
    expect(run.events.filter(event => event.type === 'step.dead_lettered')).toHaveLength(0)
  })

  it('fails a step for good, with no retries and no dead letter, when it can never work as written', async () => {
    const session = newSession()
    const { workflowId, input } = await workflowFromSample(harness, session, 'wholesale-order')
    const runId = await startRun(harness.deps, session, workflowId, { input: { ...input, sku: 'no-such-coffee-1kg' } })

    await drive(harness)

    const run = await view(session, runId)
    expect(run.status).toBe('failed')
    expect(statuses(run)).toMatchObject({ check_stock: 'failed', alert_roastery: 'pending', email_cafe: 'pending' })
    expect(run.steps.find(step => step.nodeId === 'check_stock')).toMatchObject({ attempts: 1, error: { code: 'unknown_product', message: 'That product isn\'t in the stock list.' } })
    expect(run.events.find(event => event.type === 'step.failed')).toMatchObject({ attempt: 1, retryInMs: null, code: 'unknown_product' })
    expect(types(run)).not.toContain('step.dead_lettered')
    expect(await listDeadLetters(harness.deps.db, session)).toEqual([])
    expect(await listSent(harness.deps.db, session)).toEqual([])
    expect(harness.scheduler.jobs).toEqual([])
  })

  it('lets only a finished run be replayed', async () => {
    const session = newSession()
    const { runId } = await startSample(session, 'wholesale-order')

    await expect(replayRun(harness.deps, session, runId)).rejects.toMatchObject({ status: 409, code: 'run_not_finished' })
    await drive(harness)
    await expect(replayRun(harness.deps, session, runId)).resolves.toMatch(/^[0-9a-f-]{36}$/)
  })

  it('suppresses every effect when a run that succeeded is replayed', async () => {
    const session = newSession()
    const { runId } = await startSample(session, 'wholesale-order')
    await drive(harness)

    const replayId = await replayRun(harness.deps, session, runId)
    await drive(harness)

    const replay = await view(session, replayId)
    expect(replay.events.filter(event => event.type === 'effect.sent')).toHaveLength(0)
    expect(replay.events.filter(event => event.type === 'effect.duplicate_suppressed')).toHaveLength(2)
    expect(await listSent(harness.deps.db, session)).toHaveLength(2)
  })
})

describe('a side effect happens once', () => {
  it('survives a worker that dies after sending and before writing the step down: the retry sends nothing new', async () => {
    const session = newSession()
    const { runId } = await startSample(session, 'low-stock-reorder')
    let killed = 0
    harness.hooks.afterEffect = ({ nodeId }) => {
      if (nodeId === 'tell_purchasing' && killed === 0) {
        killed += 1
        throw new StepKilled()
      }
    }

    await drive(harness)
    harness.hooks.afterEffect = undefined

    expect(killed).toBe(1)
    const run = await view(session, runId)
    expect(run.status).toBe('succeeded')
    // The message went out exactly once, though the step ran twice.
    expect(await count('sandbox_deliveries', 'root_run_id = $1 AND node_id = \'tell_purchasing\'', [runId])).toBe(1)
    expect(run.steps.find(step => step.nodeId === 'tell_purchasing')?.attempts).toBe(2)
    const events = run.events.filter(event => 'nodeId' in event && event.nodeId === 'tell_purchasing').map(event => event.type)
    expect(events).toEqual(['step.started', 'step.started', 'effect.duplicate_suppressed', 'step.succeeded'])
    // The log says honestly what happened: the duplicate was this run's own earlier attempt.
    expect(run.events.find(event => event.type === 'effect.duplicate_suppressed')).toMatchObject({ nodeId: 'tell_purchasing', originalRunId: runId })
    // The row the worker never acknowledged is acknowledged now.
    const { rows } = await harness.database.pool.query('SELECT status, message_id FROM outbox WHERE root_run_id = $1 AND node_id = $2', [runId, 'tell_purchasing'])
    expect(rows).toMatchObject([{ status: 'delivered', message_id: expect.stringMatching(/^msg-[0-9a-f]{8}$/) }])
    // And the other effect of the run, which no worker died on, was sent once as usual.
    expect(await listSent(harness.deps.db, session)).toHaveLength(2)
  })

  it('does nothing when the same job runs twice', async () => {
    const session = newSession()
    const { runId } = await startSample(session, 'low-stock-reorder')
    const job = harness.scheduler.jobs.filter(candidate => candidate.runId === runId)
    expect(job).toHaveLength(2)

    await runStep(harness.deps, runId, 'tell_purchasing')
    await runStep(harness.deps, runId, 'tell_purchasing')

    const run = await view(session, runId)
    expect(run.steps.find(step => step.nodeId === 'tell_purchasing')?.attempts).toBe(1)
    expect(run.events.filter(event => event.type === 'step.started')).toHaveLength(1)
    expect(await count('sandbox_deliveries', 'root_run_id = $1', [runId])).toBe(1)
    await drive(harness)
  })

  it('refuses to answer a key reused for different content with the first send', async () => {
    const session = newSession()
    const { runId } = await startSample(session, 'low-stock-reorder')
    await harness.database.pool.query(
      `INSERT INTO outbox (idempotency_key, workflow_id, root_run_id, first_run_id, node_id, connector, payload, payload_hash)
       SELECT id::text || ':tell_purchasing', workflow_id, id, id, 'tell_purchasing', 'slack_alert', '{"channel":"#alerts","message":"something else"}', 'not-the-same-hash'
       FROM runs WHERE id = $1`,
      [runId],
    )

    await drive(harness)

    const run = await view(session, runId)
    expect(run.steps.find(step => step.nodeId === 'tell_purchasing')).toMatchObject({ status: 'failed', attempts: 1, error: { code: 'idempotency_conflict' } })
    expect(await count('sandbox_deliveries', 'root_run_id = $1 AND node_id = \'tell_purchasing\'', [runId])).toBe(0)
  })

  it('records the intent before it sends, and acknowledges it only when the step is done', async () => {
    const session = newSession()
    const { runId } = await startSample(session, 'low-stock-reorder')
    const seen: { outbox: string[], deliveries: number }[] = []
    harness.hooks.afterEffect = async ({ nodeId }) => {
      const { rows } = await harness.database.pool.query('SELECT status FROM outbox WHERE root_run_id = $1 AND node_id = $2', [runId, nodeId])
      seen.push({ outbox: rows.map(row => row.status as string), deliveries: await count('sandbox_deliveries', 'root_run_id = $1 AND node_id = $2', [runId, nodeId]) })
    }

    await drive(harness)
    harness.hooks.afterEffect = undefined

    // At the moment of the send's aftermath the intent exists and is still pending, and the delivery is there.
    expect(seen).toEqual([{ outbox: ['pending'], deliveries: 1 }, { outbox: ['pending'], deliveries: 1 }])
    expect(await count('outbox', 'root_run_id = $1 AND status = \'delivered\'', [runId])).toBe(2)
  })
})

describe('steps that finish at the same moment', () => {
  it('start the step that waits for both exactly once, however they interleave', async () => {
    for (let round = 0; round < 12; round += 1) {
      // A visitor of its own each round, so the daily allowance of runs is not what ends the test.
      const session = newSession()
      const workflowId = await createWorkflow(harness.deps, { sessionKey: session, graph: diamond, origin: 'sample', description: null, modelCalls: 0, traceRunId: null })
      const runId = await startRun(harness.deps, session, workflowId, { input: { note: 'Test run' } })
      const mine = harness.scheduler.jobs.filter(job => job.runId === runId)
      expect(mine.map(job => job.nodeId).sort()).toEqual(['left', 'right'])
      harness.scheduler.jobs.splice(0, harness.scheduler.jobs.length)

      await Promise.all([runStep(harness.deps, runId, 'left'), runStep(harness.deps, runId, 'right')])

      const joins = harness.scheduler.jobs.filter(job => job.runId === runId && job.nodeId === 'join')
      expect(joins, `round ${round}`).toHaveLength(1)
      await drive(harness)
      const run = await view(session, runId)
      expect(run.status, `round ${round}`).toBe('succeeded')
      expect(run.steps.find(step => step.nodeId === 'join')?.attempts).toBe(1)
      expect(run.events.filter(event => event.type === 'step.started' && event.nodeId === 'join')).toHaveLength(1)
      expect(types(run).filter(type => type === 'run.succeeded')).toHaveLength(1)
      // Events are numbered without gaps even though two transactions wrote them at once.
      expect(run.events.map(event => event.seq)).toEqual(Array.from({ length: run.events.length }, (_, index) => index + 1))
    }
  })

  it('lets the sibling of a failed step finish, then ends the run as failed with one event saying so', async () => {
    const session = newSession()
    const workflowId = await createWorkflow(harness.deps, { sessionKey: session, graph: diamond, origin: 'sample', description: null, modelCalls: 0, traceRunId: null })
    const runId = await startRun(harness.deps, session, workflowId, { input: { note: 'Test run' }, failures: [{ nodeId: 'left', times: 5 }] })
    harness.scheduler.jobs.splice(0, harness.scheduler.jobs.length)

    // The left step fails for the last time while the right step is still running.
    await expect(runStep(harness.deps, runId, 'left')).rejects.toMatchObject({ retry: true })
    await expect(runStep(harness.deps, runId, 'left')).rejects.toMatchObject({ retry: true })
    let released: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      released = resolve
    })
    harness.hooks.afterEffect = async ({ nodeId }) => {
      if (nodeId === 'right') await gate
    }
    const right = runStep(harness.deps, runId, 'right')
    await new Promise(resolve => setTimeout(resolve, 100))
    await expect(runStep(harness.deps, runId, 'left')).rejects.toMatchObject({ retry: false })

    const midway = await view(session, runId)
    expect(midway.status).toBe('running')
    expect(types(midway)).not.toContain('run.failed')

    released()
    await right
    harness.hooks.afterEffect = undefined

    const done = await view(session, runId)
    expect(done.status).toBe('failed')
    expect(statuses(done)).toMatchObject({ left: 'failed', right: 'succeeded', join: 'pending' })
    expect(types(done).filter(type => type === 'run.failed')).toHaveLength(1)
    expect(types(done).at(-1)).toBe('run.failed')
    // Two steps finished at the same moment, and exactly one of them ended the run and wrote its root.
    expect(spansOf(runId).filter(span => span.kind === 'system.run')).toHaveLength(1)
    expect(harness.scheduler.jobs.some(job => job.runId === runId && job.nodeId === 'join')).toBe(false)
  })
})

describe('what a visitor may do each day', () => {
  it('starts ten runs, and refuses the eleventh with the time until the allowance resets', async () => {
    const session = newSession()
    const { workflowId, input } = await workflowFromSample(harness, session, 'low-stock-reorder')
    for (let run = 0; run < 10; run += 1) await startRun(harness.deps, session, workflowId, { input })

    await expect(startRun(harness.deps, session, workflowId, { input })).rejects.toMatchObject({ status: 429, code: 'daily_limit', details: { retryAfterSeconds: expect.any(Number), resetsAt: expect.stringMatching(/T00:00:00\.000Z$/) } })

    const limits = await limitsOf(harness.deps.db, session, harness.deps.now())
    expect(limits.runs).toEqual({ limit: 10, used: 10, remaining: 0 })
    expect(limits.generations).toEqual({ limit: 10, used: 0, remaining: 10 })
    expect(new Date(limits.resetsAt).getTime()).toBeGreaterThan(Date.now())
    expect(await count('runs', 'session_key = $1', [session])).toBe(10)
    await drive(harness)
  })

  it('never lets ten allowed places go to more than ten of fifteen simultaneous requests', async () => {
    const session = newSession()
    const { workflowId, input } = await workflowFromSample(harness, session, 'low-stock-reorder')

    const results = await Promise.allSettled(Array.from({ length: 15 }, () => startRun(harness.deps, session, workflowId, { input })))

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(10)
    expect(results.filter(result => result.status === 'rejected' && (result.reason as { code?: string }).code === 'daily_limit')).toHaveLength(5)
    expect(await count('runs', 'session_key = $1', [session])).toBe(10)
    await drive(harness)
  })

  it('counts a replay as a run', async () => {
    const session = newSession()
    const { workflowId, input } = await workflowFromSample(harness, session, 'low-stock-reorder')
    const first = await startRun(harness.deps, session, workflowId, { input })
    for (let run = 0; run < 8; run += 1) await startRun(harness.deps, session, workflowId, { input })
    await drive(harness)

    await replayRun(harness.deps, session, first)
    await expect(replayRun(harness.deps, session, first)).rejects.toMatchObject({ status: 429, code: 'daily_limit' })
    await drive(harness)
  })

  it('takes nothing for a request that is refused before it starts anything', async () => {
    const session = newSession()
    const { workflowId, input } = await workflowFromSample(harness, session, 'wholesale-order')

    await expect(startRun(harness.deps, session, workflowId, { input: { ...input, totalEur: 'a lot' } })).rejects.toMatchObject({ status: 422, code: 'invalid_input', details: { fields: 'totalEur' } })
    await expect(startRun(harness.deps, session, workflowId, { input: { ...input, secretKey: 'x' } })).rejects.toMatchObject({ status: 422, code: 'invalid_input', details: { fields: 'input' } })
    await expect(startRun(harness.deps, session, workflowId, { input, failures: [{ nodeId: 'big_order', times: 1 }] })).rejects.toMatchObject({ status: 422, code: 'invalid_failure' })
    await expect(startRun(harness.deps, session, workflowId, { input, failures: [{ nodeId: 'check_stock', times: 1 }, { nodeId: 'check_stock', times: 2 }] })).rejects.toMatchObject({ status: 422, code: 'invalid_failure' })
    await expect(startRun(harness.deps, session, workflowId, { input, version: 7 })).rejects.toMatchObject({ status: 404 })

    expect((await limitsOf(harness.deps.db, session, harness.deps.now())).runs.used).toBe(0)
    expect(await count('runs', 'session_key = $1', [session])).toBe(0)
  })

  it('gives the allowance back at the next 00:00 UTC', async () => {
    const session = newSession()
    const { workflowId, input } = await workflowFromSample(harness, session, 'low-stock-reorder')
    for (let run = 0; run < 10; run += 1) await startRun(harness.deps, session, workflowId, { input })
    await expect(startRun(harness.deps, session, workflowId, { input })).rejects.toMatchObject({ code: 'daily_limit' })

    harness.advance(26 * 3_600_000)

    await expect(startRun(harness.deps, session, workflowId, { input })).resolves.toBeDefined()
    harness.advance(-26 * 3_600_000)
    await drive(harness)
  })

  it('keeps twenty workflows a visitor at most, and thirty versions of each', async () => {
    const session = newSession()
    for (let made = 0; made < 20; made += 1) await workflowFromSample(harness, session, 'low-stock-reorder')
    await expect(workflowFromSample(harness, session, 'low-stock-reorder')).rejects.toMatchObject({ status: 409, code: 'workflow_limit' })

    const { workflowId } = await workflowFromSample(harness, newSession(), 'low-stock-reorder')
    expect(workflowId).toBeDefined()
  })

  it('saves versions that never change an earlier one, refuses a stale edit, and stops at thirty', async () => {
    const session = newSession()
    const { workflowId } = await workflowFromSample(harness, session, 'low-stock-reorder')
    const first = await readWorkflowView(harness.deps.db, session, workflowId)
    if (!first) throw new Error('missing')
    const renamed = { ...first.graph, name: 'Renamed' }

    await expect(saveVersion(harness.deps, session, workflowId, 1, renamed)).resolves.toBe(2)
    await expect(saveVersion(harness.deps, session, workflowId, 1, renamed)).rejects.toMatchObject({ status: 409, code: 'version_conflict' })

    const second = await readWorkflowView(harness.deps.db, session, workflowId)
    expect(second).toMatchObject({ name: 'Renamed', version: 2, description: null })
    expect(second?.versions.map(version => [version.version, version.origin])).toEqual([[2, 'edited'], [1, 'sample']])
    for (let version = 2; version < 30; version += 1) await saveVersion(harness.deps, session, workflowId, version, renamed)
    await expect(saveVersion(harness.deps, session, workflowId, 30, renamed)).rejects.toMatchObject({ status: 409, code: 'version_limit' })
  })

  it('runs the version a run was started on, even after the workflow is edited', async () => {
    const session = newSession()
    const { workflowId, input } = await workflowFromSample(harness, session, 'low-stock-reorder')
    const first = await readWorkflowView(harness.deps.db, session, workflowId)
    if (!first) throw new Error('missing')
    const quieter: WorkflowGraph = { ...first.graph, nodes: first.graph.nodes.filter(node => node.id !== 'reorder_task'), edges: first.graph.edges.filter(edge => edge.to !== 'reorder_task') }
    await saveVersion(harness.deps, session, workflowId, 1, quieter)

    const original = await startRun(harness.deps, session, workflowId, { input, version: 1 })
    const latest = await startRun(harness.deps, session, workflowId, { input })
    await drive(harness)

    expect((await view(session, original)).steps.map(step => step.nodeId)).toContain('reorder_task')
    expect((await view(session, latest)).steps.map(step => step.nodeId)).not.toContain('reorder_task')
    expect((await view(session, latest)).version).toBe(2)
  })
})

describe('one visitor\'s work is out of reach of another', () => {
  it('finds nothing of Alice\'s for Bob: not her workflows, runs, deliveries or dead letters', async () => {
    const { workflowId, runId } = await startSample(ALICE, 'wholesale-order', { failures: [{ nodeId: 'alert_roastery', times: 3 }] })
    await drive(harness)

    expect(await readRunView(harness.deps.db, BOB, runId)).toBeUndefined()
    expect(await readWorkflowView(harness.deps.db, BOB, workflowId)).toBeUndefined()
    expect(await listRuns(harness.deps.db, BOB)).toEqual([])
    expect(await listSent(harness.deps.db, BOB)).toEqual([])
    expect(await listSent(harness.deps.db, BOB, runId)).toEqual([])
    expect(await listDeadLetters(harness.deps.db, BOB)).toEqual([])
    await expect(startRun(harness.deps, BOB, workflowId, { input: { orderId: 'x' } })).rejects.toMatchObject({ status: 404, code: 'not_found' })
    await expect(replayRun(harness.deps, BOB, runId)).rejects.toMatchObject({ status: 404, code: 'not_found' })
    await expect(decide(harness.deps, BOB, runId, 'finance_ok', { decision: 'approved' })).rejects.toMatchObject({ status: 404 })
    await expect(saveVersion(harness.deps, BOB, workflowId, 1, (await readWorkflowView(harness.deps.db, ALICE, workflowId))!.graph)).rejects.toMatchObject({ status: 404 })
    expect(await deleteWorkflow(harness.deps.db, BOB, workflowId)).toBe(false)
    // Alice still has everything.
    expect(await readRunView(harness.deps.db, ALICE, runId)).toBeDefined()
    expect(await listDeadLetters(harness.deps.db, ALICE)).not.toEqual([])
  })

  it('deletes a workflow with everything that belongs to it, for the visitor who made it', async () => {
    const session = newSession()
    const { workflowId, runId } = await startSample(session, 'wholesale-order', { failures: [{ nodeId: 'alert_roastery', times: 3 }] })
    await drive(harness)

    expect(await deleteWorkflow(harness.deps.db, session, workflowId)).toBe(true)

    expect(await readRunView(harness.deps.db, session, runId)).toBeUndefined()
    for (const table of ['runs', 'outbox', 'sandbox_deliveries', 'dead_letters', 'faults']) {
      expect(await count(table, 'workflow_id = $1', [workflowId]), table).toBe(0)
    }
    for (const table of ['run_steps', 'run_events']) {
      expect(await count(table, 'run_id = $1', [runId]), table).toBe(0)
    }
  })
})

describe('what the engine checks again before it runs anything', () => {
  it('refuses to run a stored version that no longer passes validation', async () => {
    const session = newSession()
    const { workflowId, input } = await workflowFromSample(harness, session, 'wholesale-order')
    await harness.database.pool.query(`UPDATE workflow_versions SET graph = jsonb_set(graph, '{nodes,1,op}', '"approximately"') WHERE workflow_id = $1`, [workflowId])

    await expect(startRun(harness.deps, session, workflowId, { input })).rejects.toMatchObject({ status: 409, code: 'workflow_invalid', details: { problems: expect.any(Array) } })
    expect(await count('runs', 'workflow_id = $1', [workflowId])).toBe(0)
  })

  it('gives a step that lost its workflow nothing to do, and no error', async () => {
    const session = newSession()
    const { workflowId, runId } = await startSample(session, 'low-stock-reorder')
    await deleteWorkflow(harness.deps.db, session, workflowId)

    await expect(drive(harness)).resolves.toBeGreaterThan(0)

    expect(await count('sandbox_deliveries', 'root_run_id = $1', [runId])).toBe(0)
  })
})

describe('the sweep', () => {
  it('deletes workflows 24 hours after they were made, with everything of theirs, and nothing before', async () => {
    const session = newSession()
    const { workflowId, runId } = await startSample(session, 'wholesale-order')
    await drive(harness)

    harness.advance(23 * 3_600_000)
    expect(await deleteExpired(harness.deps)).toBe(0)
    expect(await readRunView(harness.deps.db, session, runId)).toBeDefined()

    harness.advance(2 * 3_600_000)
    expect(await deleteExpired(harness.deps)).toBeGreaterThanOrEqual(1)
    harness.advance(-25 * 3_600_000)

    expect(await readWorkflowView(harness.deps.db, session, workflowId)).toBeUndefined()
    expect(await count('runs', 'session_key = $1', [session])).toBe(0)
    expect(await count('sandbox_deliveries', 'session_key = $1', [session])).toBe(0)
    expect(await count('outbox', 'workflow_id = $1', [workflowId])).toBe(0)
    expect(await count('run_events', 'run_id = $1', [runId])).toBe(0)
  })

  it('keeps counting a day\'s runs after the workflows are gone, and forgets the counters of old days', async () => {
    const session = newSession()
    await startSample(session, 'low-stock-reorder')
    await drive(harness)
    harness.advance(25 * 3_600_000)
    await deleteExpired(harness.deps)
    harness.advance(-25 * 3_600_000)

    expect((await limitsOf(harness.deps.db, session, harness.deps.now())).runs.used).toBe(1)

    harness.advance(3 * 24 * 3_600_000)
    const report = await sweep(harness.deps)
    harness.advance(-3 * 24 * 3_600_000)

    expect(report.removedCounters).toBeGreaterThanOrEqual(1)
    expect((await limitsOf(harness.deps.db, session, harness.deps.now())).runs.used).toBe(0)
  })

  it('queues again a step that was ready but never queued, as after a crash between commit and queue', async () => {
    const session = newSession()
    const original = harness.scheduler.enqueue.bind(harness.scheduler)
    harness.scheduler.enqueue = async () => {
      throw new Error('redis is down')
    }
    const { runId } = await startSample(session, 'low-stock-reorder')
    harness.scheduler.enqueue = original

    const stuck = await view(session, runId)
    expect(stuck.status).toBe('queued')
    expect(statuses(stuck)).toMatchObject({ tell_purchasing: 'ready', reorder_task: 'ready' })
    expect(harness.scheduler.jobs.some(job => job.runId === runId)).toBe(false)

    expect(await requeueStale(harness.deps)).toBe(0)
    harness.advance(harness.deps.config.staleAfterMs + 1_000)
    const handled = await requeueStale(harness.deps)
    harness.advance(-(harness.deps.config.staleAfterMs + 1_000))

    expect(handled).toBeGreaterThanOrEqual(2)
    expect(harness.scheduler.jobs.filter(job => job.runId === runId).map(job => job.nodeId).sort()).toEqual(['reorder_task', 'tell_purchasing'])
    await drive(harness)
    expect((await view(session, runId)).status).toBe('succeeded')
  })

  it('queues again a step whose job was lost while it waited, and leaves a recently moved step alone', async () => {
    const session = newSession()
    const { runId } = await startSample(session, 'low-stock-reorder')
    harness.scheduler.jobs.splice(0, harness.scheduler.jobs.length)
    harness.advance(harness.deps.config.staleAfterMs + 1_000)

    const first = await requeueStale(harness.deps)
    const second = await requeueStale(harness.deps)
    harness.advance(-(harness.deps.config.staleAfterMs + 1_000))

    expect(first).toBeGreaterThanOrEqual(2)
    expect(second).toBe(0)
    await drive(harness)
    expect((await view(session, runId)).status).toBe('succeeded')
  })

  it('dead-letters, instead of running again, a step whose workers keep dying', async () => {
    const session = newSession()
    const { runId } = await startSample(session, 'low-stock-reorder')
    harness.scheduler.jobs.splice(0, harness.scheduler.jobs.length)
    await harness.database.pool.query(`UPDATE run_steps SET status = 'running', attempts = 3 WHERE run_id = $1 AND node_id = 'tell_purchasing'`, [runId])

    await runStep(harness.deps, runId, 'tell_purchasing')

    const run = await view(session, runId)
    expect(run.steps.find(step => step.nodeId === 'tell_purchasing')).toMatchObject({ status: 'failed', error: { code: 'attempts_exhausted' } })
    expect(await listDeadLetters(harness.deps.db, session)).toMatchObject([{ nodeId: 'tell_purchasing', attempts: 3 }])
    expect(await count('sandbox_deliveries', 'root_run_id = $1', [runId])).toBe(0)
    expect(harness.scheduler.parked.has(`${runId}/tell_purchasing`)).toBe(true)
    harness.scheduler.jobs.splice(0, harness.scheduler.jobs.length)
  })

  it('expires the parked copies of dead letters along with everything else', async () => {
    harness.scheduler.parked.set('x/y', { runId: 'x', nodeId: 'y', attempts: 3, code: 'connector_unavailable' })

    await sweep(harness.deps)

    expect(harness.scheduler.parked.size).toBe(0)
  })
})
