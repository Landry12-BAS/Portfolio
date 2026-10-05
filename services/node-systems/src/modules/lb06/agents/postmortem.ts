// The postmortem's deterministic part, and the check on its written part. The timeline is built from
// the event log by code: the moments that matter, in order, with what happened at each. The model
// writes prose over that timeline and names the kinds of event it rests on; a kind the log does
// not hold is a reference to something that did not happen, and the prose is refused.
import { describeAction } from '@lb/contracts'
import type { Lb06Event, Lb06PostmortemProse } from '@lb/contracts'

/** One moment of the timeline. */
export interface TimelineEntry {
  seq: number
  minute: number
  kind: Lb06Event['kind']
  // What happened, in a few words the model and the board can use: an action, a hypothesis, a reason.
  detail: string
}

// The kinds that make the timeline: the ticks and the agents' steps are left out.
const TIMELINE_KINDS = new Set<Lb06Event['kind']>(['fault.injected', 'alert.fired', 'investigation.started', 'hypotheses.ranked', 'proposal.made', 'proposal.approved', 'proposal.rejected', 'remediation.applied', 'slo.recovered', 'incident.closed', 'incident.aborted', 'incident.failed'])

/** The detail of one event, for the timeline. */
function detailOf(event: Lb06Event): string {
  switch (event.kind) {
    case 'fault.injected': return `${event.data.fault} on ${event.data.service}`
    case 'alert.fired': return `burn rate ${event.data.burn.shortBurn}x over ${event.data.burn.shortMinutes} min, ${event.data.burn.longBurn}x over ${event.data.burn.longMinutes} min`
    case 'investigation.started': return 'the agents began'
    case 'hypotheses.ranked': {
      const top = event.data.hypotheses[0]
      return top ? `top hypothesis: ${top.service}, ${top.cause} (${Math.round(top.confidence * 100)}%)` : 'no hypothesis'
    }
    case 'proposal.made': return `${event.data.proposalId}: ${describeAction(event.data.action)}`
    case 'proposal.approved': return `${event.data.proposalId} approved by the operator`
    case 'proposal.rejected': return `${event.data.proposalId} rejected by the operator`
    case 'remediation.applied': return describeAction(event.data.action)
    case 'slo.recovered': return `${event.data.healthyMinutes} healthy minutes`
    case 'incident.closed': return `${event.data.modelCalls} model calls, ${event.data.proposals} proposal(s)`
    case 'incident.aborted': return event.data.reason
    case 'incident.failed': return event.data.reason
    default: return ''
  }
}

/** Builds the timeline from the event log. */
export function timelineOf(events: readonly Lb06Event[]): TimelineEntry[] {
  return events.filter(event => TIMELINE_KINDS.has(event.kind)).map(event => ({ seq: event.seq, minute: event.minute, kind: event.kind, detail: detailOf(event) }))
}

/** The kinds of event a timeline holds. */
export function kindsOf(timeline: readonly TimelineEntry[]): Set<string> {
  return new Set(timeline.map(entry => entry.kind))
}

/** Lists the references of the prose that the timeline does not hold. Empty means the prose may be shown. */
export function invalidReferences(prose: Lb06PostmortemProse, timeline: readonly TimelineEntry[]): string[] {
  const kinds = kindsOf(timeline)
  return prose.references.filter(reference => !kinds.has(reference))
}
