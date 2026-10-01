// The sweep: what the engine does on a timer, to keep itself tidy and to recover from
// crashes.
//
//   - Retention. A visitor's workflows are deleted 24 hours after they were made, and with
//     them go every version, run, step, log, delivery and dead letter that belonged to
//     them (the tables' foreign keys cascade). Synthetic data only, and nothing a visitor
//     typed outlives the day.
//   - Recovery. A step that has been ready, queued or running for too long without moving
//     is queued again: a crash between a commit and a queue add, a lost job, a worker
//     that died and wasn't recovered by the queue itself.
//   - Tidying. Old usage counters go, and so do parked dead-letter copies past retention.
import { inArray, lt } from 'drizzle-orm'

import { workflows } from '../db/schema.ts'
import type { EngineDeps } from './deps.ts'
import { requeueStale } from './dispatch.ts'
import { removeOldCounters } from './usage.ts'

// The most workflows one sweep deletes; a backlog is cleared over several sweeps.
const EXPIRY_BATCH = 500

/** What one sweep did. */
export interface SweepReport {
  expiredWorkflows: number
  requeuedSteps: number
  removedCounters: number
}

/** Deletes workflows past their expiry, with everything that belongs to them. Returns how many it deleted. */
export async function deleteExpired(deps: EngineDeps): Promise<number> {
  const expired = await deps.db.select({ id: workflows.id }).from(workflows).where(lt(workflows.expiresAt, deps.now())).limit(EXPIRY_BATCH)
  if (expired.length === 0) return 0
  const removed = await deps.db.delete(workflows).where(inArray(workflows.id, expired.map(workflow => workflow.id))).returning({ id: workflows.id })
  return removed.length
}

/** Runs one sweep: retention, recovery and tidying. */
export async function sweep(deps: EngineDeps): Promise<SweepReport> {
  const expiredWorkflows = await deleteExpired(deps)
  const requeuedSteps = await requeueStale(deps)
  const removedCounters = await removeOldCounters(deps.db, deps.now())
  await deps.scheduler.expireParked(deps.config.retentionMs)
  return { expiredWorkflows, requeuedSteps, removedCounters }
}
