// What the engine is given to work with: the database, the queue, the feed, the models, the guard,
// the tracer and the clock. Passing them in is what lets the tests run the same engine against a
// queue they drive by hand, a clock they set and models that are scripts.
import type { Gateway, Tracer } from '@lb/common'
import type { Logger } from 'pino'

import type { AgentModels } from '../agents/model.ts'
import type { Lb06Config } from '../config.ts'
import type { SampleCatalogue } from '../data/samples.ts'
import type { Lb06Db } from '../db/connection.ts'
import type { FeedWriter } from './feed.ts'

/** Where incidents wait for a worker. BullMQ is the real one (queue.ts); tests use a list they run by hand. Every method is safe to repeat. */
export interface JobScheduler {
  // Makes sure a job exists for the incident. Asking again while one exists changes nothing.
  enqueue: (incidentId: string) => Promise<void>
  // For the sweep: replaces a job that finished or failed without the incident ending.
  requeue: (incidentId: string) => Promise<void>
}

/** The injection screen over the visitor's parameters. */
export interface Guard {
  // Says whether a text looks like a prompt injection. Throws when the guard can't be reached.
  check: (text: string) => Promise<{ flagged: boolean, score: number }>
}

/** The models the agents ask and the guard; absent in a process that has no gateway. */
export interface AgentServices {
  models: AgentModels
  guard: Guard | undefined
}

/** Everything the engine's functions need. */
export interface Lb06Deps {
  db: Lb06Db
  config: Lb06Config
  scheduler: JobScheduler
  feed: FeedWriter
  tracer: Tracer
  log: Logger
  now: () => Date
  samples: SampleCatalogue
  // The models; absent when the process has no gateway, which can run no incident.
  agents: AgentServices | undefined
}

/** The gateway client, where the module needs the raw one (the guard). */
export type GatewayClient = Gateway
