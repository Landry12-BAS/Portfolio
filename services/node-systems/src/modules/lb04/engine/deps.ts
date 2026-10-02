// What the engine is given to work with: the database, the queue, the models, the tracer and the
// clock. Passing them in, instead of reaching for globals, is what lets the tests run the same engine
// against a queue they drive by hand, a clock they set and models that are scripts.
import type { Tracer } from '@lb/common'
import type { Logger } from 'pino'

import type { ReviewModels } from '../analysis/model.ts'
import type { Guard } from '../analysis/pipeline.ts'
import type { Lb04Config } from '../config.ts'
import type { SampleContract } from '../data/samples.ts'
import type { Lb04Db } from '../db/connection.ts'
import type { Playbook } from '../playbook/playbook.ts'

/**
 * Where reviews wait for a worker. BullMQ is the real one (queue.ts); tests use a list they run by
 * hand. Every method is safe to repeat: the engine calls them again after a crash, and the queue must
 * not run a review twice because of it.
 */
export interface JobScheduler {
  // Makes sure a job exists for the contract. Asking again while one exists changes nothing.
  enqueue: (contractId: string) => Promise<void>
  // For the sweep: replaces a job that finished or failed without the contract moving on.
  requeue: (contractId: string) => Promise<void>
}

/** The models a review asks: the three chat aliases and the guard. Absent in a process that has no gateway. */
export interface ReviewServices {
  models: ReviewModels
  guard: Guard | undefined
}

/** Everything the engine's functions need. */
export interface Lb04Deps {
  db: Lb04Db
  config: Lb04Config
  scheduler: JobScheduler
  tracer: Tracer
  log: Logger
  now: () => Date
  playbook: Playbook
  // The sample contracts on offer and where their files are.
  samples: readonly SampleContract[]
  seedDirectory: string
  // The models; absent when the process has no gateway, which can't review a contract or propose a redline.
  review: ReviewServices | undefined
}
