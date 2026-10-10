// The sweep: the work no request does. Every minute the worker's maintenance job deletes the
// incidents whose day is up (their logs cascade), queues again the running incidents whose job has
// gone quiet (a worker that died, a queue that lost the job), and removes the usage counters of days
// nothing reads any more. It is safe to run at any time and from several workers at once.
import type { Lb06Deps } from './deps.ts'
import { deleteExpired, listStaleIncidents } from './store.ts'
import { removeOldCounters } from './usage.ts'

/** What one sweep did. */
export interface SweepReport {
  deleted: number
  requeued: number
  counters: number
}

/** Runs one sweep. An incident that can't be queued again is logged and left for the next sweep. */
export async function sweep(deps: Lb06Deps): Promise<SweepReport> {
  const moment = deps.now()
  const deleted = await deleteExpired(deps.db, moment)
  let requeued = 0
  for (const id of await listStaleIncidents(deps.db, moment, deps.config.staleAfterMs)) {
    try {
      await deps.scheduler.requeue(id)
      requeued += 1
    }
    catch (error) {
      deps.log.warn({ err: error, incidentId: id }, 'the sweep could not queue an incident again')
    }
  }
  const counters = await removeOldCounters(deps.db, moment)
  return { deleted, requeued, counters }
}
