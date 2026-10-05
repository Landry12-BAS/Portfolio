// What the board works out of an incident's log, as plain functions. The log is the whole truth of
// an incident: every state change the simulator and the agents make is an event, numbered without
// gaps. The board keeps the events it has heard, merges new ones in by number, and derives from
// them what it draws (where the incident stands, what waits for the visitor, what the agents did,
// which minute each landmark happened at), so a live feed, a polled page and a recording all draw
// through the same code. Nothing here reads the clock or the network.
import { LB06_LIMITS } from '@lb/contracts'
import type { Lb06Event, Lb06EventOf, Lb06Hypothesis, Lb06PendingProposal, Lb06Slo, Lb06State } from '@lb/contracts'

/** The states an incident does not leave. */
export const ENDED_STATES = ['closed', 'aborted', 'failed'] as const satisfies readonly Lb06State[]

/** Tells whether a state is one an incident does not leave. */
export function isEnded(state: Lb06State): boolean {
  return (ENDED_STATES as readonly string[]).includes(state)
}

/** The number of the last event in a log, or 0 for an empty one. */
export function lastSeqOf(events: readonly Lb06Event[]): number {
  return events.at(-1)?.seq ?? 0
}

/** The simulated minute an incident has reached: the highest minute any event carries. */
export function minuteOf(events: readonly Lb06Event[]): number {
  return events.reduce((highest, event) => Math.max(highest, event.minute), 0)
}

/**
 * Merges events into the log the board holds: by number, in order, each number once, and at most as
 * many as the log can hold. The common case, events that follow the last one in order, only appends.
 */
export function mergeEvents(known: readonly Lb06Event[], incoming: readonly Lb06Event[]): readonly Lb06Event[] {
  if (incoming.length === 0) return known
  let previous = lastSeqOf(known)
  let ordered = true
  for (const event of incoming) {
    if (event.seq <= previous) {
      ordered = false
      break
    }
    previous = event.seq
  }
  if (ordered) return [...known, ...incoming].slice(0, LB06_LIMITS.maxEvents)
  const bySeq = new Map<number, Lb06Event>()
  for (const event of known) bySeq.set(event.seq, event)
  for (const event of incoming) bySeq.set(event.seq, event)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(0, LB06_LIMITS.maxEvents)
}

/**
 * Where an incident stands, read from the newest event that says so. The service's own view is the
 * authority, and it is read after the events that change it, but a live feed brings the events first,
 * so the board does not wait for the view to know that a proposal is waiting or that the fix went in.
 */
export function stateOf(events: readonly Lb06Event[], fallback: Lb06State): Lb06State {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    switch (events[index]?.kind) {
      case 'incident.closed': return 'closed'
      case 'incident.aborted': return 'aborted'
      case 'incident.failed': return 'failed'
      case 'postmortem.written':
      case 'slo.recovered':
        return 'writing_postmortem'
      case 'remediation.applied': return 'verifying'
      case 'proposal.approved': return 'remediating'
      case 'proposal.made': return 'awaiting_approval'
      case 'proposal.rejected':
      case 'agent.step':
      case 'hypotheses.ranked':
      case 'evidence.discarded':
      case 'investigation.started':
        return 'investigating'
      case 'alert.fired':
      case 'fault.injected':
        return 'detecting'
      case 'incident.started': return 'baseline'
      default: break
    }
  }
  return fallback
}

/** The proposal waiting for the visitor's answer: the newest one, if nothing has answered it or ended the incident since. */
export function pendingProposalOf(events: readonly Lb06Event[]): Lb06PendingProposal | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event) continue
    switch (event.kind) {
      case 'proposal.approved':
      case 'proposal.rejected':
      case 'remediation.applied':
      case 'incident.closed':
      case 'incident.aborted':
      case 'incident.failed':
        return undefined
      case 'proposal.made':
        return { id: event.data.proposalId, hypothesisId: event.data.hypothesisId, action: event.data.action, rationale: event.data.rationale }
      default: break
    }
  }
  return undefined
}

/** One step an agent took, with the minute and number of the event that recorded it. */
export type AgentRow = Lb06EventOf<'agent.step'>['data'] & { seq: number, minute: number }

/** The agents' steps in the order they were taken. */
export function agentRows(events: readonly Lb06Event[]): AgentRow[] {
  const rows: AgentRow[] = []
  for (const event of events) {
    if (event.kind === 'agent.step') rows.push({ ...event.data, seq: event.seq, minute: event.minute })
  }
  return rows
}

/**
 * How many model calls the log shows were spent: the highest step number, since each step carries the
 * count of calls spent when it was taken. A tool call the server ran costs none itself, but the model
 * call that chose it is counted, so the steps' own flags would count too few.
 */
export function modelCallsOf(events: readonly Lb06Event[]): number {
  let calls = 0
  for (const event of events) {
    if (event.kind === 'agent.step') calls = Math.max(calls, event.data.step)
  }
  return calls
}

/** How many pieces of evidence the server threw away because the log did not hold them, over the whole incident. */
export function discardedEvidence(events: readonly Lb06Event[]): number {
  let discarded = 0
  for (const event of events) {
    if (event.kind === 'evidence.discarded') discarded += event.data.count
  }
  return discarded
}

/** The commander's newest ranking of hypotheses, or undefined before it has ranked any. */
export function latestHypotheses(events: readonly Lb06Event[]): readonly Lb06Hypothesis[] | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.kind === 'hypotheses.ranked') return event.data.hypotheses
  }
  return undefined
}

/** What the SLO said at the newest minute, or undefined before the first tick. */
export function latestSlo(events: readonly Lb06Event[]): Lb06Slo | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.kind === 'tick') return event.data.slo
  }
  return undefined
}

/** The landmarks of an incident that the charts mark with a line and a letter. */
export type MarkerKind = 'fault' | 'alert' | 'investigation' | 'remediation' | 'recovered'

/** One landmark: what it is, the simulated minute it happened at, and the number of its event. */
export interface Marker {
  kind: MarkerKind
  minute: number
  seq: number
}

/** The landmarks the log holds, in the order they happened. */
export function markersOf(events: readonly Lb06Event[]): Marker[] {
  const markers: Marker[] = []
  for (const event of events) {
    switch (event.kind) {
      case 'fault.injected':
        markers.push({ kind: 'fault', minute: event.minute, seq: event.seq })
        break
      case 'alert.fired':
        markers.push({ kind: 'alert', minute: event.minute, seq: event.seq })
        break
      case 'investigation.started':
        markers.push({ kind: 'investigation', minute: event.minute, seq: event.seq })
        break
      case 'remediation.applied':
        markers.push({ kind: 'remediation', minute: event.minute, seq: event.seq })
        break
      case 'slo.recovered':
        markers.push({ kind: 'recovered', minute: event.minute, seq: event.seq })
        break
      default: break
    }
  }
  return markers
}

/** The events the timeline lists: everything but the ticks, which the charts draw, and the agents' steps, which have their own panel. */
export function timelineEvents(events: readonly Lb06Event[]): Lb06Event[] {
  return events.filter(event => event.kind !== 'tick' && event.kind !== 'agent.step')
}
