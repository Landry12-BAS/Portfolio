// Handing ready steps to the queue, and finding steps the queue lost.
//
// A step becomes `ready` in a database transaction, and the job is added to the queue
// after that transaction commits. The two can't share a transaction, so a process that dies
// in between leaves a step that is ready and has no job. That is safe because dispatching
// can be repeated: a job's id is the step's, the queue ignores a second add, and the sweep
// dispatches whatever has been ready for too long. The step is never run twice because of it.
import { and, asc, eq, inArray, lt } from 'drizzle-orm'

import { runSteps } from '../db/schema.ts'
import type { EngineDeps } from './deps.ts'

// The most steps one dispatch or one sweep pass handles.
const BATCH = 200

/**
 * Queues every ready step (of one run, or of all runs) and marks it queued. Returns how
 * many it queued. A step a worker has already claimed is left alone.
 */
export async function dispatchReady(deps: EngineDeps, runId?: string): Promise<number> {
  const ready = eq(runSteps.status, 'ready')
  const steps = await deps.db.select({ runId: runSteps.runId, nodeId: runSteps.nodeId })
    .from(runSteps)
    .where(runId === undefined ? ready : and(ready, eq(runSteps.runId, runId)))
    .orderBy(asc(runSteps.updatedAt))
    .limit(BATCH)
  for (const step of steps) {
    await deps.scheduler.enqueue(step.runId, step.nodeId)
    await deps.db.update(runSteps)
      .set({ status: 'queued', updatedAt: deps.now() })
      .where(and(eq(runSteps.runId, step.runId), eq(runSteps.nodeId, step.nodeId), ready))
  }
  return steps.length
}

/**
 * Dispatches a run's ready steps and never fails: if the queue can't be reached the steps
 * stay ready, the run shows as queued, and the sweep tries again. A request or a job
 * that has already done its work must not fail because of that.
 */
export async function dispatchSafely(deps: EngineDeps, runId: string): Promise<void> {
  try {
    await dispatchReady(deps, runId)
  }
  catch (error) {
    deps.log.warn({ err: error, runId }, 'could not queue ready steps; the sweep will retry')
  }
}

/**
 * Looks for steps that have been in flight longer than they should: ready and never
 * queued, or queued or running with no job moving them (a lost job, or a worker that died
 * and was not recovered by the queue). Queues them again. Returns how many it handled.
 */
export async function requeueStale(deps: EngineDeps): Promise<number> {
  const cutoff = new Date(deps.now().getTime() - deps.config.staleAfterMs)
  const stale = await deps.db.select({ runId: runSteps.runId, nodeId: runSteps.nodeId, status: runSteps.status })
    .from(runSteps)
    .where(and(inArray(runSteps.status, ['ready', 'queued', 'running']), lt(runSteps.updatedAt, cutoff)))
    .orderBy(asc(runSteps.updatedAt))
    .limit(BATCH)
  for (const step of stale) {
    if (step.status === 'ready') await deps.scheduler.enqueue(step.runId, step.nodeId)
    else await deps.scheduler.requeue(step.runId, step.nodeId)
    // Touching the row keeps the next sweep from picking the same step up again at once.
    await deps.db.update(runSteps)
      .set({ status: step.status === 'ready' ? 'queued' : step.status, updatedAt: deps.now() })
      .where(and(eq(runSteps.runId, step.runId), eq(runSteps.nodeId, step.nodeId), eq(runSteps.status, step.status)))
  }
  return stale.length
}
