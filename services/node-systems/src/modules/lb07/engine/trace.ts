// The trace of a run: the root span the run ends with, and the id the step spans nest under, made from the
// run's id so a step can name its parent before the root is written (as LB-04 and LB-08 do). The gateway
// calls a trace finished once it holds the root, and the Scope stops reading then. A trace is telemetry:
// counts and labels, never a goal, a step's name or a page's words, and a failure to write it never fails
// the job that was ending the run.
import { createRun, runScope, spanIdFrom } from '@lb/common'

import type { Lb07Deps } from './deps.ts'

/** The id of a run's root span. */
export function rootSpanIdOf(runId: string): string {
  return spanIdFrom(`lb-07:run:${runId}`)
}

/** What a run's trace needs to know of its end. */
export interface RunEnd {
  runId: string
  sessionKey: string
  origin: 'sample' | 'custom'
  startMs: number
  endMs: number
  outcome: string
  modelCalls: number
  findings: number
  replans: number
  bugs: number
}

/** Writes the root span of a run that has just ended, after the transaction that ended it has committed. */
export async function recordRunEnd(deps: Lb07Deps, end: RunEnd): Promise<void> {
  try {
    await runScope(createRun({ system: 'lb-07', runId: end.runId, session: end.sessionKey, dataClass: end.origin === 'sample' ? 'synthetic' : 'visitor' }), () => deps.tracer.record({
      name: 'qa run',
      kind: 'system.run',
      status: end.outcome === 'done' ? 'ok' : 'error',
      spanId: rootSpanIdOf(end.runId),
      startMs: end.startMs,
      endMs: end.endMs,
      attrs: { outcome: end.outcome, origin: end.origin, model_calls: end.modelCalls, findings: end.findings, replans: end.replans, bugs_on: end.bugs },
    }))
  }
  catch (error) {
    deps.log.warn({ err: error, runId: end.runId }, 'could not write the root span of a run')
  }
}
