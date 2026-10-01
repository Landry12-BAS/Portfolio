// What the engine is given to work with: the database, the queue, the tracer and the clock.
// Passing them in, instead of reaching for globals, is what lets the tests run the same
// engine against a queue they drive by hand, a clock they set and a hook that stops a worker.
import type { Tracer } from '@lb/common'
import type { Logger } from 'pino'

import type { Lb08Config } from '../config.ts'
import type { Lb08Db } from '../db/connection.ts'
import type { Hooks } from './sandbox.ts'

/** A step that used all its attempts, as the parked copy in the dead-letter queue describes it. */
export interface DeadLetterNote {
  runId: string
  nodeId: string
  attempts: number
  code: string
}

/**
 * Where step jobs wait for a worker. BullMQ is the real one (queue.ts); tests use a list
 * they run by hand. Every method is safe to repeat: the engine calls them again after a
 * crash, and the queue must not run a step twice because of it.
 */
export interface StepScheduler {
  // Makes sure a job exists for the step. Asking again while one exists changes nothing.
  enqueue: (runId: string, nodeId: string) => Promise<void>
  // For the sweep: replaces a job that finished or failed without the step moving on.
  requeue: (runId: string, nodeId: string) => Promise<void>
  // Parks a copy of a dead-lettered step where the owner's queue tools can see it.
  park: (note: DeadLetterNote) => Promise<void>
  // Takes that copy away, once the step has been replayed.
  unpark: (runId: string, nodeId: string) => Promise<void>
  // Removes parked copies older than this many milliseconds: they expire with the data they describe.
  expireParked: (olderThanMs: number) => Promise<void>
}

/** Everything the engine's functions need. */
export interface EngineDeps {
  db: Lb08Db
  config: Lb08Config
  scheduler: StepScheduler
  tracer: Tracer
  log: Logger
  now: () => Date
  // Where a test may stop a worker. Production passes none.
  hooks: Hooks
}
