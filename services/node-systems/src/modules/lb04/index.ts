// LB-04 Contract Radar as a module of the Node monolith: its connections, its routes, its workers, and
// how its schema and data are made. Everything else about LB-04 lives in the folders beside this
// file: `pdf` (opening a stranger's PDF in a thread of its own), `analysis` (the review pipeline: the
// clauses, the screen, the prompts, the verifier, the report and the redline), `playbook` and `data`
// (the owner's rules and the sample contracts), `golden` (the golden set and its grader), `db` (the
// schema), `engine` (contracts, the queue, the sweep) and `routes` (the API).
import { createVisitorVerifier } from '@lb/common'
import type { Gateway, VisitorVerifier } from '@lb/common'
import type { FastifyInstance } from 'fastify'

import { seedDirectory } from '../../core/data-files.ts'
import type { Env } from '../../core/env.ts'
import type { RunningModule, SystemModule } from '../../core/module.ts'
import { openRedis } from '../../core/redis.ts'
import { ALIASES, GatewayJsonModel, MAX_OUTPUT_TOKENS } from './analysis/model.ts'
import { DEFAULT_CONFIG } from './config.ts'
import type { Lb04Config } from './config.ts'
import { readSampleFile, readSampleList } from './data/samples.ts'
import { migrateLb04, openLb04Database } from './db/connection.ts'
import { LB04_SCHEMA } from './db/schema.ts'
import type { Lb04Deps, ReviewServices } from './engine/deps.ts'
import { BullScheduler, startMaintenance, startReviewWorker } from './engine/queue.ts'
import { readPlaybook } from './playbook/playbook.ts'
import { LB04_SCHEMA_NAMES, registerLb04Routes } from './routes/index.ts'

// Where LB-04's routes live.
const API_PREFIX = '/api/lb04'

/** The database URL LB-04 connects with: its own role's, or the shared one in development. */
function databaseUrl(env: Env): string {
  return env.LB04_DATABASE_URL ?? env.LB_DATABASE_URL
}

/** Where the synthetic data lives for a given environment. */
function seedDirectoryOf(env: Env): string {
  return seedDirectory({ LB_SEED_DIR: env.LB_SEED_DIR })
}

/** The models a review asks, behind the gateway's virtual aliases, and the guard. */
function reviewServices(gateway: Gateway): ReviewServices {
  return {
    models: {
      long: new GatewayJsonModel(gateway.chat(ALIASES.long), MAX_OUTPUT_TOKENS.long),
      reason: new GatewayJsonModel(gateway.chat(ALIASES.reason), MAX_OUTPUT_TOKENS.reason),
      fast: new GatewayJsonModel(gateway.chat(ALIASES.fast), MAX_OUTPUT_TOKENS.fast),
    },
    guard: {
      check: async (text) => {
        const verdict = await gateway.guard(text)
        return { flagged: verdict.flagged, score: verdict.score }
      },
    },
  }
}

/**
 * Stands in for the engine's dependencies when routes are registered only to be documented: a route
 * handler never runs then, so touching any of them is a bug, and fails at once.
 */
function untouchableDeps(): Lb04Deps {
  return new Proxy({}, {
    get(_target, property) {
      throw new Error(`The documentation build must not use the engine (${String(property)}).`)
    },
  }) as Lb04Deps
}

/** Builds LB-04's module with the given operating settings: production's by default, a test's with the waits made short. */
export function createLb04Module(config: Lb04Config = DEFAULT_CONFIG): SystemModule {
  return {
    part: 'lb-04',
    apiPrefix: API_PREFIX,
    schema: LB04_SCHEMA,
    schemaNames: LB04_SCHEMA_NAMES,

    async open(context): Promise<RunningModule> {
      const { env, log } = context
      const database = openLb04Database(databaseUrl(env), error => log.warn({ err: error }, 'lb04 database connection error'))
      const redis = openRedis(env.LB_REDIS_URL, log)
      const scheduler = new BullScheduler(redis, env.LB_REDIS_PREFIX, config)
      const seed = seedDirectoryOf(env)
      const deps: Lb04Deps = {
        db: database.db,
        config,
        scheduler,
        tracer: context.tracer,
        log,
        now: context.now,
        playbook: readPlaybook(seed),
        samples: readSampleList(seed),
        seedDirectory: seed,
        review: context.gateway ? reviewServices(context.gateway) : undefined,
      }
      return {
        part: 'lb-04',
        apiPrefix: API_PREFIX,
        registerRoutes: (scope: FastifyInstance) => registerLb04Routes(scope, { deps }, context.visitorVerifier),
        async startWorkers() {
          const reviews = startReviewWorker(deps, redis, env.LB_REDIS_PREFIX)
          const maintenance = await startMaintenance(deps, redis, env.LB_REDIS_PREFIX)
          return [reviews, maintenance]
        },
        // Ready when the schema has been migrated and both Postgres and Redis answer.
        async isReady() {
          await database.pool.query('SELECT 1 FROM contracts LIMIT 0')
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
      const database = openLb04Database(databaseUrl(env))
      try {
        return await migrateLb04(database)
      }
      finally {
        await database.close()
      }
    },

    // LB-04 has no rows to load: its data is the playbook and the sample contracts, which are files. Seeding reads them strictly, so a deploy with a damaged file fails here and not at a visitor's first review.
    async seed(env) {
      const seed = seedDirectoryOf(env)
      const playbook = readPlaybook(seed)
      const samples = readSampleList(seed)
      for (const entry of samples) readSampleFile(seed, entry)
      return `lb04: the playbook (version ${playbook.version}, ${playbook.rules.size} rules) and ${samples.length} sample contracts, checked`
    },

    documentRoutes(scope) {
      const verify: VisitorVerifier = createVisitorVerifier('lb-04', undefined)
      registerLb04Routes(scope, { deps: untouchableDeps() }, verify)
    },
  }
}

/** LB-04 with production's settings. */
export const lb04Module: SystemModule = createLb04Module()
