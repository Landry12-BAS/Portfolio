// Tests for the rules of how a run moves through its graph (engine/flow.ts): which steps
// may start, which can never run, and where the run as a whole is. The rules are pure, so
// these tests need no database: they give `advance` a graph and where every step stands,
// and check what it decides.
import type { BranchLabel, StepStatus, WorkflowGraph } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { advance, isInFlight, runStatusOf } from '../../src/modules/lb08/engine/flow.ts'
import type { StepProgress } from '../../src/modules/lb08/engine/flow.ts'
import { loadSamples } from '../support/data.ts'

/** Returns the graph of one of the curated samples. */
function sampleGraph(id: string): WorkflowGraph {
  const sample = loadSamples().find(candidate => candidate.id === id)
  if (!sample) throw new Error(`No sample called ${id}.`)
  return sample.graph
}

/** Says where steps stand: every step is pending except those given, which take the state they are listed with. */
function progress(graph: WorkflowGraph, standing: Record<string, StepStatus | [StepStatus, BranchLabel]>): Map<string, StepProgress> {
  const map = new Map<string, StepProgress>()
  for (const node of graph.nodes) {
    const given = standing[node.id]
    if (Array.isArray(given)) map.set(node.id, { status: given[0], branch: given[1] })
    else map.set(node.id, { status: given ?? 'pending', branch: null })
  }
  return map
}

/** A diamond: the trigger feeds two steps, and a third waits for both. */
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

describe('advance', () => {
  const wholesale = sampleGraph('wholesale-order')
  const refund = sampleGraph('refund-approval')

  it('starts with the step after the trigger, and nothing beyond it', () => {
    const next = advance(wholesale, progress(wholesale, { order_received: 'succeeded' }))

    expect(next).toEqual({ ready: ['big_order'], skipped: [] })
  })

  it('follows the branch a condition chose, and only that one', () => {
    const next = advance(wholesale, progress(wholesale, { order_received: 'succeeded', big_order: ['succeeded', 'true'] }))

    expect(next).toEqual({ ready: ['check_stock'], skipped: [] })
  })

  it('skips the whole branch a condition did not take, naming the reason for each step', () => {
    const next = advance(wholesale, progress(wholesale, { order_received: 'succeeded', big_order: ['succeeded', 'false'] }))

    expect(next.ready).toEqual([])
    expect(next.skipped).toEqual([
      { nodeId: 'check_stock', reason: 'branch_not_taken' },
      { nodeId: 'alert_roastery', reason: 'upstream_skipped' },
      { nodeId: 'email_cafe', reason: 'upstream_skipped' },
    ])
  })

  it('starts both steps that follow one step, so they can run side by side', () => {
    const next = advance(wholesale, progress(wholesale, { order_received: 'succeeded', big_order: ['succeeded', 'true'], check_stock: 'succeeded' }))

    expect(next.ready).toEqual(['alert_roastery', 'email_cafe'])
  })

  it('waits at a join until every step before it has an answer', () => {
    const oneDone = advance(diamond, progress(diamond, { start: 'succeeded', left: 'succeeded', right: 'running' }))
    const bothDone = advance(diamond, progress(diamond, { start: 'succeeded', left: 'succeeded', right: 'succeeded' }))

    expect(oneDone).toEqual({ ready: [], skipped: [] })
    expect(bothDone).toEqual({ ready: ['join'], skipped: [] })
  })

  it('runs a join when one way in is live and the other was skipped', () => {
    const next = advance(diamond, progress(diamond, { start: 'succeeded', left: 'succeeded', right: 'skipped' }))

    expect(next).toEqual({ ready: ['join'], skipped: [] })
  })

  it('skips a join when every way in was skipped', () => {
    const next = advance(diamond, progress(diamond, { start: 'succeeded', left: 'skipped', right: 'skipped' }))

    expect(next).toEqual({ ready: [], skipped: [{ nodeId: 'join', reason: 'upstream_skipped' }] })
  })

  it('never goes past a step that failed: its successors wait forever, and the run ends as failed', () => {
    const next = advance(diamond, progress(diamond, { start: 'succeeded', left: 'failed', right: 'succeeded' }))

    expect(next).toEqual({ ready: [], skipped: [] })
  })

  it('does not start a step that is waiting on a person', () => {
    const next = advance(refund, progress(refund, { refund_asked: 'succeeded', over_100: ['succeeded', 'true'], finance_ok: 'awaiting_approval' }))

    expect(next).toEqual({ ready: [], skipped: [{ nodeId: 'email_small', reason: 'branch_not_taken' }] })
  })

  it('goes down the branch a person chose, and skips the other', () => {
    const approved = advance(refund, progress(refund, { refund_asked: 'succeeded', over_100: ['succeeded', 'true'], email_small: 'skipped', finance_ok: ['succeeded', 'approved'] }))
    const rejected = advance(refund, progress(refund, { refund_asked: 'succeeded', over_100: ['succeeded', 'true'], email_small: 'skipped', finance_ok: ['succeeded', 'rejected'] }))

    expect(approved.ready).toEqual(['tell_accounting', 'email_refunded'])
    expect(approved.skipped).toEqual([{ nodeId: 'email_declined', reason: 'branch_not_taken' }])
    expect(rejected.ready).toEqual(['email_declined'])
    expect(rejected.skipped).toEqual([{ nodeId: 'tell_accounting', reason: 'branch_not_taken' }, { nodeId: 'email_refunded', reason: 'branch_not_taken' }])
  })

  it('decides nothing again for steps that already have a state', () => {
    const next = advance(diamond, progress(diamond, { start: 'succeeded', left: 'ready', right: 'queued', join: 'pending' }))

    expect(next).toEqual({ ready: [], skipped: [] })
  })

  it('skips a step nothing leads to, rather than leaving it pending for ever', () => {
    const orphaned: WorkflowGraph = { ...diamond, edges: diamond.edges.filter(edge => edge.to !== 'join') }

    const next = advance(orphaned, progress(orphaned, { start: 'succeeded' }))

    expect(next.skipped).toEqual([{ nodeId: 'join', reason: 'upstream_skipped' }])
  })
})

