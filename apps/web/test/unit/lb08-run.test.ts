// Tests of a run as the board folds it from its log: the state of each step after every event, the
// retry that waits and its countdown, the dead letter, the approval, a run read whole from the
// back end's view, and the ledger of what the sandbox sent. The events come from the mock
// back end's engine (the same fold of the real engine's rules), not from a hand-written list.
import { Lb08Mock, readLb08Seed } from '@lb/api-clients/testing'
import { runEventSchema, runViewSchema, sentViewSchema } from '@lb/contracts'
import type { RunEvent, RunView, SentView } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { ledgerOf } from '~/boards/lb-08/run/effects'
import { applyEvents, deadLettered, failedAttempts, isOver, modelFromView, reconcile, retryLeftMs, waitingForApproval, withStatus } from '~/boards/lb-08/run/model'
import type { RunModel } from '~/boards/lb-08/run/model'

const seed = readLb08Seed()
const NOW = Date.parse('2026-10-05T09:00:00.000Z')
// The clock the mock and the board share. A second goes by between two reads of a run, as it does while a page waits on a retry.
const time = { now: NOW }

/** A fresh mock of LB-08 on the shared clock, which starts again at the same moment. */
function freshMock(): Lb08Mock {
  time.now = NOW
  return new Lb08Mock(seed, () => time.now)
}

/** Opens a sample as a workflow of a visitor and starts a run with its own test order. */
function start(mock: Lb08Mock, sampleId: string, failures?: { nodeId: string, times: number }[]): RunView {
  const workflow = mock.createWorkflow('s', { from: 'sample', sampleId }).body as { id: string }
  const input = seed.samples.find(sample => sample.id === sampleId)!.input
  return runViewSchema.parse(mock.startRun('s', workflow.id, { input, ...(failures ? { failures } : {}) }).body)
}

/** Reads the next page of events of a run, as the board's poll does. */
function poll(mock: Lb08Mock, runId: string, after: number): { status: RunView['status'], events: RunEvent[] } {
  time.now += 1_000
  const body = mock.runEvents('s', runId, after).body as { status: RunView['status'], events: unknown[] }
  return { status: body.status, events: body.events.map(event => runEventSchema.parse(event)) }
}

/** Follows a run the way the board does, folding each page into the model, until the run ends or waits for a person. */
function follow(mock: Lb08Mock, view: RunView, stopAt: RunView['status'][] = ['succeeded', 'failed']): RunModel {
  let model = modelFromView(view, time.now)
  for (let pollNumber = 0; pollNumber < 40; pollNumber += 1) {
    const page = poll(mock, view.id, model.lastSeq)
    model = withStatus(applyEvents(model, page.events, time.now), page.status)
    if (stopAt.includes(model.status)) return model
  }
  throw new Error('The run did not end.')
}

