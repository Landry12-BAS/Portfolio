// BullMQ: where LB-08's step jobs wait, how they retry, and where the dead ones are parked.
//
// Three queues, all under the service's Redis prefix (`<prefix>bull:...`):
//
//   lb08-steps         one job per action step. Its id is the run and the step, so adding
//                      the same step twice is a no-op. A job gets three attempts with
//                      exponential backoff (`attempts: 3`, `backoff: exponential`).
//   lb08-dead-letters  a parked copy of every step that used all its attempts. Nothing
//                      reads it but people with queue tools: the dead letters the visitor
//                      sees come from the database. A copy is removed when its step is
//                      replayed, and expires with the data it describes.
//   lb08-maintenance   one repeating job that runs the sweep.
//
// The engine decides what a failure means (retry or give up) and says so by what it
// throws; this file maps that onto BullMQ: a retry is an ordinary error, a final failure
// is an `UnrecoverableError`, which BullMQ never retries.
import { Queue, UnrecoverableError, Worker } from 'bullmq'
import type { JobsOptions } from 'bullmq'
import type { Redis } from 'ioredis'

import type { Lb08Config } from '../config.ts'
import type { DeadLetterNote, EngineDeps, StepScheduler } from './deps.ts'
import { StepFailure } from './errors.ts'
import { runStep } from './steps.ts'
import { sweep } from './sweep.ts'

/** The queue of step jobs. */
export const STEP_QUEUE = 'lb08-steps'
/** The queue where dead-lettered steps are parked. */
export const DEAD_LETTER_QUEUE = 'lb08-dead-letters'
/** The queue of the repeating sweep. */
export const MAINTENANCE_QUEUE = 'lb08-maintenance'

// How long BullMQ keeps finished and failed jobs, in seconds: long enough to look at, short
// enough that Redis doesn't fill.
const KEEP_COMPLETED_SECONDS = 600
const KEEP_FAILED_SECONDS = 86_400
// A worker that stops renewing its lock is considered dead after this long, and its job is
// given to another worker, up to this many times.
const LOCK_MILLIS = 30_000
const MAX_STALLED = 2

/** What a step job carries: which step of which run. Nothing a visitor wrote. */
export interface StepJob {
  runId: string
  nodeId: string
}

/** Makes the id of a step's job: the run and the step, joined by `__` because BullMQ ids can't hold a colon. */
export function stepJobId(runId: string, nodeId: string): string {
  return `${runId}__${nodeId}`
}

/** The queues' Redis prefix: the service's own prefix, then `bull`, so keys read `lb:bull:lb08-steps:...`. */
export function bullPrefix(redisPrefix: string): string {
  return `${redisPrefix}bull`
}

/** The real scheduler: step jobs and parked dead letters in BullMQ queues. */
export class BullScheduler implements StepScheduler {
  readonly #steps: Queue<StepJob>
  readonly #dead: Queue<DeadLetterNote>
  readonly #config: Lb08Config

  /** Opens the step and dead-letter queues on a Redis connection, under a key prefix. */
  constructor(connection: Redis, redisPrefix: string, config: Lb08Config) {
    const options = { connection, prefix: bullPrefix(redisPrefix) }
    this.#steps = new Queue<StepJob>(STEP_QUEUE, options)
    this.#dead = new Queue<DeadLetterNote>(DEAD_LETTER_QUEUE, options)
    this.#config = config
  }

  /** The options every step job is added with: its id, three attempts and exponential backoff. */
  #options(runId: string, nodeId: string): JobsOptions {
    return {
      jobId: stepJobId(runId, nodeId),
      attempts: this.#config.maxAttempts,
      backoff: { type: 'exponential', delay: this.#config.backoffMs },
      removeOnComplete: { age: KEEP_COMPLETED_SECONDS },
      removeOnFail: { age: KEEP_FAILED_SECONDS },
    }
  }

  /** Adds the step's job. BullMQ ignores an add whose id already exists, so this can be repeated freely. */
  async enqueue(runId: string, nodeId: string): Promise<void> {
    await this.#steps.add('step', { runId, nodeId }, this.#options(runId, nodeId))
  }