describe('runStatusOf', () => {
  const cases: { what: string, statuses: StepStatus[], started: boolean, expected: string }[] = [
    { what: 'a run whose first action waits for a worker', statuses: ['succeeded', 'queued', 'pending'], started: false, expected: 'queued' },
    { what: 'a run whose steps are being worked on', statuses: ['succeeded', 'running', 'pending'], started: true, expected: 'running' },
    { what: 'a run with a step ready for the queue, once started', statuses: ['succeeded', 'ready'], started: true, expected: 'running' },
    { what: 'a run that waits for a person while nothing else can move', statuses: ['succeeded', 'succeeded', 'awaiting_approval', 'pending'], started: true, expected: 'awaiting_approval' },
    { what: 'a run that waits for a person while another step still runs', statuses: ['succeeded', 'awaiting_approval', 'running'], started: true, expected: 'running' },
    { what: 'a run whose steps all succeeded or were skipped', statuses: ['succeeded', 'succeeded', 'skipped'], started: true, expected: 'succeeded' },
    { what: 'a run whose only step after the trigger was skipped', statuses: ['succeeded', 'skipped'], started: false, expected: 'succeeded' },
    { what: 'a run with a failed step and nothing in flight', statuses: ['succeeded', 'failed', 'pending'], started: true, expected: 'failed' },
    { what: 'a run with a failed step while another step still runs', statuses: ['succeeded', 'failed', 'running'], started: true, expected: 'running' },
    { what: 'a run with a failed step and a person still asked', statuses: ['succeeded', 'failed', 'awaiting_approval'], started: true, expected: 'failed' },
    { what: 'a run stuck with nothing moving and nobody asked (never shown as finished)', statuses: ['succeeded', 'pending'], started: true, expected: 'running' },
  ]

  it.each(cases)('says $what is $expected', ({ statuses, started, expected }) => {
    expect(runStatusOf(statuses, started)).toBe(expected)
  })

  it('knows which steps are still moving without anyone\'s help', () => {
    expect(['ready', 'queued', 'running'].every(status => isInFlight(status as StepStatus))).toBe(true)
    expect(['pending', 'awaiting_approval', 'succeeded', 'failed', 'skipped'].some(status => isInFlight(status as StepStatus))).toBe(false)
  })
})
