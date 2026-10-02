// The trace of a workflow run: the root span the run ends with, and the ID the step spans nest under.
//
// A run's trace is a tree. Every attempt at an action step is a span, written by the worker that
// made it, and the run itself is the root, written once and last by the process that brought it to
// its end. The gateway calls a trace finished once it holds the root span, and the Scope stops
// reading then. Without a root the site could only guess that a run was over.
//
// The steps run long before the run ends, so each of them names its parent before the root exists.
// The root's ID is made from the run's ID, which every process knows, so the two agree without a
// message between them.
//
// A trace is telemetry: it carries counts and labels, never anything a visitor wrote, and a failure
// to write it never fails the request or the job that was ending the run.
import { createRun, runScope, spanIdFrom } from '@lb/common'

import type { EngineDeps } from './deps.ts'
import type { Work } from './state.ts'

/** The ID of a run's root span, made from the run's ID so a step can name it as its parent before the root is written. */
export function rootSpanIdOf(runId: string): string {
  return spanIdFrom(`lb-08:run:${runId}`)
}

/** What a run's trace needs to know of its end: counts and labels, nothing a visitor wrote. */
export interface RunEnd {
  runId: string
  // The visitor's hashed session key, which a run of the tracer needs (never the raw cookie).
  sessionKey: string
  // When the run was made and when it ended, in Unix milliseconds. The root spans the wait for a worker too.
  startMs: number
  endMs: number
  succeeded: boolean
  // How many steps the run has, and how many attempts its steps took between them.
  steps: number
  attempts: number
  // Whether the run replays an earlier one.
  replay: boolean
}

/** Tells how a transaction's work ended its run, or nothing if it did not: only the transaction that ended a run adds its root. */
export function endOf(work: Work): RunEnd | undefined {
  if (!work.ended) return undefined
  const { run, steps } = work.state
  return {
    runId: run.id,
    sessionKey: run.sessionKey,
    startMs: run.createdAt.getTime(),
    endMs: (run.finishedAt ?? work.now).getTime(),
    succeeded: run.status === 'succeeded',
    steps: steps.size,
    attempts: [...steps.values()].reduce((total, step) => total + step.attempts, 0),
    replay: run.replayOf !== null,
  }
}

/**
 * Writes the root span of a run that has just ended, after the transaction that ended it has
 * committed. A failure to write it is logged and goes no further: the end of the run is already in
 * the database, and a trace is not worth failing the visitor's request over.
 */
export async function recordRunEnd(deps: EngineDeps, end: RunEnd | undefined): Promise<void> {
  if (!end) return
  try {
    await runScope(createRun({ system: 'lb-08', runId: end.runId, session: end.sessionKey }), () => deps.tracer.record({
      name: 'workflow run',
      kind: 'system.run',
      status: end.succeeded ? 'ok' : 'error',
      spanId: rootSpanIdOf(end.runId),
      startMs: end.startMs,
      endMs: end.endMs,
      attrs: { outcome: end.succeeded ? 'succeeded' : 'failed', steps: end.steps, attempts: end.attempts, replay: end.replay },
    }))
  }
  catch (error) {
    deps.log.warn({ err: error, runId: end.runId }, 'could not write the root span of a run')
  }
}
