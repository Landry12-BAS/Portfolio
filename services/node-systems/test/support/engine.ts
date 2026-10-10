// The engine under test: a real database of its own, a queue the test drives by hand, a
// clock it can move, and a recorder for the spans the engine writes.
//
// Driving the queue by hand makes the engine's behaviour deterministic: a test decides
// when each job runs, so it can run two steps at the same moment, stop a worker between a
// side effect and its acknowledgement, or look at the database between jobs. The tests of
// the real BullMQ queue are in queue.test.ts.
import { Tracer } from '@lb/common'
import type { Span, SpanWriter } from '@lb/common'
import { pino } from 'pino'

import type { Lb08Config } from '../../src/modules/lb08/config.ts'
import { seedStock } from '../../src/modules/lb08/data/seed.ts'
import type { Lb08Database } from '../../src/modules/lb08/db/connection.ts'
import type { DeadLetterNote, EngineDeps, StepScheduler } from '../../src/modules/lb08/engine/deps.ts'
import { StepFailure, StepKilled } from '../../src/modules/lb08/engine/errors.ts'
import type { Hooks } from '../../src/modules/lb08/engine/sandbox.ts'
import { runStep } from '../../src/modules/lb08/engine/steps.ts'
import { createWorkflow } from '../../src/modules/lb08/engine/store.ts'
import { createTestDatabase } from './database.ts'
import { loadSamples, loadStock } from './data.ts'

/** Two visitors, known by their session hashes. */
export const ALICE = 'session-alice-0123456789'
export const BOB = 'session-bob-0123456789ab'

/** The settings tests run with: the production numbers, with the waits made short. */
export const TEST_CONFIG: Lb08Config = {
  maxAttempts: 3,
  backoffMs: 40,
  retentionMs: 24 * 3_600_000,
  staleAfterMs: 60_000,
  workerConcurrency: 2,
  sweepEveryMs: 200,
}

/** Keeps the spans the engine writes, so a test can read them. */
export class MemorySpans implements SpanWriter {
  readonly spans: Span[] = []

  /** Stores finished spans. */
  async write(spans: readonly Span[]): Promise<void> {
    this.spans.push(...spans)
  }
}

/** One job in the hand-driven queue. */
export interface ManualJob {
  runId: string
  nodeId: string
}

/** A queue the test runs by hand: jobs wait in a list until `drive` or the test takes them. */
export class ManualScheduler implements StepScheduler {
  readonly jobs: ManualJob[] = []
  readonly parked = new Map<string, DeadLetterNote>()
  // Every job ever added, to check the engine never adds one twice.
  readonly added: ManualJob[] = []

  /** Adds a job unless the same step already has one waiting, as BullMQ does with a job id. */
  async enqueue(runId: string, nodeId: string): Promise<void> {
    this.added.push({ runId, nodeId })
    if (!this.jobs.some(job => job.runId === runId && job.nodeId === nodeId)) this.jobs.push({ runId, nodeId })
  }

  /** Adds a job for a step that has none waiting. */
  async requeue(runId: string, nodeId: string): Promise<void> {
    await this.enqueue(runId, nodeId)
  }

  /** Remembers a dead letter. */
  async park(note: DeadLetterNote): Promise<void> {
    this.parked.set(`${note.runId}/${note.nodeId}`, note)
  }

  /** Forgets a dead letter. */
  async unpark(runId: string, nodeId: string): Promise<void> {
    this.parked.delete(`${runId}/${nodeId}`)
  }

  /** Forgets every parked dead letter older than the limit; the test queue doesn't track age, so it forgets all. */
  async expireParked(): Promise<void> {
    this.parked.clear()
  }
}

/** The engine, the database behind it and the controls a test uses. */
export interface Harness {
  database: Lb08Database
  deps: EngineDeps
  scheduler: ManualScheduler
  spans: MemorySpans
  // Where a test may stop a worker; the engine reads the same object.
  hooks: Hooks
  // Moves the clock the engine reads forward.
  advance: (milliseconds: number) => void
  close: () => Promise<void>
}

/**
 * Builds the engine on a database of its own, with the migrations applied and the stock list
 * loaded. Its spans are kept in memory (`harness.spans`) unless `writer` says where else they
 * go, such as a real gateway's Redis, for a test that reads the trace back through the gateway.
 */
export async function createHarness(serverUrl: string, config: Lb08Config = TEST_CONFIG, writer?: SpanWriter): Promise<Harness> {
  const testDatabase = await createTestDatabase(serverUrl)
  const database = await testDatabase.open()
  await seedStock(database.db, loadStock())
  const spans = new MemorySpans()
  const scheduler = new ManualScheduler()
  const hooks: Hooks = {}
  let offset = 0
  // One clock for the engine and the tracer, so a test that moves time moves both and the root span still covers its steps.
  const clock = (): number => Date.now() + offset
  const deps: EngineDeps = {
    db: database.db,
    config,
    scheduler,
    tracer: new Tracer(writer ?? spans, clock),
    log: pino({ level: 'silent' }),
    now: () => new Date(clock()),
    hooks,
  }
  return {
    database,
    deps,
    scheduler,
    spans,
    hooks,
    advance(milliseconds) {
      offset += milliseconds
    },
    close: () => testDatabase.drop(),
  }
}

/**
 * Runs the queue's jobs one at a time until none are left, as a worker would. A job whose
 * step failed and will be retried, or whose worker was "killed", goes back in the queue; a
 * step that failed for good is dropped. Gives up after `limit` jobs, so a bug that loops
 * fails the test instead of hanging it.
 */
export async function drive(harness: Harness, limit = 200): Promise<number> {
  let processed = 0
  for (let job = harness.scheduler.jobs.shift(); job !== undefined; job = harness.scheduler.jobs.shift()) {
    processed += 1
    if (processed > limit) throw new Error('The queue never settled.')
    try {
      await runStep(harness.deps, job.runId, job.nodeId)
    }
    catch (error) {
      const again = error instanceof StepKilled || (error instanceof StepFailure && error.retry)
      if (again) harness.scheduler.jobs.push(job)
      else if (!(error instanceof StepFailure)) throw error
    }
  }
  return processed
}

/** Creates a workflow for a visitor from one of the curated samples, and returns its id and the sample's payload. */
export async function workflowFromSample(harness: Harness, sessionKey: string, sampleId: string): Promise<{ workflowId: string, input: Record<string, string | number | boolean> }> {
  const sample = loadSamples().find(candidate => candidate.id === sampleId)
  if (!sample) throw new Error(`No sample called ${sampleId}.`)
  const workflowId = await createWorkflow(harness.deps, { sessionKey, graph: sample.graph, origin: 'sample', description: null, modelCalls: 0, traceRunId: null })
  return { workflowId, input: sample.input }
}
