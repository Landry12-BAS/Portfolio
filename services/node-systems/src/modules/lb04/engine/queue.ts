// BullMQ: where LB-04's reviews wait, how they retry, and the repeating sweep.
//
// Two queues, both under the service's Redis prefix (`<prefix>bull:...`):
//
//   lb04-reviews       one job per contract. Its id is the contract's id, so adding the same contract
//                      twice is a no-op. A job gets three attempts, and waits between them as long as
//                      the gateway asked it to (its Retry-After) or twice as long as the wait before,
//                      whichever is longer (a custom backoff, `retryDelayMs`).
//   lb04-maintenance   one repeating job that runs the sweep.
//
// The job decides what a failure means (retry or give up) and says so by what it does: a retry is an
// error (`ReviewRetry`) that the queue retries, and a final failure is a contract that ended, after
// which the job returns and is complete. A job's payload is the contract's id and nothing a visitor wrote.
import { Queue, Worker } from 'bullmq'
import type { JobsOptions } from 'bullmq'
import type { Redis } from 'ioredis'

import { retryDelayMs } from '../config.ts'
import type { Lb04Config } from '../config.ts'
import type { JobScheduler, Lb04Deps } from './deps.ts'
import { ReviewRetry } from './failures.ts'
import { reviewJob } from './job.ts'
import { sweep } from './sweep.ts'

/** The queue of review jobs. */
export const REVIEW_QUEUE = 'lb04-reviews'
/** The queue of the repeating sweep. */
export const MAINTENANCE_QUEUE = 'lb04-maintenance'
// The name of the custom backoff, so a job's options and the worker's strategy agree.
const BACKOFF_TYPE = 'review'

// How long BullMQ keeps finished and failed jobs, in seconds: long enough to look at, short enough that Redis doesn't fill.
const KEEP_COMPLETED_SECONDS = 600
const KEEP_FAILED_SECONDS = 86_400
// A worker that stops renewing its lock is considered dead after this long, and its job is given to another worker, up to this many times.
const LOCK_MILLIS = 60_000
const MAX_STALLED = 2

/** What a review job carries: which contract. Nothing a visitor wrote. */
export interface ReviewJob {
  contractId: string
}

/** The queues' Redis prefix: the service's own prefix, then `bull`, so keys read `lb:bull:lb04-reviews:...`. */
export function bullPrefix(redisPrefix: string): string {
  return `${redisPrefix}bull`
}

/** The real scheduler: review jobs in a BullMQ queue. */
export class BullScheduler implements JobScheduler {
  readonly #reviews: Queue<ReviewJob>
  readonly #config: Lb04Config

  /** Opens the review queue on a Redis connection, under a key prefix. */
  constructor(connection: Redis, redisPrefix: string, config: Lb04Config) {
    this.#reviews = new Queue<ReviewJob>(REVIEW_QUEUE, { connection, prefix: bullPrefix(redisPrefix) })
    this.#config = config
  }

  /** The options every review job is added with: its id, its attempts and the custom backoff. */
  #options(contractId: string): JobsOptions {
    return {
      jobId: contractId,
      attempts: this.#config.maxAttempts,
      backoff: { type: BACKOFF_TYPE },
      removeOnComplete: { age: KEEP_COMPLETED_SECONDS },
      removeOnFail: { age: KEEP_FAILED_SECONDS },
    }
  }

  /** Adds the contract's job. BullMQ ignores an add whose id already exists, so this can be repeated freely. */
  async enqueue(contractId: string): Promise<void> {
    await this.#reviews.add('review', { contractId }, this.#options(contractId))
  }

  /**
   * Replaces a contract's job when the old one is finished or failed without the contract moving
   * on. A job that is waiting, delayed or running is left alone: it is still going to do the work.
   */
  async requeue(contractId: string): Promise<void> {
    const old = await this.#reviews.getJob(contractId)
    if (old) {
      const state = await old.getState()
      if (state !== 'completed' && state !== 'failed') return
      await old.remove()
    }
    await this.enqueue(contractId)
  }

  /** Counts the jobs of the review queue in each state, for tests and the readiness check. */
  async counts(): Promise<Record<string, number>> {
    return this.#reviews.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed')
  }

  /** Closes the queue's connection. */
  async close(): Promise<void> {
    await this.#reviews.close()
  }
}

/** The minimal view of a BullMQ job the processor needs: its payload and how many attempts it has had. */
export interface JobView {
  data: ReviewJob
  attemptsMade: number
  opts: { attempts?: number | undefined }
}

/** Runs one review job: the engine's `reviewJob`, told which attempt it is and whether it is the last. Exported for the tests. */
export async function processReviewJob(deps: Lb04Deps, job: JobView): Promise<void> {
  const number = job.attemptsMade + 1
  await reviewJob(deps, job.data.contractId, { number, last: number >= (job.opts.attempts ?? 1) })
}

/** A worker the process started, so it can be stopped cleanly (or, in a test, abruptly). */
export interface RunningWorker {
  close: (force?: boolean) => Promise<void>
}

/** How long a worker's lock on a job lasts, and how often stalled jobs are looked for; tests shorten both. */
export interface WorkerTuning {
  lockMillis?: number
  stalledCheckMillis?: number
}

/** Starts the worker that runs review jobs, several at once up to the configured concurrency. */
export function startReviewWorker(deps: Lb04Deps, connection: Redis, redisPrefix: string, tuning: WorkerTuning = {}): RunningWorker {
  const worker = new Worker<ReviewJob>(REVIEW_QUEUE, async job => processReviewJob(deps, job), {
    connection,
    prefix: bullPrefix(redisPrefix),
    concurrency: deps.config.workerConcurrency,
    lockDuration: tuning.lockMillis ?? LOCK_MILLIS,
    stalledInterval: tuning.stalledCheckMillis ?? LOCK_MILLIS,
    maxStalledCount: MAX_STALLED,
    settings: {
      // The wait after a failed attempt: the exponential one, or the gateway's own if that is longer.
      backoffStrategy: (attemptsMade, type, error) => {
        if (type !== BACKOFF_TYPE) return deps.config.backoffMs
        return retryDelayMs(deps.config, attemptsMade, error instanceof ReviewRetry ? error.retryAfterSeconds : undefined)
      },
    },
  })
  worker.on('error', (error) => {
    deps.log.warn({ err: error }, 'review worker error')
  })
  // A forced close leaves the job it was running to be found as stalled, like a worker that died.
  return { close: (force = false) => worker.close(force) }
}

/** Starts the repeating sweep: a job added every `sweepEveryMs`, and the worker that runs it. */
export async function startMaintenance(deps: Lb04Deps, connection: Redis, redisPrefix: string): Promise<RunningWorker> {
  const options = { connection, prefix: bullPrefix(redisPrefix) }
  const queue = new Queue(MAINTENANCE_QUEUE, options)
  await queue.upsertJobScheduler('sweep', { every: deps.config.sweepEveryMs }, { name: 'sweep', opts: { removeOnComplete: true, removeOnFail: true } })
  const worker = new Worker(MAINTENANCE_QUEUE, async () => {
    const report = await sweep(deps)
    deps.log.info(report, 'lb04 sweep finished')
  }, { ...options, concurrency: 1 })
  worker.on('error', (error) => {
    deps.log.warn({ err: error }, 'lb04 maintenance worker error')
  })
  return {
    close: async (force = false) => {
      await worker.close(force)
      await queue.close()
    },
  }
}
