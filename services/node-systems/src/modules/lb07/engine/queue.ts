// BullMQ: where LB-07's runs wait, how they retry, and the repeating sweep. Two queues under the
// service's Redis prefix (`<prefix>bull:...`):
//
//   lb07-runs          one job per run, its id the run's id (so adding it twice is a no-op), two attempts,
//                      and one at a time: there is one browser, and a run holds it from its plan to its
//                      verification. Fairness is the queue's order: first queued, first run.
//   lb07-maintenance   one repeating job that runs the sweep.
import { Queue, Worker } from 'bullmq'
import type { JobsOptions } from 'bullmq'
import type { Redis } from 'ioredis'

import { retryDelayMs } from '../config.ts'
import type { Lb07Config } from '../config.ts'
import type { JobScheduler, Lb07Deps } from './deps.ts'
import { RunRetry } from './failures.ts'
import { runJob } from './job.ts'
import { sweep } from './sweep.ts'

/** The queue of run jobs. */
export const RUN_QUEUE = 'lb07-runs'
/** The queue of the repeating sweep. */
export const MAINTENANCE_QUEUE = 'lb07-maintenance'
const BACKOFF_TYPE = 'run'
const KEEP_COMPLETED_SECONDS = 600
const KEEP_FAILED_SECONDS = 86_400
// A run holds the browser for up to three minutes and the model's waits besides: the lock is renewed by BullMQ, and a worker silent this long is dead.
const LOCK_MILLIS = 60_000
const MAX_STALLED = 1

/** What a run job carries: which run. Nothing a visitor wrote. */
export interface RunJob {
  runId: string
}

/** The queues' Redis prefix. */
export function bullPrefix(redisPrefix: string): string {
  return `${redisPrefix}bull`
}

/** The real scheduler: run jobs in a BullMQ queue. */
export class BullScheduler implements JobScheduler {
  readonly #runs: Queue<RunJob>
  readonly #config: Lb07Config

  /** Opens the run queue on a Redis connection, under a key prefix. */
  constructor(connection: Redis, redisPrefix: string, config: Lb07Config) {
    this.#runs = new Queue<RunJob>(RUN_QUEUE, { connection, prefix: bullPrefix(redisPrefix) })
    this.#config = config
  }

  /** The options every run job is added with. */
  #options(runId: string): JobsOptions {
    return { jobId: runId, attempts: this.#config.maxAttempts, backoff: { type: BACKOFF_TYPE }, removeOnComplete: { age: KEEP_COMPLETED_SECONDS }, removeOnFail: { age: KEEP_FAILED_SECONDS } }
  }

  /** Adds the run's job. BullMQ ignores an add whose id already exists. */
  async enqueue(runId: string): Promise<void> {
    await this.#runs.add('run', { runId }, this.#options(runId))
  }

  /** Replaces a run's job when the old one is finished or failed without the run moving on. */
  async requeue(runId: string): Promise<void> {
    const old = await this.#runs.getJob(runId)
    if (old) {
      const state = await old.getState()
      if (state !== 'completed' && state !== 'failed') return
      await old.remove()
    }
    await this.enqueue(runId)
  }

  /** Counts the jobs in each state, for tests and the readiness check. */
  async counts(): Promise<Record<string, number>> {
    return this.#runs.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed')
  }

  /** Closes the queue's connection. */
  async close(): Promise<void> {
    await this.#runs.close()
  }
}

/** The minimal view of a BullMQ job the processor needs. */
export interface JobView {
  data: RunJob
  attemptsMade: number
  opts: { attempts?: number | undefined }
}

/** Runs one job: the engine's `runJob`, told which attempt it is and whether it is the last. */
export async function processRunJob(deps: Lb07Deps, job: JobView): Promise<void> {
  const number = job.attemptsMade + 1
  await runJob(deps, job.data.runId, { number, last: number >= (job.opts.attempts ?? 1) })
}

/** A worker the process started. */
export interface RunningWorker {
  close: (force?: boolean) => Promise<void>
}

/** How long a worker's lock lasts and how often stalled jobs are looked for; tests shorten both. */
export interface WorkerTuning {
  lockMillis?: number
  stalledCheckMillis?: number
}

/** Starts the worker that runs the run jobs, one at a time. */
export function startRunWorker(deps: Lb07Deps, connection: Redis, redisPrefix: string, tuning: WorkerTuning = {}): RunningWorker {
  const worker = new Worker<RunJob>(RUN_QUEUE, async job => processRunJob(deps, job), {
    connection,
    prefix: bullPrefix(redisPrefix),
    concurrency: 1,
    lockDuration: tuning.lockMillis ?? LOCK_MILLIS,
    stalledInterval: tuning.stalledCheckMillis ?? LOCK_MILLIS,
    maxStalledCount: MAX_STALLED,
    settings: {
      backoffStrategy: (attemptsMade, type, error) => {
        if (type !== BACKOFF_TYPE) return deps.config.backoffMs
        return retryDelayMs(deps.config, attemptsMade, error instanceof RunRetry ? error.retryAfterSeconds : undefined)
      },
    },
  })
  worker.on('error', (error) => {
    deps.log.warn({ err: error }, 'lb07 run worker error')
  })
  return { close: (force = false) => worker.close(force) }
}

/** Starts the repeating sweep. */
export async function startMaintenance(deps: Lb07Deps, connection: Redis, redisPrefix: string): Promise<RunningWorker> {
  const options = { connection, prefix: bullPrefix(redisPrefix) }
  const queue = new Queue(MAINTENANCE_QUEUE, options)
  await queue.upsertJobScheduler('sweep', { every: deps.config.sweepEveryMs }, { name: 'sweep', opts: { removeOnComplete: true, removeOnFail: true } })
  const worker = new Worker(MAINTENANCE_QUEUE, async () => {
    const report = await sweep(deps)
    deps.log.info(report, 'lb07 sweep finished')
  }, { ...options, concurrency: 1 })
  worker.on('error', (error) => {
    deps.log.warn({ err: error }, 'lb07 maintenance worker error')
  })
  return {
    close: async (force = false) => {
      await worker.close(force)
      await queue.close()
    },
  }
}