describe('folding a run\'s log', () => {
  it('follows a run from queued to succeeded, step by step, and keeps what each step produced', () => {
    const mock = freshMock()
    const started = start(mock, 'wholesale-order')
    const queued = modelFromView(started, time.now)

    expect(queued.status).toBe('queued')
    expect(queued.steps.map(step => `${step.nodeId}:${step.status}`)).toEqual(['order_received:succeeded', 'big_order:succeeded', 'check_stock:ready', 'alert_roastery:pending', 'email_cafe:pending'])
    expect(queued.lastSeq).toBe(started.events.length)

    const done = follow(mock, started)
    expect(done.status).toBe('succeeded')
    expect(done.steps.map(step => step.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded'])
    expect(done.steps.find(step => step.nodeId === 'check_stock')?.output).toEqual({ inStock: true, availableKg: 180, etaDays: 2, productName: 'Basalt Blend 1 kg' })
    expect(done.steps.every(step => step.attempts <= 1)).toBe(true)
    expect(isOver(done.status)).toBe(true)
    expect(done.events.map(event => event.seq)).toEqual(done.events.map((_, index) => index + 1))
  })

  it('passes over an event it has already folded, so a poll that overlaps the last one does no harm', () => {
    const mock = freshMock()
    const started = start(mock, 'low-stock-reorder')
    const once = follow(mock, started)

    const again = applyEvents(once, once.events, time.now)
    expect(again).toBe(once)
    expect(again.events).toHaveLength(once.events.length)
  })

  it('marks the steps a branch did not take as skipped, with the reason', () => {
    const mock = freshMock()
    const workflow = mock.createWorkflow('s', { from: 'sample', sampleId: 'wholesale-order' }).body as { id: string }
    const view = runViewSchema.parse(mock.startRun('s', workflow.id, { input: { ...seed.samples[0]!.input, totalEur: 100 } }).body)
    const done = follow(mock, view)

    expect(done.steps.filter(step => step.status === 'skipped').map(step => `${step.nodeId}:${step.skipped}`)).toEqual(['check_stock:branch_not_taken', 'alert_roastery:upstream_skipped', 'email_cafe:upstream_skipped'])
  })

  it('shows a step waiting for its next attempt with the wait the queue announced, counting down from when the board saw the failure', () => {
    const mock = freshMock()
    const started = start(mock, 'low-stock-reorder', [{ nodeId: 'tell_purchasing', times: 2 }])
    let model = modelFromView(started, time.now)
    let waiting: RunModel | undefined
    for (let pollNumber = 0; pollNumber < 10 && !waiting; pollNumber += 1) {
      const page = poll(mock, started.id, model.lastSeq)
      model = withStatus(applyEvents(model, page.events, time.now), page.status)
      if (model.steps.find(step => step.nodeId === 'tell_purchasing')?.status === 'queued') waiting = model
    }

    const step = waiting!.steps.find(candidate => candidate.nodeId === 'tell_purchasing')!
    const seenAt = time.now
    expect(step).toMatchObject({ status: 'queued', attempts: 1, maxAttempts: 3, error: { code: 'connector_unavailable' }, retry: { attempt: 1, inMs: 1_000, seenAt } })
    expect(retryLeftMs(step, seenAt)).toBe(1_000)
    expect(retryLeftMs(step, seenAt + 400)).toBe(600)
    expect(retryLeftMs(step, seenAt + 5_000)).toBe(0)
    // A timer that last ticked a moment before the failure was seen must not add to the wait the queue gave.
    expect(retryLeftMs(step, seenAt - 250)).toBe(1_000)

    const done = follow(mock, started)
    const finished = done.steps.find(candidate => candidate.nodeId === 'tell_purchasing')!
    expect(finished).toMatchObject({ status: 'succeeded', attempts: 3, retry: undefined, error: null })
    expect(retryLeftMs(finished, time.now)).toBe(0)
    expect(failedAttempts(done, 'tell_purchasing')).toBe(2)
    const failures = done.events.filter(event => event.type === 'step.failed')
    expect(failures.map(event => (event.type === 'step.failed' ? event.retryInMs : 0))).toEqual([1_000, 2_000])
  })

  it('puts a step that used all its attempts in the dead-letter queue and fails the run', () => {
    const mock = freshMock()
    const done = follow(mock, start(mock, 'low-stock-reorder', [{ nodeId: 'tell_purchasing', times: 3 }]))

    expect(done.status).toBe('failed')
    expect(deadLettered(done).map(step => step.nodeId)).toEqual(['tell_purchasing'])
    expect(done.steps.find(step => step.nodeId === 'tell_purchasing')).toMatchObject({ status: 'failed', attempts: 3, deadLettered: true, retry: undefined, error: { code: 'connector_unavailable' } })
    expect(done.steps.find(step => step.nodeId === 'reorder_task')?.status).toBe('succeeded')
  })

  it('waits for an approval, with who is asked and the question, which the log does not carry and the full view does', () => {
    const mock = freshMock()
    const started = start(mock, 'refund-approval')
    const waiting = follow(mock, started, ['awaiting_approval'])

    expect(waiting.status).toBe('awaiting_approval')
    expect(waitingForApproval(waiting).map(step => `${step.nodeId}:${step.approver}`)).toEqual(['finance_ok:finance'])
    expect(waitingForApproval(waiting)[0]?.question).toBe('Approve a refund of €120 for order BB-1043?')

    // A model built from the log alone has no question; reading the run whole gives it back, and keeps the log's place.
    const fromLog: RunModel = { ...waiting, steps: waiting.steps.map(step => ({ ...step, question: undefined })) }
    expect(waitingForApproval(fromLog)[0]?.question).toBeUndefined()
    const read = reconcile(fromLog, runViewSchema.parse(mock.getRun('s', started.id).body), time.now)
    expect(waitingForApproval(read)[0]?.question).toBe('Approve a refund of €120 for order BB-1043?')
    expect(read.lastSeq).toBe(waiting.lastSeq)

    mock.decide('s', started.id, 'finance_ok', 'approved')
    const done = follow(mock, started)
    expect(done.steps.find(step => step.nodeId === 'finance_ok')).toMatchObject({ status: 'succeeded', decision: 'approved' })
    expect(done.steps.filter(step => step.status === 'skipped').map(step => step.nodeId)).toEqual(['email_declined', 'email_small'])
  })

  it('reads a finished run whole, as a visitor who comes back to it would: the same state as following it did', () => {
    const mock = freshMock()
    const started = start(mock, 'low-stock-reorder', [{ nodeId: 'tell_purchasing', times: 3 }])
    const followed = follow(mock, started)
    const whole = modelFromView(runViewSchema.parse(mock.getRun('s', started.id).body), time.now)

    expect(whole.status).toBe('failed')
    expect(whole.steps.map(step => `${step.nodeId}:${step.status}:${step.attempts}:${step.deadLettered}`)).toEqual(followed.steps.map(step => `${step.nodeId}:${step.status}:${step.attempts}:${step.deadLettered}`))
    expect(whole.events).toEqual(followed.events)
    expect(whole.lastSeq).toBe(followed.lastSeq)
  })

  it('keeps a retry\'s countdown when the full view is read while the step waits', () => {
    const mock = freshMock()
    const started = start(mock, 'low-stock-reorder', [{ nodeId: 'tell_purchasing', times: 2 }])
    let model = modelFromView(started, time.now)
    let seenAt = 0
    while (model.steps.find(step => step.nodeId === 'tell_purchasing')?.status !== 'queued') {
      const page = poll(mock, started.id, model.lastSeq)
      seenAt = time.now
      model = withStatus(applyEvents(model, page.events, seenAt), page.status)
    }
    const read = reconcile(model, runViewSchema.parse(mock.getRun('s', started.id).body), seenAt + 700)

    expect(read.steps.find(step => step.nodeId === 'tell_purchasing')?.retry).toMatchObject({ attempt: 1, inMs: 1_000, seenAt })
  })
})

describe('what the sandbox sent', () => {
  /** Reads the sandbox's deliveries for a chain. */
  function sentOf(mock: Lb08Mock, rootRunId: string): SentView[] {
    return (mock.sent('s', rootRunId).body as unknown[]).map(row => sentViewSchema.parse(row))
  }

  it('lists each thing once, with the text that was sent, and counts the attempts that failed first', () => {
    const mock = freshMock()
    const started = start(mock, 'low-stock-reorder', [{ nodeId: 'tell_purchasing', times: 2 }])
    const run = follow(mock, started)
    const ledger = ledgerOf([run], sentOf(mock, run.rootRunId))

    expect(ledger.rows.map(row => `${row.nodeId}:${row.connector}:${row.failedAttempts}`).sort()).toEqual(['reorder_task:create_task:0', 'tell_purchasing:slack_alert:2'])
    expect(ledger.rows.find(row => row.nodeId === 'tell_purchasing')?.content).toMatchObject({ channel: '#purchasing', message: 'guji-filter-1kg is down to 22 kg (alert level 30 kg).' })
    expect(ledger).toMatchObject({ recorded: 2, sentEvents: 2, suppressed: 0, failedBeforeSending: 2, once: true })
  })

  it('shows a replay sending nothing twice: what the first run sent is recognised, and what failed goes out now', () => {
    const mock = freshMock()
    const started = start(mock, 'low-stock-reorder', [{ nodeId: 'tell_purchasing', times: 3 }])
    const first = follow(mock, started)
    const replayView = runViewSchema.parse(mock.replayRun('s', started.id).body)
    const replay = follow(mock, replayView)
    const ledger = ledgerOf([first, replay], sentOf(mock, first.rootRunId))

    expect(replay.replayOf).toBe(started.id)
    expect(replay.rootRunId).toBe(first.rootRunId)
    expect(ledger.rows.find(row => row.nodeId === 'reorder_task')).toMatchObject({ sentInRun: first.id, recognisedIn: [replay.id] })
    expect(ledger.rows.find(row => row.nodeId === 'tell_purchasing')).toMatchObject({ sentInRun: replay.id, recognisedIn: [] })
    expect(ledger).toMatchObject({ recorded: 2, sentEvents: 2, suppressed: 1, once: true })
  })

  it('does not claim the proof before the sandbox\'s table has been read', () => {
    const mock = freshMock()
    const run = follow(mock, start(mock, 'low-stock-reorder'))

    expect(ledgerOf([run], undefined)).toMatchObject({ recorded: 0, sentEvents: 2, once: false })
    expect(ledgerOf([run], undefined).rows.every(row => row.content === undefined)).toBe(true)
  })
})
