// LB-04's engine under test: a real database of its own, a queue the test drives by hand, a clock it
// can move, a recorder for the spans the engine writes, and models that are scripts.
//
// Driving the queue by hand makes the engine deterministic: a test decides when each job runs, can run
// the same job twice, can look at the database between two attempts and never waits for a backoff. The
// tests of the real BullMQ queue are in lb04-queue.test.ts.
import { Tracer } from '@lb/common'
import { pino } from 'pino'

import { seedDirectory } from '../../src/core/data-files.ts'
import type { Lb04Config } from '../../src/modules/lb04/config.ts'
import { readSampleList } from '../../src/modules/lb04/data/samples.ts'
import type { Lb04Database } from '../../src/modules/lb04/db/connection.ts'
import type { JobScheduler, Lb04Deps, ReviewServices } from '../../src/modules/lb04/engine/deps.ts'
import { ReviewRetry } from '../../src/modules/lb04/engine/failures.ts'
import { reviewJob } from '../../src/modules/lb04/engine/job.ts'
import { createLb04TestDatabase } from './lb04-database.ts'
import { referenceGuard, referenceModels } from './lb04-reference.ts'
import type { ScriptedModels } from './lb04-reference.ts'
import { loadGoldenSet, loadPlaybook, Recorder, TEST_LIMITS } from './lb04.ts'

/** Two visitors, known by their session hashes. */
export const VISITOR_A = 'session-anna-0123456789ab'
export const VISITOR_B = 'session-boris-0123456789a'

/** The settings tests run with: the production numbers, with the waits made short and the extraction given a generous time. */
export const LB04_TEST_CONFIG: Lb04Config = {
  maxAttempts: 3,
  backoffMs: 40,
  keptMs: 60 * 60_000,
  staleAfterMs: 60_000,
  workerConcurrency: 2,
  sweepEveryMs: 200,
  extraction: TEST_LIMITS,
}

/** A clock the test moves. */
export class TestClock {
  #millis: number

  /** Starts at a fixed moment in the morning of a day, so a test that adds an hour stays on the same day. */
  constructor(start = '2026-10-02T09:00:00.000Z') {
    this.#millis = Date.parse(start)
  }

  /** The moment it is now. */
  now = (): Date => new Date(this.#millis)

  /** Moves the clock forward. */
  advance(milliseconds: number): void {
    this.#millis += milliseconds
  }

  /** Sets the clock to a moment. */
  set(moment: string): void {
    this.#millis = Date.parse(moment)
  }
}

/** A queue the test runs by hand: jobs wait in a list until `drive` or the test takes them. */
export class ManualReviewScheduler implements JobScheduler {
  readonly jobs: string[] = []
  // Every contract ever added, to check the engine never adds one twice for one request.
  readonly added: string[] = []
  readonly requeued: string[] = []
  readonly #failures: Error[] = []

  /** Makes the next `enqueue` fail, as a Redis that is down would. */
  failNextEnqueue(error: Error): void {
    this.#failures.push(error)
  }

  /** Adds a job unless the same contract already has one waiting, as BullMQ does with a job id. */
  async enqueue(contractId: string): Promise<void> {
    const failure = this.#failures.shift()
    if (failure) throw failure
    this.added.push(contractId)
    if (!this.jobs.includes(contractId)) this.jobs.push(contractId)
  }

  /** Adds a job for a contract that has none waiting. */
  async requeue(contractId: string): Promise<void> {
    this.requeued.push(contractId)
    if (!this.jobs.includes(contractId)) this.jobs.push(contractId)
  }

  /** Takes the oldest waiting job. */
  take(): string | undefined {
    return this.jobs.shift()
  }
}

/** The engine, its database and the things a test uses to look at it. */
export interface Lb04Harness {
  deps: Lb04Deps
  scheduler: ManualReviewScheduler
  spans: Recorder
  clock: TestClock
  database: Lb04Database
  // Every wait the engine asked for after a failed attempt, in seconds (undefined when it asked for none).
  retries: (number | undefined)[]
  // Runs one SQL statement as the database's own user and returns its rows.
  query: (text: string, values?: unknown[]) => Promise<Record<string, unknown>[]>
  close: () => Promise<void>
}

/** What a harness is made with. */
export interface HarnessOptions {
  config?: Partial<Lb04Config>
  // The models, or `undefined` for a process that has no gateway.
  review?: ReviewServices
}

/** Builds the engine on a database of its own. */
export async function createLb04Harness(serverUrl: string, options: HarnessOptions = {}): Promise<Lb04Harness> {
  const testDatabase = await createLb04TestDatabase(serverUrl)
  const database = await testDatabase.open()
  const spans = new Recorder()
  const clock = new TestClock()
  const scheduler = new ManualReviewScheduler()
  const seed = seedDirectory()
  const deps: Lb04Deps = {
    db: database.db,
    config: { ...LB04_TEST_CONFIG, ...options.config },
    scheduler,
    tracer: new Tracer(spans),
    log: pino({ level: 'silent' }),
    now: clock.now,
    playbook: loadPlaybook(),
    samples: readSampleList(seed),
    seedDirectory: seed,
    review: options.review,
  }
  return {
    deps,
    scheduler,
    spans,
    clock,
    database,
    retries: [],
    query: async (text, values = []) => (await database.pool.query(text, values)).rows as Record<string, unknown>[],
    close: async () => {
      await testDatabase.drop()
    },
  }
}

/** The review services and the scripts behind them for a sample contract, answering as a correct reviewer would. */
export function referenceReview(sampleId: string): { review: ReviewServices, scripts: ScriptedModels } {
  const entry = loadGoldenSet().cases.find(candidate => candidate.contract === sampleId)
  if (entry?.kind !== 'report') throw new Error(`There is no report case for the sample ${sampleId}.`)
  const scripts = referenceModels(entry, loadPlaybook())
  return { review: { models: scripts.models, guard: referenceGuard(entry) }, scripts }
}

/** What `drive` does with the queue. */
export interface DriveOptions {
  // How many attempts the queue gives a job: the config's by default.
  attempts?: number
  // Called after every job that was run, with its contract id and what it did: `ended` or `retry`.
  onJob?: (contractId: string, outcome: 'ended' | 'retry') => void
}

/**
 * Runs the waiting jobs until none is left, retrying those that ask for it up to the attempts the queue
 * gives, as BullMQ does, without waiting out the backoff. Returns how many job runs it made.
 */
export async function drive(harness: Lb04Harness, options: DriveOptions = {}): Promise<number> {
  const attempts = options.attempts ?? harness.deps.config.maxAttempts
  const made = new Map<string, number>()
  let runs = 0
  for (let contractId = harness.scheduler.take(); contractId !== undefined; contractId = harness.scheduler.take()) {
    const number = (made.get(contractId) ?? 0) + 1
    made.set(contractId, number)
    runs += 1
    try {
      await reviewJob(harness.deps, contractId, { number, last: number >= attempts })
      options.onJob?.(contractId, 'ended')
    }
    catch (error) {
      if (!(error instanceof ReviewRetry)) throw error
      harness.retries.push(error.retryAfterSeconds)
      options.onJob?.(contractId, 'retry')
      harness.scheduler.jobs.push(contractId)
    }
  }
  return runs
}
