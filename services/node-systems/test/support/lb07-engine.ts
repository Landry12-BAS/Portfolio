// LB-07's engine under test: a real database of its own, a queue the test drives by hand, a clock it can
// move, a recorder for the spans the engine writes, a runner that is a script and a model that is a
// script. Driving the queue by hand makes the engine deterministic: the test decides when each job runs
// and never waits for a backoff; the real BullMQ queue has its own test.
import { Tracer } from '@lb/common'
import type { Lb07BugId } from '@lb/contracts'
import { pino } from 'pino'

import type { Lb07Config } from '../../src/modules/lb07/config.ts'
import type { Lb07Database } from '../../src/modules/lb07/db/connection.ts'
import type { AgentServices, JobScheduler, Lb07Deps } from '../../src/modules/lb07/engine/deps.ts'
import { RunRetry } from '../../src/modules/lb07/engine/failures.ts'
import { runJob } from '../../src/modules/lb07/engine/job.ts'
import { sampleCases } from '../../src/modules/lb07/golden/cases.ts'
import type { GoldenCase } from '../../src/modules/lb07/golden/cases.ts'
import { signBugToken, TOKEN_LIFETIME_MS } from '../../src/modules/lb07/shop/token.ts'
import { ScriptedModel } from './fake-model.ts'
import { loadCatalogue, loadGolden } from './lb07.ts'
import { createLb07TestDatabase } from './lb07-database.ts'
import { FakeRunner } from './lb07-fake-runner.ts'
import { TestClock } from './lb04-engine.ts'
import { Recorder } from './lb04.ts'
import { TEST_TOKEN_KEY } from './lb07-shop.ts'

export { TestClock } from './lb04-engine.ts'
export { Recorder } from './lb04.ts'

/** Two visitors, known by their session hashes. */
export const VISITOR_A = 'session-anna-0123456789ab'
export const VISITOR_B = 'session-boris-0123456789a'

/** The settings tests run with: the production numbers, with the waits made short. */
export const LB07_TEST_CONFIG: Lb07Config = {
  maxAttempts: 2,
  backoffMs: 40,
  keptMs: 60 * 60_000,
  staleAfterMs: 60_000,
  sweepEveryMs: 200,
  runTimeMs: 180_000,
  maxQueued: 4,
  maxQueueWaitMs: 15 * 60_000,
  busyWaitMs: 5,
  busyWaits: 3,
}

/** A queue the test runs by hand. */
export class ManualScheduler implements JobScheduler {
  readonly jobs: string[] = []
  readonly added: string[] = []
  readonly requeued: string[] = []
  readonly #failures: Error[] = []

  /** Makes the next `enqueue` fail. */
  failNextEnqueue(error: Error): void {
    this.#failures.push(error)
  }

  /** Adds a job unless the same run already has one waiting. */
  async enqueue(runId: string): Promise<void> {
    const failure = this.#failures.shift()
    if (failure) throw failure
    this.added.push(runId)
    if (!this.jobs.includes(runId)) this.jobs.push(runId)
  }

  /** Records a requeue and adds the job. */
  async requeue(runId: string): Promise<void> {
    this.requeued.push(runId)
    if (!this.jobs.includes(runId)) this.jobs.push(runId)
  }

  /** Takes the next job, if any. */
  take(): string | undefined {
    return this.jobs.shift()
  }
}

