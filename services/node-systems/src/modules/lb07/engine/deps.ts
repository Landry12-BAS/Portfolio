// What the engine is given to work with: the database, the queue, the browser runner, the model, the
// guard, the tracer and the clock. Passing them in, instead of reaching for globals, is what lets the
// tests run the same engine against a queue they drive by hand, a clock they set, a runner that is a
// script and a model that is a script.
import type { Tracer } from '@lb/common'
import type { Lb07BugId } from '@lb/contracts'
import type { Logger } from 'pino'

import type { Guard } from '../agent/machine.ts'
import type { JsonModel } from '../agent/model.ts'
import type { Lb07Config } from '../config.ts'
import type { BugCatalogue } from '../data/bugs.ts'
import type { Lb07Db } from '../db/connection.ts'
import type { GoldenCase } from '../golden/cases.ts'
import type { Runner } from '../runner/client.ts'

/** Where runs wait for the worker. BullMQ is the real one (queue.ts); tests use a list they run by hand. Every method is safe to repeat. */
export interface JobScheduler {
  enqueue: (runId: string) => Promise<void>
  requeue: (runId: string) => Promise<void>
}

/** The model and the guard the agent asks. Absent in a process that has no gateway. */
export interface AgentServices {
  model: JsonModel
  guard: Guard | undefined
}

/** The sandbox the worker drives: the runner, the signer of bug tokens, and the shop's origin as the test's reader would run it. Absent in the API process, and in a worker not configured for LB-07. */
export interface SandboxServices {
  runner: Runner
  signToken: (runId: string, bugs: readonly Lb07BugId[]) => string
  shopOrigin: string
}

/** Everything the engine's functions need. */
export interface Lb07Deps {
  db: Lb07Db
  config: Lb07Config
  scheduler: JobScheduler
  tracer: Tracer
  log: Logger
  now: () => Date
  catalogue: BugCatalogue
  // The curated samples: the golden cases marked as such.
  samples: readonly GoldenCase[]
  agent: AgentServices | undefined
  sandbox: SandboxServices | undefined
}
