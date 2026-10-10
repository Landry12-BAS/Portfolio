// Tests of what the board works out of an incident's log (app/boards/lb-06/incident.ts), on a whole
// incident played by the mock's real simulator: where the incident stands at each point of its life,
// what waits for the visitor, what the agents did and what it cost, the landmarks the charts mark,
// and how events are merged when they arrive out of order, twice or in a burst.
import { LB06_LIMITS } from '@lb/contracts'
import type { Lb06Event } from '@lb/contracts'
import { beforeAll, describe, expect, it } from 'vitest'
import { agentRows, discardedEvidence, isEnded, lastSeqOf, latestHypotheses, latestSlo, markersOf, mergeEvents, minuteOf, modelCallsOf, pendingProposalOf, stateOf, timelineEvents } from '~/boards/lb-06/incident'
import { playIncident } from '../support/lb06-incident'
import type { PlayedIncident } from '../support/lb06-incident'

let incident: PlayedIncident

beforeAll(async () => {
  incident = await playIncident({ sampleId: 'bad-deploy' })
})

/** The events up to and including the first one of a kind. */
function through(kind: Lb06Event['kind']): Lb06Event[] {
  const index = incident.events.findIndex(event => event.kind === kind)
  if (index < 0) throw new Error(`The incident has no ${kind} event.`)
  return incident.events.slice(0, index + 1)
}

describe('the state of an incident, read from its log', () => {
  it('follows the incident from the calm before the fault to its close', () => {
    expect(stateOf(through('incident.started'), 'closed')).toBe('baseline')
    expect(stateOf(through('fault.injected'), 'baseline')).toBe('detecting')
    expect(stateOf(through('alert.fired'), 'baseline')).toBe('detecting')
    expect(stateOf(through('investigation.started'), 'baseline')).toBe('investigating')
    expect(stateOf(through('hypotheses.ranked'), 'baseline')).toBe('investigating')
    expect(stateOf(through('proposal.made'), 'baseline')).toBe('awaiting_approval')
    expect(stateOf(through('proposal.approved'), 'baseline')).toBe('remediating')
    expect(stateOf(through('remediation.applied'), 'baseline')).toBe('verifying')
    expect(stateOf(through('slo.recovered'), 'baseline')).toBe('writing_postmortem')
    expect(stateOf(incident.events, 'baseline')).toBe('closed')
  })

  it('agrees with the service about where the incident ended', () => {
    expect(stateOf(incident.events, 'baseline')).toBe(incident.view.state)
  })

  it('falls back to the service\'s view when the log says nothing yet', () => {
    expect(stateOf([], 'investigating')).toBe('investigating')
  })

  it('knows which states an incident does not leave', () => {
    expect(['closed', 'aborted', 'failed'].every(state => isEnded(state as never))).toBe(true)
    expect(['baseline', 'investigating', 'awaiting_approval', 'verifying'].some(state => isEnded(state as never))).toBe(false)
  })
})

describe('the proposal that waits', () => {
  it('is the newest one until it is answered, and nothing after', () => {
    const waiting = pendingProposalOf(through('proposal.made'))
    expect(waiting).toMatchObject({ id: 'p1', action: { kind: 'rollback', service: 'cart' } })
    expect(pendingProposalOf(through('proposal.approved'))).toBeUndefined()
    expect(pendingProposalOf(incident.events)).toBeUndefined()
    expect(pendingProposalOf(through('alert.fired'))).toBeUndefined()
  })

  it('comes back for the next proposal after the agents are sent back to work', async () => {
    const rejecting = await playIncident({ sampleId: 'bad-deploy', decision: 'reject' })
    const kinds = rejecting.events.map(event => event.kind)
    expect(kinds.filter(kind => kind === 'proposal.rejected').length).toBeGreaterThan(0)
    expect(kinds.filter(kind => kind === 'proposal.made').length).toBeGreaterThan(1)
    const afterFirstRejection = rejecting.events.slice(0, kinds.indexOf('proposal.rejected') + 1)
    expect(pendingProposalOf(afterFirstRejection)).toBeUndefined()
    expect(stateOf(afterFirstRejection, 'baseline')).toBe('investigating')
  })
})

