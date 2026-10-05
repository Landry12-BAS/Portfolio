// The trace of an incident: the root span the incident ends with, and the id the step spans nest
// under. As for LB-04's reviews, the steps (the alert, each agent's call, each tool call, the
// remediation, the recovery) are written as they happen and name the root as their parent before it
// exists, since its id is made from the incident's id. The root is written once, last, by the
// process that ended the incident. A trace carries counts and labels, never a visitor's words, and a
// failure to write it never fails the incident.
import { createRun, runScope, spanIdFrom } from '@lb/common'
import type { Run } from '@lb/common'
import type { Lb06State } from '@lb/contracts'

import type { Lb06Deps } from './deps.ts'

/** The id of an incident's root span, made from the incident's id so a step can name it as its parent before the root is written. */
export function rootSpanIdOf(incidentId: string): string {
  return spanIdFrom(`lb-06:incident:${incidentId}`)
}

/** The run an incident's calls and spans belong to: synthetic for a sample, the visitor's for a custom scenario. */
export function runOf(incidentId: string, sessionKey: string, origin: 'sample' | 'custom'): Run {
  return createRun({ system: 'lb-06', runId: incidentId, session: sessionKey, dataClass: origin === 'sample' ? 'synthetic' : 'visitor' })
}

/** What an incident's trace needs to know of its end: counts and labels, nothing a visitor wrote. */
export interface IncidentEnd {
  incidentId: string
  sessionKey: string
  origin: 'sample' | 'custom'
  startMs: number
  endMs: number
  state: Lb06State
  endReason: string | null
  minute: number
  modelCalls: number
  proposals: number
  cached: boolean
}

/** Writes the root span of an incident that has just ended, after the transaction that ended it has committed. A failure is logged and goes no further. */
export async function recordIncidentEnd(deps: Lb06Deps, end: IncidentEnd): Promise<void> {
  try {
    await runScope(runOf(end.incidentId, end.sessionKey, end.origin), () => deps.tracer.record({
      name: 'incident',
      kind: 'system.run',
      status: end.state === 'closed' ? 'ok' : 'error',
      spanId: rootSpanIdOf(end.incidentId),
      startMs: end.startMs,
      endMs: end.endMs,
      attrs: { outcome: end.endReason ?? end.state, origin: end.origin, minutes: end.minute, model_calls: end.modelCalls, proposals: end.proposals, cached: end.cached },
    }))
  }
  catch (error) {
    deps.log.warn({ err: error, incidentId: end.incidentId }, 'could not write the root span of an incident')
  }
}
