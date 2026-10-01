// LB-08 Automation Studio as a module of the Node monolith: its connections, its routes,
// its workers, and how its schema and data are made. Everything else about LB-08 lives in
// the folders beside this file: `db` (the schema), `engine` (runs, steps, the queue),
// `generate` (describing a workflow with a model), `data` and `golden` (the synthetic data
// and the golden set) and `routes` (the API).
import { createVisitorVerifier } from '@lb/common'
import type { VisitorVerifier } from '@lb/common'
import type { FastifyInstance } from 'fastify'

import { seedDirectory } from '../../core/data-files.ts'
import type { Env } from '../../core/env.ts'
import type { RunningModule, SystemModule } from '../../core/module.ts'
import { openRedis } from '../../core/redis.ts'
import { DEFAULT_CONFIG } from './config.ts'
import type { Lb08Config } from './config.ts'
import { readSamples } from './data/samples.ts'
import { seedStock } from './data/seed.ts'
import { readStockFile } from './data/stock.ts'
import { LB08_SCHEMA } from './db/schema.ts'
import { migrateLb08, openLb08Database } from './db/connection.ts'
import type { EngineDeps } from './engine/deps.ts'
import { BullScheduler, startMaintenance, startStepWorker } from './engine/queue.ts'
import { DESCRIBE_ALIAS, GatewayJsonModel } from './generate/model.ts'
import { createDescribeWorkflow } from './generate/pipeline.ts'
import { LB08_SCHEMA_NAMES, registerLb08Routes } from './routes/index.ts'
import type { Lb08Services } from './routes/shared.ts'

// Where LB-08's routes live.
const API_PREFIX = '/api/lb08'

/** The database URL LB-08 connects with: its own role's, or the shared one in development. */
function databaseUrl(env: Env): string {
  return env.LB08_DATABASE_URL ?? env.LB_DATABASE_URL
}

/** Where the synthetic data lives for a given environment. */
function seedDirectoryOf(env: Env): string {
  return seedDirectory({ LB_SEED_DIR: env.LB_SEED_DIR })
}

/**
 * Stands in for the engine's dependencies when routes are registered only to be documented:
 * a route handler never runs then, so touching any of them is a bug, and fails at once.
 */
function untouchableDeps(): EngineDeps {
  return new Proxy({}, {
    get(_target, property) {
      throw new Error(`The documentation build must not use the engine (${String(property)}).`)
    },
  }) as EngineDeps
}

/** Builds LB-08's module with the given operating settings: production's by default, a test's with the waits made short. */
export function createLb08Module(config: Lb08Config = DEFAULT_CONFIG): SystemModule {
  return {
    part: 'lb-08',
    apiPrefix: API_PREFIX,
    schema: LB08_SCHEMA,
    schemaNames: LB08_SCHEMA_NAMES,

    async open(context): Promise<RunningModule> {
      const { env, log } = context
      const database = openLb08Database(databaseUrl(env), error => log.warn({ err: error }, 'lb08 database connection error'))
      const redis = openRedis(env.LB_REDIS_URL, log)
      const scheduler = new BullScheduler(redis, env.LB_REDIS_PREFIX, config)
      const deps: EngineDeps = { db: database.db, config, scheduler, tracer: context.tracer, log, now: context.now, hooks: {} }
      const describe = context.gateway
        ? createDescribeWorkflow({ model: new GatewayJsonModel(context.gateway.chat(DESCRIBE_ALIAS)), tracer: context.tracer })
        : undefined
      const services: Lb08Services = { deps, describe, samples: readSamples(seedDirectoryOf(env)) }
      return {
        part: 'lb-08',
        apiPrefix: API_PREFIX,
        registerRoutes: (scope: FastifyInstance) => registerLb08Routes(scope, services, context.visitorVerifier),
        async startWorkers() {
          const steps = startStepWorker(deps, redis, env.LB_REDIS_PREFIX)
          const maintenance = await startMaintenance(deps, redis, env.LB_REDIS_PREFIX)
          return [steps, maintenance]
        },
        // Ready when the schema has been migrated and both Postgres and Redis answer.
        async isReady() {
          await database.pool.query('SELECT 1 FROM workflows LIMIT 0')
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
      const database = openLb08Database(databaseUrl(env))
      try {
        return await migrateLb08(database)
      }
      finally {
        await database.close()
      }
    },

    async seed(env) {
      const database = openLb08Database(databaseUrl(env))
      try {
        const products = await seedStock(database.db, readStockFile(seedDirectoryOf(env)))
        return `lb08: ${products} products in the stock list`
      }
      finally {
        await database.close()
      }
    },

    documentRoutes(scope) {
      const verify: VisitorVerifier = createVisitorVerifier('lb-08', undefined)
      registerLb08Routes(scope, { deps: untouchableDeps(), describe: undefined, samples: readSamples(seedDirectory()) }, verify)
    },
  }
}

/** LB-08 with production's settings. */
export const lb08Module: SystemModule = createLb08Module()