describe('what the agents did', () => {
  it('lists their steps in order, and the model calls they cost match what the service counted', () => {
    const rows = agentRows(incident.events)
    expect(rows.length).toBeGreaterThan(5)
    expect(rows.map(row => row.step)).toEqual([...rows.map(row => row.step)].sort((a, b) => a - b))
    expect(rows[0]).toMatchObject({ agent: 'commander', kind: 'plan' })
    expect(modelCallsOf(incident.events)).toBe(incident.view.modelCalls)
    expect(modelCallsOf(incident.events)).toBeLessThanOrEqual(LB06_LIMITS.stepCap)
  })

  it('counts no model call for an incident whose agents\' answers came from an earlier run: its steps are stamped 1 and none cost a call', () => {
    const replayed = incident.events.map((event): Lb06Event => event.kind === 'agent.step' ? { ...event, data: { ...event.data, step: 1, modelCall: false } } : event)
    expect(modelCallsOf(replayed)).toBe(0)
    expect(modelCallsOf(replayed.slice(0, 3))).toBe(0)
    expect(agentRows(replayed).length).toBe(agentRows(incident.events).length)
    expect(agentRows(replayed).every(row => row.spent === 0)).toBe(true)
  })

  it('says for each step of a live incident how many calls had been spent when it was taken', () => {
    const rows = agentRows(incident.events)
    expect(rows.every(row => row.spent === row.step)).toBe(true)
    expect(rows[0]).toMatchObject({ kind: 'plan', spent: 1 })
  })

  it('counts the one call a replayed incident does make, such as the postmortem\'s', () => {
    const lastStep = incident.events.filter(event => event.kind === 'agent.step').at(-1)
    const replayed = incident.events.map((event): Lb06Event => {
      if (event.kind !== 'agent.step') return event
      return { ...event, data: { ...event.data, step: 1, modelCall: event === lastStep } }
    })
    expect(modelCallsOf(replayed)).toBe(1)
  })

  it('flags a tool call the server ran as free, while the calls spent so far keep counting the call that chose it', () => {
    const rows = agentRows(incident.events)
    const toolCalls = rows.filter(row => row.kind === 'tool_call')
    expect(toolCalls.length).toBeGreaterThan(0)
    expect(toolCalls.every(row => !row.modelCall)).toBe(true)
    expect(rows.filter(row => row.modelCall).length).toBeLessThan(modelCallsOf(incident.events))
  })

  it('finds the commander\'s ranking, with the true cause first, and no evidence thrown away in a clean run', () => {
    const ranked = latestHypotheses(incident.events)
    expect(ranked?.[0]).toMatchObject({ service: 'cart', cause: 'bad_deploy' })
    expect(discardedEvidence(incident.events)).toBe(0)
    expect(latestHypotheses(through('alert.fired'))).toBeUndefined()
  })

  it('reads the SLO at the newest minute', () => {
    expect(latestSlo(through('incident.started'))).toBeUndefined()
    expect(latestSlo(incident.events)).toMatchObject({ healthy: true, alerting: false })
    expect(latestSlo(through('alert.fired'))?.alerting).toBe(true)
  })
})

describe('the landmarks and the timeline', () => {
  it('marks the fault, the alert, the agents, the fix and the recovery, in order', () => {
    const markers = markersOf(incident.events)
    expect(markers.map(marker => marker.kind)).toEqual(['fault', 'alert', 'investigation', 'remediation', 'recovered'])
    expect(markers.map(marker => marker.minute)).toEqual([...markers.map(marker => marker.minute)].sort((a, b) => a - b))
    expect(markers[0]?.minute).toBe(incident.view.faultMinute)
    expect(markersOf(through('incident.started'))).toEqual([])
  })

  it('leaves the ticks and the agents\' steps out of the timeline', () => {
    const timeline = timelineEvents(incident.events)
    expect(timeline.some(event => event.kind === 'tick' || event.kind === 'agent.step')).toBe(false)
    expect(timeline.map(event => event.kind)).toContain('proposal.made')
    expect(timeline.at(-1)?.kind).toBe('incident.closed')
  })

  it('reads the highest minute and the last number of the log', () => {
    expect(minuteOf(incident.events)).toBe(incident.view.minute)
    expect(lastSeqOf(incident.events)).toBe(incident.view.lastSeq)
    expect(lastSeqOf([])).toBe(0)
    expect(minuteOf([])).toBe(0)
  })
})

describe('merging events', () => {
  it('appends events that follow the last one and returns the same list for none', () => {
    const first = incident.events.slice(0, 10)
    const rest = incident.events.slice(10, 20)
    const merged = mergeEvents(first, rest)
    expect(merged.map(event => event.seq)).toEqual(incident.events.slice(0, 20).map(event => event.seq))
    expect(mergeEvents(first, [])).toBe(first)
  })

  it('puts events that arrive out of order in order, and keeps each number once', () => {
    const early = incident.events.slice(0, 5)
    const merged = mergeEvents(incident.events.slice(5, 12), early)
    const again = mergeEvents(merged, incident.events.slice(3, 8))
    expect(again.map(event => event.seq)).toEqual(incident.events.slice(0, 12).map(event => event.seq))
  })

  it('holds no more events than the log can', () => {
    const many = Array.from({ length: LB06_LIMITS.maxEvents + 50 }, (_, index) => ({ ...incident.events[0]!, seq: index + 1 }) as Lb06Event)
    expect(mergeEvents([], many)).toHaveLength(LB06_LIMITS.maxEvents)
  })
})
