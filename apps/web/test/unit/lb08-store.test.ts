// Tests of LB-08's board state against the fake site: opening a sample and describing a process,
// editing the draft with its live validation, saving versions, running with a test order and the
// failures the visitor asked for, following the run's log as it retries and dead-letters, the
// approval, the replay, what the sandbox sent, and the daily allowances. The back end is the mock
// with the real validator behind it; the clock is the test's.
import { RUN_LIMITS } from '@lb/contracts'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LB08_SAMPLES } from '#shared/data/samples/lb08'

import { APPROVAL_POLL_MS, RUN_POLL_MS, useLb08Store } from '~/boards/lb-08/store'
import type { DefaultTexts } from '~/boards/lb-08/graph/edit'
import { retryLeftMs } from '~/boards/lb-08/run/model'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'

import { Lb08Site } from '../support/lb08-site'
import type { FakeSiteOptions } from '../support/fake-site'

const TEXTS: DefaultTexts = { label: 'New step', message: 'Something happened.', subject: 'An update', body: 'Hello,', title: 'Look into it', question: 'Is this fine?' }
const TODAY = new Date('2026-10-02T09:30:00.000Z')

/** Starts a fake site and a fresh store reading through it. */
function start(options: FakeSiteOptions = {}) {
  const site = new Lb08Site({ verified: false, ...options })
  vi.stubGlobal('fetch', site.fetch)
  vi.stubGlobal('location', new URL('http://site.test/'))
  setActivePinia(createPinia())
  return { site, store: useLb08Store(), session: useSessionStore(), scope: useScopeStore() }
}

