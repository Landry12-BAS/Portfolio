// The sweep: the work no request does. Every minute the worker's maintenance job deletes the runs whose
// hour is up (with their steps, findings, evidence, report and test, which cascade), ends the runs that have
// waited too long in the queue for the browser (their places given back), queues again the runs that are still
// open but have shown no sign of life (a job lost with a worker that died), and removes the usage counters of
// days nothing reads any more. Safe to run at any time and from several workers at once.
import { abandonOverdue } from './job.ts'
import type { Lb07Deps } from './deps.ts'
import { deleteExpired, listOverdueQueued, listStaleRuns } from './store.ts'
import { removeOldCounters } from './usage.ts'

/** What one sweep did. */
export interface SweepReport {
  deleted: number
  // Runs ended because they waited longer than `maxQueueWaitMs` for the browser.
  overdue: number
  requeued: number
  counters: number
}

/** Ends the runs that have waited too long in the queue, and returns how many it ended. */
async function endOverdue(deps: Lb07Deps, moment: Date): Promise<number> {
  let ended = 0
  for (const id of await listOverdueQueued(deps.db, moment, deps.config.maxQueueWaitMs)) {
    if (await abandonOverdue(deps, id)) ended += 1
  }
  return ended
}

/** Runs one sweep. */
export async function sweep(deps: Lb07Deps): Promise<SweepReport> {
  const moment = deps.now()
  const deleted = await deleteExpired(deps.db, moment)
  const overdue = await endOverdue(deps, moment)
  let requeued = 0
  for (const id of await listStaleRuns(deps.db, moment, deps.config.staleAfterMs)) {
    try {
      await deps.scheduler.requeue(id)
      requeued += 1
    }
    catch (error) {
      deps.log.warn({ err: error, runId: id }, 'the sweep could not queue a run again')
    }
  }
  const counters = await removeOldCounters(deps.db, moment)
  return { deleted, overdue, requeued, counters }
}
