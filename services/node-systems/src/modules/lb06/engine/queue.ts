// BullMQ: where LB-06's incidents wait, how they are run, and the repeating sweep. Two queues, both
// under the service's Redis prefix (`<prefix>bull:...`):
//
//   lb06-incidents     one job per incident, its id the incident's id, so adding it twice is a no-op.
//                      The job runs for the incident's whole life (minutes), renewing its lock; a
//                      worker that dies loses the lock, the queue hands the job on, and the job
//                      resumes from the row's state. Three attempts on a crash, a short fixed wait.
//   lb06-maintenance   one repeating job that runs the sweep.
import { Queue, Worker } from 'bullmq'
import type { JobsOptions } from 'bullmq'
import type { Redis } from 'ioredis'

import type { Lb06Config } from '../config.ts'
import type { JobScheduler, Lb06Deps } from './deps.ts'
import { runIncidentJob } from './job.ts'
import { sweep } from './sweep.ts'

/** The queue of incident jobs. */
export const INCIDENT_QUEUE = 'lb06-incidents'
/** The queue of the repeating sweep. */
export const MAINTENANCE_QUEUE = 'lb06-maintenance'

// How long BullMQ keeps finished and failed jobs, in seconds.
const KEEP_COMPLETED_SECONDS = 600
const KEEP_FAILED_SECONDS = 86_400
// A job's lock lasts this long and is renewed while the job runs; a worker that stops renewing is considered dead after it.
const LOCK_MILLIS = 30_000
const MAX_STALLED = 2
const ATTEMPTS = 3
const RETRY_WAIT_MS = 2_000

/** What an incident job carries: which incident. Nothing a visitor wrote. */
export interface IncidentJob {
  incidentId: string
}

/** The queues' Redis prefix: the service's own prefix, then `bull`, so keys read `lb:bull:lb06-incidents:...`. */
export function bullPrefix(redisPrefix: string): string {
  return `${redisPrefix}bull`
}

/** The real scheduler: incident jobs in a BullMQ queue. */
export class BullScheduler implements JobScheduler {
  readonly #queue: Queue<IncidentJob>

  /** Opens the incident queue on a Redis connection, under a key prefix. */
  constructor(connection: Redis, redisPrefix: string) {
    this.#queue = new Queue<IncidentJob>(INCIDENT_QUEUE, { connection, prefix: bullPrefix(redisPrefix) })
  }

  /** The options every incident job is added with. */
  #options(incidentId: string): JobsOptions {
    return {
      jobId: incidentId,
      attempts: ATTEMPTS,
      backoff: { type: 'fixed', delay: RETRY_WAIT_MS },
      removeOnComplete: { age: KEEP_COMPLETED_SECONDS },
      removeOnFail: { age: KEEP_FAILED_SECONDS },
    }
  }

  /** Adds the incident's job. BullMQ ignores an add whose id already exists. */
  async enqueue(incidentId: string): Promise<void> {
    await this.#queue.add('incident', { incidentId }, this.#options(incidentId))
  }

  /** Replaces an incident's job when the old one is finished or failed without the incident ending; a waiting, delayed or running job is left alone. */
  async requeue(incidentId: string): Promise<void> {
    const existing = await this.#queue.getJob(incidentId)
    if (existing) {
      const state = await existing.getState()
      if (state === 'waiting' || state === 'delayed' || state === 'active' || state === 'prioritized' || state === 'waiting-children') return
      await existing.remove()
    }
    await this.enqueue(incidentId)
  }

  /** Closes the queue's connection. */
  async close(): Promise<void> {
    await this.#queue.close()
  }
}

/** A worker a module can stop. */
export interface WorkerHandle {
  close: () => Promise<void>
}

/** Starts the worker that runs incident jobs, as many at once as the config allows. */
export function startIncidentWorker(deps: Lb06Deps, connection: Redis, redisPrefix: string, config: Lb06Config): WorkerHandle {
  const worker = new Worker<IncidentJob>(INCIDENT_QUEUE, async (job) => {
    await runIncidentJob(deps, job.data.incidentId, { number: job.attemptsMade + 1 })
  }, { connection, prefix: bullPrefix(redisPrefix), concurrency: config.workerConcurrency, lockDuration: LOCK_MILLIS, maxStalledCount: MAX_STALLED })
  worker.on('error', (error) => {
    deps.log.warn({ err: error }, 'incident worker error')
  })
  return { close: () => worker.close() }
}

/** Starts the repeating sweep and the worker that runs it. */
export async function startMaintenance(deps: Lb06Deps, connection: Redis, redisPrefix: string, config: Lb06Config): Promise<WorkerHandle> {
  const queue = new Queue(MAINTENANCE_QUEUE, { connection, prefix: bullPrefix(redisPrefix) })
  await queue.upsertJobScheduler('lb06-sweep', { every: config.sweepEveryMs }, { name: 'sweep', opts: { removeOnComplete: { age: KEEP_COMPLETED_SECONDS }, removeOnFail: { age: KEEP_FAILED_SECONDS } } })
  const worker = new Worker(MAINTENANCE_QUEUE, async () => {
    const report = await sweep(deps)
    if (report.deleted > 0 || report.requeued > 0) deps.log.info(report, 'lb06 sweep')
  }, { connection, prefix: bullPrefix(redisPrefix), concurrency: 1 })
  worker.on('error', (error) => {
    deps.log.warn({ err: error }, 'incident sweep error')
  })
  return {
    close: async () => {
      await worker.close()
      await queue.close()
    },
  }
}