  /**
   * Replaces a step's job when the old one is finished or failed without the step moving
   * on. A job that is waiting, delayed or running is left alone: it is still going to do
   * the work.
   */
  async requeue(runId: string, nodeId: string): Promise<void> {
    const old = await this.#steps.getJob(stepJobId(runId, nodeId))
    if (old) {
      const state = await old.getState()
      if (state !== 'completed' && state !== 'failed') return
      await old.remove()
    }
    await this.enqueue(runId, nodeId)
  }

  /** Parks a copy of a dead-lettered step. */
  async park(note: DeadLetterNote): Promise<void> {
    await this.#dead.add('dead-letter', note, { jobId: stepJobId(note.runId, note.nodeId) })
  }

  /** Removes the parked copy of a step, if there is one. */
  async unpark(runId: string, nodeId: string): Promise<void> {
    await this.#dead.remove(stepJobId(runId, nodeId))
  }

  /** Removes parked copies older than `olderThanMs`. */
  async expireParked(olderThanMs: number): Promise<void> {
    await this.#dead.clean(olderThanMs, 1_000, 'wait')
  }

  /** Counts the jobs of the step queue in each state, for tests and the readiness check. */
  async counts(): Promise<Record<string, number>> {
    return this.#steps.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed')
  }

  /** Lists the parked dead letters, for tests and the owner's tools. */
  async parked(): Promise<DeadLetterNote[]> {
    const jobs = await this.#dead.getJobs(['waiting'])
    return jobs.map(job => job.data)
  }

  /** Closes both queues' connections. */
  async close(): Promise<void> {
    await Promise.all([this.#steps.close(), this.#dead.close()])
  }
}

/**
 * Runs one step job: the engine's `runStep`, with a final failure turned into
 * an `UnrecoverableError` so BullMQ stops retrying. Exported for the tests.
 */
export async function processStepJob(deps: EngineDeps, job: StepJob): Promise<void> {
  try {
    await runStep(deps, job.runId, job.nodeId)
  }
  catch (error) {
    if (error instanceof StepFailure && !error.retry) throw new UnrecoverableError(error.message)
    throw error
  }
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

/** Starts the worker that runs step jobs. Several jobs run at once, up to the configured concurrency. */
export function startStepWorker(deps: EngineDeps, connection: Redis, redisPrefix: string, tuning: WorkerTuning = {}): RunningWorker {
  const worker = new Worker<StepJob>(STEP_QUEUE, async job => processStepJob(deps, job.data), {
    connection,
    prefix: bullPrefix(redisPrefix),
    concurrency: deps.config.workerConcurrency,
    lockDuration: tuning.lockMillis ?? LOCK_MILLIS,
    stalledInterval: tuning.stalledCheckMillis ?? LOCK_MILLIS,
    maxStalledCount: MAX_STALLED,
  })
  worker.on('error', (error) => {
    deps.log.warn({ err: error }, 'step worker error')
  })
  // A forced close leaves the job it was running to be found as stalled, like a worker that died.
  return { close: (force = false) => worker.close(force) }
}

/** Starts the repeating sweep: a job added every `sweepEveryMs`, and the worker that runs it. */
export async function startMaintenance(deps: EngineDeps, connection: Redis, redisPrefix: string): Promise<RunningWorker> {
  const options = { connection, prefix: bullPrefix(redisPrefix) }
  const queue = new Queue(MAINTENANCE_QUEUE, options)
  await queue.upsertJobScheduler('sweep', { every: deps.config.sweepEveryMs }, { name: 'sweep', opts: { removeOnComplete: true, removeOnFail: true } })
  const worker = new Worker(MAINTENANCE_QUEUE, async () => {
    const report = await sweep(deps)
    deps.log.info(report, 'sweep finished')
  }, { ...options, concurrency: 1 })
  worker.on('error', (error) => {
    deps.log.warn({ err: error }, 'maintenance worker error')
  })
  return {
    close: async (force = false) => {
      await worker.close(force)
      await queue.close()
    },
  }
}