/** A model that answers a golden case as a correct planner would: the reference plan, then the scripted re-plans, then bug reports written from the findings it is shown. */
export function referenceModel(entry: GoldenCase): ScriptedModel {
  let replans = 0
  return new ScriptedModel((messages) => {
    const system = messages[0]?.content ?? ''
    const user = messages.at(-1)?.content ?? ''
    if (system.startsWith('You are a QA engineer writing bug reports')) {
      const ids = [...user.matchAll(/"id": "(f\d+)"/g)].map(match => match[1] ?? '')
      const kinds = [...user.matchAll(/"kind": "([a-z_]+)"/g)].map(match => match[1] ?? '')
      return { kind: 'json', value: { reports: ids.map((id, index) => ({ findingIds: [id], title: `Bug ${index + 1}: ${kinds[index] ?? 'finding'}`, steps: ['Follow the test steps.'], expected: 'The shop behaves as the goal requires.', actual: 'It does not: see the finding.', severity: kinds[index] === 'accessibility' ? 'medium' : 'high' })) } }
    }
    if (system.includes('A step of your plan failed')) {
      const steps = entry.replans[replans] ?? []
      replans += 1
      return { kind: 'json', value: { reason: 'The page names the control differently.', steps } }
    }
    return { kind: 'json', value: { reading: `Checking: ${entry.title}.`, steps: entry.plan } }
  })
}

/** The engine's dependencies on a test database, and the knobs the tests turn. */
export interface Lb07Harness {
  deps: Lb07Deps
  db: Lb07Database
  scheduler: ManualScheduler
  clock: TestClock
  recorder: Recorder
  runner: FakeRunner
  // The model the agent asks; a test replaces it per run.
  models: { current: ScriptedModel }
  // What the guard says of every goal from now on, and how many times it was asked.
  guard: { flags: boolean, asked: number }
  // Every line the engine logged, as written.
  logLines: string[]
  close: () => Promise<void>
}

/** What a test may choose. */
export interface HarnessOptions {
  config?: Partial<Lb07Config>
  // Whether the process has a gateway (an agent) and a sandbox; both by default.
  agent?: boolean
  sandbox?: boolean
  guardFlags?: boolean
}

/** Builds the engine on a database of its own. */
export async function createLb07Harness(serverUrl: string, options: HarnessOptions = {}): Promise<Lb07Harness> {
  const testDatabase = await createLb07TestDatabase(serverUrl)
  const db = await testDatabase.open()
  const clock = new TestClock()
  const recorder = new Recorder()
  const scheduler = new ManualScheduler()
  const runner = new FakeRunner()
  const golden = loadGolden()
  const models = { current: referenceModel(golden[0] as GoldenCase) }
  const guard = { flags: options.guardFlags ?? false, asked: 0 }
  const agent: AgentServices = {
    model: { ask: messages => models.current.ask(messages) },
    guard: {
      check: async () => {
        guard.asked += 1
        return { flagged: guard.flags, score: guard.flags ? 0.97 : 0.01 }
      },
    },
  }
  const logLines: string[] = []
  const deps: Lb07Deps = {
    db: db.db,
    config: { ...LB07_TEST_CONFIG, ...options.config },
    scheduler,
    tracer: new Tracer(recorder),
    log: pino({ level: 'debug' }, { write: (line: string) => void logLines.push(line) }),
    now: clock.now,
    catalogue: loadCatalogue(),
    samples: sampleCases(golden),
    agent: options.agent === false ? undefined : agent,
    sandbox: options.sandbox === false ? undefined : { runner, signToken: (runId: string, bugs: readonly Lb07BugId[]) => signBugToken(TEST_TOKEN_KEY, { runId, bugs: [...bugs], exp: clock.now().getTime() + TOKEN_LIFETIME_MS }), shopOrigin: 'http://127.0.0.1:8007' },
  }
  return { deps, db, scheduler, clock, recorder, runner, models, guard, logLines, close: () => testDatabase.drop() }
}

/** Runs every job the manual queue holds, as the worker would, retrying as the queue would until the attempts are spent. */
export async function drive(harness: Lb07Harness): Promise<void> {
  const attempts = new Map<string, number>()
  for (let runId = harness.scheduler.take(); runId !== undefined; runId = harness.scheduler.take()) {
    const number = (attempts.get(runId) ?? 0) + 1
    attempts.set(runId, number)
    try {
      await runJob(harness.deps, runId, { number, last: number >= harness.deps.config.maxAttempts })
    }
    catch (error) {
      if (!(error instanceof RunRetry)) throw error
      harness.scheduler.jobs.push(runId)
    }
  }
}