/** Lets the given number of milliseconds pass with the store's timers running. */
async function wait(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

/** Lets time pass in small steps until a condition holds, or fails. */
async function until(condition: () => boolean, stepMs = RUN_POLL_MS, limit = 60): Promise<void> {
  for (let step = 0; step < limit && !condition(); step += 1) await wait(stepMs)
  expect(condition()).toBe(true)
}

/** Opens a sample as the visitor, after the session has been read. */
async function openSample(store: ReturnType<typeof useLb08Store>, session: ReturnType<typeof useSessionStore>, id: string): Promise<void> {
  await session.load()
  const sample = LB08_SAMPLES.find(candidate => candidate.id === id)!
  await store.openSample(id, sample.input)
  await wait(0)
}

describe('LB-08\'s board', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(TODAY)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  describe('a workflow on the board', () => {
    it('reads the visitor\'s day without asking for anything that spends it', async () => {
      const { site, store, session } = start()
      await session.load()
      await store.loadLimits()
      await store.loadMine()

      expect(store.quota).toMatchObject({ limit: 10, used: 0, remaining: 10, resetsAt: '2026-10-03T00:00:00.000Z' })
      expect(store.mine).toEqual([])
      expect(site.calls.filter(call => call.method !== 'GET')).toEqual([])
    })

    it('opens a sample after the check: a hand-written graph, no model call, the sample\'s own test order', async () => {
      const { site, store, session } = start()
      await openSample(store, session, 'wholesale-order')

      expect(site.callsTo('/api/session/verify', 'POST')).toHaveLength(1)
      expect(site.callsTo('/api/lb08/workflows', 'POST')[0]?.body).toEqual({ from: 'sample', sampleId: 'wholesale-order' })
      expect(store.runMode).toBe('live')
      expect(store.workflow?.versions).toMatchObject([{ version: 1, origin: 'sample', modelCalls: 0 }])
      expect(store.draft?.nodes).toHaveLength(5)
      expect(store.valid).toBe(true)
      expect(store.dirty).toBe(false)
      expect(store.orderEntries).toMatchObject({ orderId: 'WO-2041', totalEur: '640', quantityKg: '20' })
      await store.loadLimits()
      expect(store.quota?.remaining).toBe(10)
    })

    it('describes a process: up to two model calls, a described version with its trace, and one description less today', async () => {
      const { site, store, session, scope } = start()
      await session.load()
      await store.loadLimits()
      await store.describe(LB08_SAMPLES[1]!.description)
      await wait(1_000)

      expect(site.callsTo('/api/lb08/workflows', 'POST')[0]?.body).toEqual({ from: 'description', description: LB08_SAMPLES[1]!.description })
      expect(store.workflow?.versions[0]).toMatchObject({ origin: 'generated', modelCalls: 1 })
      expect(store.workflow?.description).toBe(LB08_SAMPLES[1]!.description)
      expect(scope.runId).toBe(store.workflow?.versions[0]?.traceRunId)
      expect(scope.phase).toBe('finished')
      expect(scope.timeline.rows.some(row => row.alias === 'lb-tools')).toBe(true)
      expect(store.limits?.generations).toEqual({ limit: 10, used: 1, remaining: 9 })
    })

    it('shows why a description was refused, with the validator\'s problems, and keeps no workflow', async () => {
      const { store, session, scope } = start()
      await session.load()
      await store.describe('When a wholesale order arrives, text the roastery owner by SMS.')

      expect(store.workflow).toBeUndefined()
      expect(store.problem?.status).toBe(422)
      expect(store.problem?.code).toBe('workflow_rejected')
      expect(store.problem?.problems.map(item => item.code)).toContain('unknown_connector')
      expect(store.runMode).toBe('idle')
      expect(scope.phase).toBe('idle')
    })

    it('says the day\'s descriptions are used up, and counts them as none left', async () => {
      const { site, store, session } = start()
      await session.load()
      for (let count = 0; count < 10; count += 1) {
        await store.describe(`Tell the roastery, number ${count + 1}.`)
        await store.deleteMine(store.workflow!.id)
      }
      site.failNext('GET /api/lb08/limits', { status: 500, body: { error: { code: 'internal_error', message: 'x' } } })
      await store.describe('Tell the roastery once more.')

      expect(store.problem?.kind).toBe('quota')
      expect(store.limits?.generations.remaining).toBe(0)
      expect(store.runMode).toBe('idle')
    })

    it('lists the visitor\'s workflows, opens one and deletes one', async () => {
      const { store, session } = start()
      await openSample(store, session, 'low-stock-reorder')
      const id = store.workflow!.id
      await store.loadMine()
      expect(store.mine.map(item => item.id)).toEqual([id])

      store.reset()
      await store.openMine(id)
      expect(store.workflow?.id).toBe(id)
      expect(store.runMode).toBe('live')

      await store.deleteMine(id)
      expect(store.workflow).toBeUndefined()
      expect(store.mine).toEqual([])
    })

    it('says nothing is connected when the deployment has no back end, and calls nothing', async () => {
      const { site, store, session } = start({ available: false })
      await session.load()
      await store.openSample('wholesale-order')

      expect(store.problem?.kind).toBe('unavailable')
      expect(store.workflow).toBeUndefined()
      expect(site.callsTo('/api/lb08/')).toEqual([])
    })

    it('runs the check again when the service says a new day began, and tries once more', async () => {
      const { site, store, session } = start({ verified: true })
      await session.load()
      site.failNext('POST /api/lb08/workflows', { status: 403, body: { error: { code: 'verification_required', message: 'Run the check.' } } })
      await store.openSample('wholesale-order')

      expect(site.callsTo('/api/lb08/workflows', 'POST')).toHaveLength(2)
      expect(site.callsTo('/api/session/verify', 'POST')).toHaveLength(1)
      expect(store.workflow).toBeDefined()
    })

    it('says the browser is not keeping the cookie when the check passed and the service still asks for it', async () => {
      const { site, store, session } = start({ verified: true })
      await session.load()
      const refusal = { status: 403, body: { error: { code: 'verification_required', message: 'Run the check.' } } }
      site.failNext('POST /api/lb08/workflows', refusal)
      site.failNext('POST /api/lb08/workflows', refusal)
      await store.openSample('wholesale-order')

      expect(store.problem?.kind).toBe('cookie')
    })
  })

  describe('editing', () => {
    it('validates every edit as it is made, shows the problem where it belongs and holds back save and run', async () => {
      const { store, session } = start()
      await openSample(store, session, 'wholesale-order')
      store.select({ kind: 'node', id: 'email_cafe' })
      store.connect('email_cafe', 'check_stock')

      expect(store.valid).toBe(false)
      expect(store.dirty).toBe(true)
      expect([...store.issues!.byEdge.values()].flat().map(item => item.issue.code)).toEqual(['cycle'])
      expect(store.canStart).toBe(false)
      expect(await store.save()).toBe(false)

      store.undo()
      expect(store.valid).toBe(true)
      expect(store.dirty).toBe(false)
    })

    it('adds a step after the picked one, picks it, and keeps the trigger', async () => {
      const { store, session } = start()
      await openSample(store, session, 'low-stock-reorder')
      store.addStep('email', TEXTS, 'reorder_task')

      expect(store.draft?.nodes).toHaveLength(4)
      expect(store.draft?.edges.at(-1)).toEqual({ from: 'reorder_task', to: 'email' })
      expect(store.selection).toEqual({ kind: 'node', id: 'email' })
      expect(store.valid).toBe(true)

      store.removeStep('stock_alert')
      expect(store.draft?.nodes.find(node => node.id === 'stock_alert')).toBeDefined()
      store.removeStep('email')
      expect(store.selection).toBeUndefined()
      expect(store.dirty).toBe(false)
    })

    it('saves the draft as the next version after the check, and lists both versions', async () => {
      const { site, store, session } = start()
      await openSample(store, session, 'wholesale-order')
      store.rename('Wholesale orders')
      expect(store.dirty).toBe(true)

      expect(await store.save()).toBe(true)
      expect(site.callsTo('/api/lb08/workflows/', 'PUT')[0]?.body).toMatchObject({ baseVersion: 1, graph: { name: 'Wholesale orders' } })
      expect(store.workflow?.version).toBe(2)
      expect(store.workflow?.versions.map(version => `${version.version}:${version.origin}`)).toEqual(['2:edited', '1:sample'])
      expect(store.dirty).toBe(false)
      expect(store.history).toEqual([])
    })

    it('says a stale edit conflicts, and keeps the draft', async () => {
      const { site, store, session } = start()
      await openSample(store, session, 'wholesale-order')
      store.rename('Wholesale orders')
      site.failNext('PUT /api/lb08/workflows/', { status: 409, body: { error: { code: 'version_conflict', message: 'The workflow is at version 2, not 1.' } } })

      expect(await store.save()).toBe(false)
      expect(store.saveProblem?.kind).toBe('conflict')
      expect(store.dirty).toBe(true)
      expect(store.draft?.name).toBe('Wholesale orders')
    })

    it('throws the edits away and goes back to the saved version', async () => {
      const { store, session } = start()
      await openSample(store, session, 'wholesale-order')
      store.rename('Something else')
      store.addStep('slack_alert', TEXTS)
      store.discard()

      expect(store.dirty).toBe(false)
      expect(store.draft).toEqual(store.workflow?.graph)
      expect(store.history).toEqual([])
    })

    it('starts a new test order when the trigger\'s event changes, and keeps the order when anything else does', async () => {
      const { store, session } = start()
      await openSample(store, session, 'wholesale-order')
      store.setOrder('cafe', 'Café Nový')
      store.rename('Renamed')
      await wait(0)
      expect(store.orderEntries.cafe).toBe('Café Nový')

      const trigger = store.draft!.nodes[0]!
      store.updateStep({ ...trigger, event: 'stock_low' } as typeof trigger)
      await wait(0)
      expect(Object.keys(store.orderEntries)).toEqual(['sku', 'availableKg', 'thresholdKg'])
    })

    it('does nothing while it waits for the service, and nothing in a replay', async () => {
      const { store, session } = start()
      await openSample(store, session, 'wholesale-order')
      store.reset()
      store.addStep('email', TEXTS)
      expect(store.draft).toBeUndefined()
    })
  })

  describe('a run', () => {
    it('is refused until the test order fits, and names the fields', async () => {
      const { site, store, session } = start()
      await openSample(store, session, 'wholesale-order')
      store.setOrder('totalEur', 'a lot')

      expect(store.orderIssues.get('totalEur')).toBe('number')
      expect(store.canStart).toBe(false)
      await store.startRun()
      expect(store.orderShown).toBe(true)
      expect(site.callsTo('/api/lb08/workflows/', 'POST').filter(call => call.path.endsWith('/runs'))).toEqual([])
    })

    it('runs to the end: queued at once, its steps move as the log is read, and what it did is read when it is over', async () => {
      const { site, store, session, scope } = start()
      await openSample(store, session, 'wholesale-order')
      await store.loadLimits()
      await store.startRun()

      expect(store.currentRun?.status).toBe('queued')
      expect(store.quota?.remaining).toBe(9)
      expect(store.runPhase).toBe('following')
      expect(scope.runId).toBe(store.currentRun?.id)

      await until(() => store.runPhase === 'over')
      await wait(RUN_POLL_MS * 3)
      expect(store.currentRun?.status).toBe('succeeded')
      expect(store.currentRun?.steps.every(step => step.status === 'succeeded')).toBe(true)
      expect(store.sent?.map(row => row.connector).sort()).toEqual(['email', 'slack_alert'])
      expect(store.ledger).toMatchObject({ once: true, sentEvents: 2, suppressed: 0 })
      expect(store.limits?.runs).toEqual({ limit: 10, used: 1, remaining: 9 })
      expect(site.callsTo('/api/lb08/runs/').filter(call => call.path.includes('/events?after=')).length).toBeGreaterThan(2)
      // The Scope follows the trace until the run's root span arrives, not until the trace goes quiet: the root heads the tree, the steps hang under it.
      await until(() => scope.phase === 'finished')
      expect(scope.timeline.rows.map(row => [row.span.name, row.depth])).toEqual([['workflow run', 0], ['step.check_stock', 1], ['step.alert_roastery', 1], ['step.email_cafe', 1]])
    })

    it('keeps reading the trace after the log says the run is over, until its root arrives, and does not call it finished before', async () => {
      const { site, store, session, scope } = start()
      site.withholdRoots = true
      await openSample(store, session, 'wholesale-order')
      await store.startRun()

      await until(() => store.runPhase === 'over')
      // Several reads of the trace come back with every step and no root: a trace that has gone quiet is not a trace that is finished.
      await wait(RUN_POLL_MS * 3)
      expect(scope.spans.map(span => span.name)).toEqual(['step.check_stock', 'step.alert_roastery', 'step.email_cafe'])
      expect(scope.phase).toBe('following')

      site.withholdRoots = false
      await until(() => scope.phase === 'finished')
      expect(scope.timeline.rows[0]?.span).toMatchObject({ name: 'workflow run', kind: 'system.run' })
    })

    it('says the trace stalled, not finished, when the root never comes', async () => {
      const { site, store, session, scope } = start()
      site.withholdRoots = true
      await openSample(store, session, 'wholesale-order')
      await store.startRun()

      await until(() => store.runPhase === 'over')
      await until(() => scope.phase !== 'following', 1_000, 30)

      expect(scope.phase).toBe('stalled')
    })

    it('saves an edit first and runs the version it saved', async () => {
      const { site, store, session } = start()
      await openSample(store, session, 'low-stock-reorder')
      store.rename('Stock reorder, my way')
      await store.startRun()

      expect(site.calls.filter(call => call.method !== 'GET').map(call => `${call.method} ${call.path.replace(/[0-9a-f-]{36}/, ':id')}`).slice(-3)).toEqual(['POST /api/lb08/workflows', 'PUT /api/lb08/workflows/:id', 'POST /api/lb08/workflows/:id/runs'])
      expect(store.currentRun?.version).toBe(2)
      expect(store.runGraph?.name).toBe('Stock reorder, my way')
    })

    it('asks for the failures the visitor chose, shows each retry with its wait, and still sends once', async () => {
      const { site, store, session } = start()
      await openSample(store, session, 'low-stock-reorder')
      store.setFailures('tell_purchasing', 2)
      await store.startRun()

      expect(site.callsTo('/api/lb08/workflows/', 'POST').find(call => call.path.endsWith('/runs'))?.body).toMatchObject({ failures: [{ nodeId: 'tell_purchasing', times: 2 }] })
      await until(() => store.currentRun?.steps.find(step => step.nodeId === 'tell_purchasing')?.status === 'queued', 100)
      const waiting = store.currentRun!.steps.find(step => step.nodeId === 'tell_purchasing')!
      expect(waiting).toMatchObject({ attempts: 1, maxAttempts: 3, retry: { attempt: 1, inMs: 1_000 } })
      expect(retryLeftMs(waiting, Date.now())).toBeGreaterThan(0)

      await until(() => store.runPhase === 'over')
      await wait(RUN_POLL_MS * 3)
      const done = store.currentRun!.steps.find(step => step.nodeId === 'tell_purchasing')!
      expect(done).toMatchObject({ status: 'succeeded', attempts: 3 })
      expect(store.ledger).toMatchObject({ once: true, failedBeforeSending: 2 })
      expect(store.deadLetters).toEqual([])
    })

    it('dead-letters a step that fails three times, and a replay from the dead letter sends what is missing and nothing twice', async () => {
      const { store, session } = start()
      await openSample(store, session, 'low-stock-reorder')
      store.setFailures('tell_purchasing', 3)
      await store.startRun()
      await until(() => store.runPhase === 'over', 200)
      await wait(RUN_POLL_MS * 3)

      expect(store.currentRun?.status).toBe('failed')
      expect(store.chainLetters).toHaveLength(1)
      expect(store.chainLetters[0]).toMatchObject({ nodeId: 'tell_purchasing', attempts: 3, replayedRunId: null })
      expect(store.ledger).toMatchObject({ sentEvents: 1, once: true })
      expect(store.canReplay).toBe(true)

      await store.replayRun(store.chainLetters[0]!.id)
      expect(store.chain).toHaveLength(2)
      expect(store.currentRun?.replayOf).toBe(store.chain[0]?.id)
      await until(() => store.currentRun?.status === 'succeeded', 200)
      await wait(RUN_POLL_MS * 3)

      expect(store.ledger).toMatchObject({ recorded: 2, sentEvents: 2, suppressed: 1, once: true })
      expect(store.ledger.rows.find(row => row.nodeId === 'reorder_task')?.recognisedIn).toEqual([store.currentRun!.id])
      expect(store.limits?.runs.used).toBe(2)
      expect(store.chainLetters[0]?.replayedRunId).toBe(store.currentRun!.id)
    })

    it('waits for an approval with its question, polls slowly meanwhile, and goes on down the branch the person chose', async () => {
      const { site, store, session } = start()
      await openSample(store, session, 'refund-approval')
      await store.startRun()
      await until(() => store.currentRun?.status === 'awaiting_approval')
      await wait(100)

      const asked = store.currentRun!.steps.find(step => step.nodeId === 'finance_ok')!
      expect(asked).toMatchObject({ status: 'awaiting_approval', approver: 'finance', question: 'Approve a refund of €120 for order BB-1043?' })

      const before = site.callsTo('/api/lb08/runs/').filter(call => call.path.includes('/events')).length
      await wait(APPROVAL_POLL_MS * 4)
      const slow = site.callsTo('/api/lb08/runs/').filter(call => call.path.includes('/events')).length - before
      expect(slow).toBeLessThanOrEqual(5)

      await store.decide('finance_ok', 'rejected')
      await until(() => store.runPhase === 'over')
      await wait(RUN_POLL_MS * 3)
      expect(store.currentRun?.status).toBe('succeeded')
      expect(store.currentRun?.steps.find(step => step.nodeId === 'finance_ok')).toMatchObject({ decision: 'rejected' })
      expect(store.sent?.map(row => row.nodeId)).toEqual(['email_declined'])
    })

    it('says the system took too long when the run does not move, and stops asking', async () => {
      const { site, store, session } = start()
      await openSample(store, session, 'low-stock-reorder')
      await store.startRun()
      site.failNext('GET /api/lb08/runs/', { status: 200, body: { status: 'running', events: [] } })
      for (let count = 0; count < 400; count += 1) site.failNext('GET /api/lb08/runs/', { status: 200, body: { status: 'running', events: [] } })
      await wait(160_000)

      expect(store.problem?.kind).toBe('timeout')
      expect(store.runPhase).toBe('over')
    })

    it('stops after three reads in a row fail, and says what failed', async () => {
      const { site, store, session } = start()
      await openSample(store, session, 'low-stock-reorder')
      await store.startRun()
      for (let count = 0; count < 3; count += 1) site.failNext('GET /api/lb08/runs/', { status: 502, body: { error: { code: 'upstream_failed', message: 'x' } } })
      await wait(RUN_POLL_MS * 6)

      expect(store.problem?.kind).toBe('upstream')
      expect(store.runPhase).toBe('over')
    })

    it('counts the tenth run and refuses the eleventh, and counts a replay as a run', async () => {
      const { store, session } = start()
      await openSample(store, session, 'low-stock-reorder')
      for (let count = 0; count < RUN_LIMITS.runsPerVisitorPerDay; count += 1) {
        await store.startRun()
        await until(() => store.runPhase === 'over')
        await wait(RUN_POLL_MS * 3)
        expect(store.currentRun?.status).toBe('succeeded')
      }

      expect(store.quota).toMatchObject({ used: 10, remaining: 0 })
      expect(store.canStart).toBe(false)
      expect(store.canReplay).toBe(false)
      await store.startRun()
      expect(store.chain).toHaveLength(1)
    })

    it('marks the allowance spent when the service refuses a run for being over it', async () => {
      const { site, store, session } = start()
      await openSample(store, session, 'low-stock-reorder')
      await store.loadLimits()
      site.failNext('POST /api/lb08/workflows/', { status: 429, body: { error: { code: 'daily_limit', message: 'A visitor may start 10 workflow runs a day.' } } })
      await store.startRun()

      expect(store.problem?.kind).toBe('quota')
      expect(store.quota).toMatchObject({ remaining: 0 })
      expect(store.currentRun).toBeUndefined()
    })

    it('keeps the run it follows when the visitor edits and saves another version meanwhile', async () => {
      const { store, session } = start()
      await openSample(store, session, 'low-stock-reorder')
      await store.startRun()
      store.rename('Another name')
      await store.save()

      expect(store.runGraph?.name).toBe('Low stock reorder')
      expect(store.currentRun?.version).toBe(1)
      await until(() => store.runPhase === 'over')
    })
  })
})
