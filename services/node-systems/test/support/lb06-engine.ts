// LB-06's engine under test: a real database of its own, a queue the test drives by hand, a clock it
// can move, a feed that keeps what was published (or the real Redis feed when a test gives a
// connection), a recorder for the spans, and the reference agents (or scripts) for the models. The
// clock ticks fast (a few milliseconds a simulated minute), so a whole incident runs in a second.
import { Tracer } from '@lb/common'
import type { SpanWriter } from '@lb/common'
import type { Lb06Event } from '@lb/contracts'
import { notInArray } from 'drizzle-orm'
import { pino } from 'pino'

import type { AgentModels } from '../../src/modules/lb06/agents/model.ts'
import { DEFAULT_CONFIG } from '../../src/modules/lb06/config.ts'
import type { Lb06Config } from '../../src/modules/lb06/config.ts'
import { readSampleCatalogue } from '../../src/modules/lb06/data/samples.ts'
import type { Lb06Database } from '../../src/modules/lb06/db/connection.ts'
import { incidents } from '../../src/modules/lb06/db/schema.ts'
import type { FeedWriter } from '../../src/modules/lb06/engine/feed.ts'
import type { Guard, JobScheduler, Lb06Deps } from '../../src/modules/lb06/engine/deps.ts'
import { runIncidentJob } from '../../src/modules/lb06/engine/job.ts'
import { ENDED_STATES } from '../../src/modules/lb06/engine/store.ts'
import { ReferenceAgents } from '../../src/modules/lb06/golden/reference.ts'
import { createLb06TestDatabase } from './lb06-database.ts'
import { Recorder } from './lb06.ts'

/** Two visitors, known by their session hashes. */
export const VISITOR_A = 'session-anna-0123456789ab'
export const VISITOR_B = 'session-boris-0123456789a'

/** The settings tests run with: the production numbers, with the clock made fast and the waits short. */
export const LB06_TEST_CONFIG: Lb06Config = {
  ...DEFAULT_CONFIG,
  tickMs: 4,
  maxWallMs: 60_000,
  staleAfterMs: 2_000,
  sweepEveryMs: 200,
  socketPingMs: 200,
  socketIdleMs: 1_500,
  socketHelloMs: 300,
}

/** A clock the test moves. */
export class TestClock {
  #millis: number

  /** Starts at a fixed moment in the morning of a day. */
  constructor(start = '2026-10-02T09:00:00.000Z') {
    this.#millis = Date.parse(start)
  }

  /** The moment it is now. */
  now = (): Date => new Date(this.#millis)

  /** Moves the clock forward. */
  advance(milliseconds: number): void {
    this.#millis += milliseconds
  }
}

/** A queue the test runs by hand: jobs wait in a list until the test takes them. */
export class ManualScheduler implements JobScheduler {
  readonly jobs: string[] = []
  readonly added: string[] = []
  readonly requeued: string[] = []
  #failNext: Error | undefined

  /** Makes the next `enqueue` fail, as a Redis that is down would. */
  failNextEnqueue(error: Error): void {
    this.#failNext = error
  }

  /** Adds a job unless the same incident already has one waiting. */
  async enqueue(incidentId: string): Promise<void> {
    if (this.#failNext) {
      const failure = this.#failNext
      this.#failNext = undefined
      throw failure
    }
    this.added.push(incidentId)
    if (!this.jobs.includes(incidentId)) this.jobs.push(incidentId)
  }

  /** Adds a job for an incident that has none waiting. */
  async requeue(incidentId: string): Promise<void> {
    this.requeued.push(incidentId)
    if (!this.jobs.includes(incidentId)) this.jobs.push(incidentId)
  }

  /** Takes the oldest waiting job. */
  take(): string | undefined {
    return this.jobs.shift()
  }
}

/** A feed that keeps everything published, by incident. */
export class MemoryFeed implements FeedWriter {
  readonly published = new Map<string, Lb06Event[]>()

  /** Keeps the events. */
  async publish(incidentId: string, events: readonly Lb06Event[]): Promise<void> {
    const list = this.published.get(incidentId) ?? []
    list.push(...events)
    this.published.set(incidentId, list)
  }
}

/** A guard that answers by what the text says: flagged when it holds the word `ignore`, as the hostile golden cases do. */
export const wordGuard: Guard = {
  check: async (text) => {
    const flagged = /ignore/i.test(text)
    return { flagged, score: flagged ? 0.99 : 0.01 }
  },
}

/** The engine, its database and the things a test uses to look at it. */
export interface Lb06Harness {
  deps: Lb06Deps
  scheduler: ManualScheduler
  feed: MemoryFeed
  spans: Recorder
  clock: TestClock
  database: Lb06Database
  agents: ReferenceAgents
  // Runs the waiting jobs until none is left: each to its end.
  drive: () => Promise<void>
  // Ends every incident a job is still running, waits for the jobs, then drops the database: a test
  // that fails before it awaits its job must not leave a loop ticking on a database that is gone.
  close: () => Promise<void>
}

/** What a harness is made with. */
export interface HarnessOptions {
  config?: Partial<Lb06Config>
  models?: AgentModels
  guard?: Guard | undefined
  // `false` for a process that has no gateway.
  withAgents?: boolean
  feed?: FeedWriter
  // Where the spans go: the recorder by default, or a writer of the test's own (the gateway's Redis, for a trace the site can read).
  spanWriter?: SpanWriter
}

/** Builds the engine on a database of its own. */
export async function createLb06Harness(serverUrl: string, options: HarnessOptions = {}): Promise<Lb06Harness> {
  const testDatabase = await createLb06TestDatabase(serverUrl)
  const database = await testDatabase.open()
  const spans = new Recorder()
  const clock = new TestClock()
  const scheduler = new ManualScheduler()
  const feed = new MemoryFeed()
  const agents = new ReferenceAgents()
  const deps: Lb06Deps = {
    db: database.db,
    config: { ...LB06_TEST_CONFIG, ...options.config },
    scheduler,
    feed: options.feed ?? feed,
    tracer: new Tracer(options.spanWriter ?? spans),
    log: pino({ level: 'silent' }),
    now: clock.now,
    samples: readSampleCatalogue(),
    agents: options.withAgents === false ? undefined : { models: options.models ?? { reason: agents, tools: agents }, guard: options.guard === undefined && !('guard' in options) ? wordGuard : options.guard },
  }
  const running = new Set<Promise<void>>()
  /** Runs the waiting jobs one after another until the queue is empty. */
  async function runWaitingJobs(): Promise<void> {
    for (let id = scheduler.take(); id !== undefined; id = scheduler.take()) await runIncidentJob(deps, id, { number: 1 })
  }
  return {
    deps,
    scheduler,
    feed,
    spans,
    clock,
    database,
    agents,
    drive() {
      const job = runWaitingJobs()
      running.add(job)
      job.catch(() => undefined).finally(() => running.delete(job))
      return job
    },
    async close() {
      if (running.size > 0) {
        await database.db.update(incidents).set({ state: 'aborted', endReason: 'timed_out', pendingProposal: null, updatedAt: clock.now() }).where(notInArray(incidents.state, [...ENDED_STATES]))
        await Promise.allSettled([...running])
      }
      await testDatabase.drop()
    },
  }
}
