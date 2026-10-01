// What a system is to the monolith: a module with its own API prefix, Postgres schema,
// queues and tests, so any system can be split into a service of its own later
// (docs/STACK.md, Architecture). A new system joins by adding one module to the registry
// in src/modules/registry.ts; nothing else in the monolith changes.
import type { Gateway, Tracer, VisitorVerifier } from '@lb/common'
import type { FastifyInstance } from 'fastify'
import type { Logger } from 'pino'

import type { Env } from './env.ts'

/** What every module is given when it opens: the settings and the shared platform pieces. */
export interface ModuleContext {
  env: Env
  log: Logger
  // Records the spans of the module's runs. Telemetry never fails a run.
  tracer: Tracer
  // The AI gateway client. Only the API process has one: workers make no model calls.
  gateway: Gateway | undefined
  // Checks a visitor token for this module's system, failing closed without the site's key.
  visitorVerifier: VisitorVerifier
  now: () => Date
}

/** A background worker a module runs, so the process can stop it cleanly. */
export interface WorkerHandle {
  close: () => Promise<void>
}

/** A module that has opened its connections and is ready to serve routes or run workers. */
export interface RunningModule {
  // The system's part number, such as lb-08.
  readonly part: string
  // Where the module's routes live, such as /api/lb08.
  readonly apiPrefix: string
  // Adds the module's routes to an encapsulated Fastify scope mounted at `apiPrefix`.
  registerRoutes: (scope: FastifyInstance) => void | Promise<void>
  // Starts the module's queue workers and scheduled jobs (the worker process only).
  startWorkers: () => Promise<readonly WorkerHandle[]>
  // Tells whether the module can reach what it depends on, for the readiness check.
  isReady: () => Promise<boolean>
  // Closes the module's connections.
  close: () => Promise<void>
}

/** A system the monolith hosts. */
export interface SystemModule {
  readonly part: string
  // The Postgres schema the system owns; also its migrations' home.
  readonly schema: string
  open: (context: ModuleContext) => Promise<RunningModule>
}
