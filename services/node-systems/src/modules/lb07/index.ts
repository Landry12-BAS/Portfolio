// LB-07 QA Engineer as a module of the Node monolith: its connections, its routes, its workers, and how
// its schema and data are made. Everything else about LB-07 lives in the folders beside this file: `shop`
// (the staging shop the agent tests, run by the sandbox process), `runner` (the browser, run by the sandbox
// process, and the client the worker drives it with), `agent` (the state machine, the prompts, the test
// generator and the report rules), `data` and `golden` (the bug catalogue and the golden set), `db` (the
// schema), `engine` (runs, the queue, the sweep, quotas) and `routes` (the API).
import { createVisitorVerifier } from '@lb/common'
import type { VisitorVerifier } from '@lb/common'
import type { FastifyInstance } from 'fastify'

import { evalsDirectory, seedDirectory } from '../../core/data-files.ts'
import type { Env } from '../../core/env.ts'
import type { RunningModule, SystemModule } from '../../core/module.ts'
import { openRedis } from '../../core/redis.ts'
import { DEFAULT_CONFIG } from './config.ts'
import type { Lb07Config } from './config.ts'
import { readBugCatalogue } from './data/bugs.ts'
import { migrateLb07, openLb07Database } from './db/connection.ts'
import { LB07_SCHEMA } from './db/schema.ts'
import type { Lb07Deps, SandboxServices } from './engine/deps.ts'
import { BullScheduler, startMaintenance, startRunWorker } from './engine/queue.ts'
import { agentServices, sandboxServices } from './engine/services.ts'
import { readGoldenSet, sampleCases } from './golden/cases.ts'
import { LB07_SCHEMA_NAMES, registerLb07Routes } from './routes/index.ts'

// Where LB-07's routes live.
const API_PREFIX = '/api/lb07'

/** The database URL LB-07 connects with: its own role's, or the shared one in development. */
function databaseUrl(env: Env): string {
  return env.LB07_DATABASE_URL ?? env.LB_DATABASE_URL
}

/** Where the golden set lives for a given environment. */
function goldenFile(env: Env): string {
  return `${evalsDirectory({ LB_EVALS_DIR: env.LB_EVALS_DIR })}/lb07/golden.yaml`
}

/** Stands in for the engine's dependencies when routes are registered only to be documented. */
function untouchableDeps(): Lb07Deps {
  return new Proxy({}, {
    get(_target, property) {
      throw new Error(`The documentation build must not use the engine (${String(property)}).`)
    },
  }) as Lb07Deps
}

/** The sandbox the worker drives, when the settings name one; a worker without them fails every run as `runner_unavailable`, which is visible, instead of leaving it queued. */
function sandboxOf(env: Env, now: () => Date): SandboxServices | undefined {
  if (!env.LB07_RUNNER_URL || !env.LB07_SHOP_TOKEN_KEY) return undefined
  return sandboxServices({ runnerUrl: env.LB07_RUNNER_URL, tokenKeyHex: env.LB07_SHOP_TOKEN_KEY, shopOrigin: env.LB07_SHOP_ORIGIN }, now)
}

/** Builds LB-07's module with the given operating settings: production's by default, a test's with the waits made short. */
export function createLb07Module(config: Lb07Config = DEFAULT_CONFIG): SystemModule {
  return {
    part: 'lb-07',
    apiPrefix: API_PREFIX,
    schema: LB07_SCHEMA,
    schemaNames: LB07_SCHEMA_NAMES,

    async open(context): Promise<RunningModule> {
      const { env, log } = context
      const database = openLb07Database(databaseUrl(env), error => log.warn({ err: error }, 'lb07 database connection error'))
      const redis = openRedis(env.LB_REDIS_URL, log)
      const scheduler = new BullScheduler(redis, env.LB_REDIS_PREFIX, config)
      const seed = seedDirectory({ LB_SEED_DIR: env.LB_SEED_DIR })
      const catalogue = readBugCatalogue(seed)
      const deps: Lb07Deps = {
        db: database.db,
        config,
        scheduler,
        tracer: context.tracer,
        log,
        now: context.now,
        catalogue,
        samples: sampleCases(readGoldenSet(goldenFile(env), catalogue)),
        agent: context.gateway ? agentServices(context.gateway) : undefined,
        sandbox: sandboxOf(env, context.now),
      }
      if (!deps.sandbox) log.warn('lb07: no browser runner is configured (LB07_RUNNER_URL, LB07_SHOP_TOKEN_KEY); a worker in this process would fail every run as runner_unavailable')
      return {
        part: 'lb-07',
        apiPrefix: API_PREFIX,
        registerRoutes: (scope: FastifyInstance) => registerLb07Routes(scope, { deps }, context.visitorVerifier),
        async startWorkers() {
          const runs = startRunWorker(deps, redis, env.LB_REDIS_PREFIX)
          const maintenance = await startMaintenance(deps, redis, env.LB_REDIS_PREFIX)
          return [runs, maintenance]
        },
        async isReady() {
          await database.pool.query('SELECT 1 FROM runs LIMIT 0')
          return (await redis.ping()) === 'PONG'
        },
        async close() {
          await scheduler.close()
          redis.disconnect()
          await database.close()
        },
      }
    },

    async migrate(env) {
      const database = openLb07Database(databaseUrl(env))
      try {
        return await migrateLb07(database)
      }
      finally {
        await database.close()
      }
    },

    // LB-07 has no rows to load: its data is the bug catalogue and the golden set, which are files. Seeding reads them strictly, so a deploy with a damaged file fails here and not at a visitor's first run.
    async seed(env) {
      const catalogue = readBugCatalogue(seedDirectory({ LB_SEED_DIR: env.LB_SEED_DIR }))
      const golden = readGoldenSet(goldenFile(env), catalogue)
      return `lb07: ${catalogue.size} bugs and ${golden.length} golden cases (${sampleCases(golden).length} samples), checked`
    },

    documentRoutes(scope) {
      const verify: VisitorVerifier = createVisitorVerifier('lb-07', undefined)
      registerLb07Routes(scope, { deps: untouchableDeps() }, verify)
    },
  }
}

/** LB-07 with production's settings. */
export const lb07Module: SystemModule = createLb07Module()
