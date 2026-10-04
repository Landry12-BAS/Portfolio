// The sweep: the work no request does. Every minute the worker's maintenance job
//
//   - deletes the contracts whose hour is up, and with each one its file, its text, its report and
//     its redlines (the foreign keys cascade), which is how nothing a visitor sent outlives its hour;
//   - queues again the contracts that are still being worked on but have shown no sign of life for
//     minutes, which is how a job lost with a worker that died, or a queue that lost it, is found; and
//   - removes the usage counters of days nothing reads any more.
//
// It is safe to run at any time and from several workers at once: deleting an expired contract twice
// deletes it once, and queueing a job whose id exists already changes nothing.
import { deleteExpired, listStaleContracts } from './store.ts'
import { removeOldCounters } from './usage.ts'
import type { Lb04Deps } from './deps.ts'

/** What one sweep did. */
export interface SweepReport {
  deleted: number
  requeued: number
  counters: number
}

/** Runs one sweep. A contract that can't be queued again is logged and left for the next sweep. */
export async function sweep(deps: Lb04Deps): Promise<SweepReport> {
  const moment = deps.now()
  const deleted = await deleteExpired(deps.db, moment)
  let requeued = 0
  for (const id of await listStaleContracts(deps.db, moment, deps.config.staleAfterMs)) {
    try {
      await deps.scheduler.requeue(id)
      requeued += 1
    }
    catch (error) {
      deps.log.warn({ err: error, contractId: id }, 'the sweep could not queue a contract again')
    }
  }
  const counters = await removeOldCounters(deps.db, moment)
  return { deleted, requeued, counters }
}
