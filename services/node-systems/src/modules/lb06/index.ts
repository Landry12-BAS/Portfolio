// LB-06 Incident Commander as a module of the Node monolith: its connections, its routes, its socket,
// its workers, and how its schema and data are made. Everything else about LB-06 lives in the folders
// beside this file: `sim` (the seeded shop), `detect` (the SLO, the correlation, the summaries),
// `agents` (the orchestrator, the prompts, the tools), `golden` (the golden set, its grader and the
// reference agents), `data` (the samples), `db` (the schema), `engine` (the store, the service, the
// job, the feed, the socket, the queue, the sweep) and `routes` (the API).
import { createVisitorVerifier } from '@lb/common'
import type { Gateway, VisitorVerifier } from '@lb/common'
import type { FastifyInstance } from 'fastify'

import type { Env } from '../../core/env.ts'
import type { RunningModule, SystemModule } from '../../core/module.ts'
import { openRedis } from '../../core/redis.ts'
import { ALIASES, GatewayJsonModel, MAX_OUTPUT_TOKENS } from './agents/model.ts'
import { DEFAULT_CONFIG } from './config.ts'
import type { Lb06Config } from './config.ts'
import { readSampleCatalogue } from './data/samples.ts'
import { migrateLb06, openLb06Database } from './db/connection.ts'
import { LB06_SCHEMA } from './db/schema.ts'
import type { AgentServices, Lb06Deps } from './engine/deps.ts'
import { NO_FEED, RedisFeedWriter } from './engine/feed.ts'
import { BullScheduler, startIncidentWorker, startMaintenance } from './engine/queue.ts'
import { registerSocket } from './engine/socket.ts'
import { LB06_SCHEMA_NAMES, registerLb06Routes } from './routes/index.ts'

// Where LB-06's routes live.
const API_PREFIX = '/api/lb06'

/** The database URL LB-06 connects with: its own role's, or the shared one in development. */
function databaseUrl(env: Env): string {
  return env.LB06_DATABASE_URL ?? env.LB_DATABASE_URL
}

/** The models the agents ask and the guard, built from the gateway client, so the module, the live eval and the tests ask the same aliases the same way. */
export function agentServices(gateway: Gateway): AgentServices {
  return {
    models: {
      reason: new GatewayJsonModel(gateway.chat(ALIASES.reason), MAX_OUTPUT_TOKENS.reason),
      tools: new GatewayJsonModel(gateway.chat(ALIASES.tools), MAX_OUTPUT_TOKENS.tools),
    },
    guard: {
      check: async (text) => {
        const verdict = await gateway.guard(text)
        return { flagged: verdict.flagged, score: verdict.score }
      },
    },
  }
}

/** Stands in for the engine's dependencies when routes are registered only to be documented: touching any of them is a bug, and fails at once. */
function untouchableDeps(): Lb06Deps {
  return new Proxy({}, {
    get(_target, property) {
      throw new Error(`The documentation build must not use the engine (${String(property)}).`)
    },
  }) as Lb06Deps
}

/** Builds LB-06's module with the given operating settings: production's by default, a test's with the waits made short. */
export function createLb06Module(config: Lb06Config = DEFAULT_CONFIG): SystemModule {
  return {
    part: 'lb-06',
    apiPrefix: API_PREFIX,
    schema: LB06_SCHEMA,
    schemaNames: LB06_SCHEMA_NAMES,

    async open(context): Promise<RunningModule> {
      const { env, log } = context
      const database = openLb06Database(databaseUrl(env), error => log.warn({ err: error }, 'lb06 database connection error'))
      const redis = openRedis(env.LB_REDIS_URL, log)
      const scheduler = new BullScheduler(redis, env.LB_REDIS_PREFIX)
      const deps: Lb06Deps = {
        db: database.db,
        config,
        scheduler,
        feed: new RedisFeedWriter(redis, env.LB_REDIS_PREFIX),
        tracer: context.tracer,
        log,
        now: context.now,
        samples: readSampleCatalogue(),
        agents: context.gateway ? agentServices(context.gateway) : undefined,
      }
      let socket: ReturnType<typeof registerSocket> | undefined
      return {
        part: 'lb-06',
        apiPrefix: API_PREFIX,
        registerRoutes: (scope: FastifyInstance) => registerLb06Routes(scope, { deps }, context.visitorVerifier),
        registerRootRoutes: async (app: FastifyInstance) => {
          socket = registerSocket(app, { deps, verify: context.visitorVerifier, openRedis: () => openRedis(env.LB_REDIS_URL, log), redisPrefix: env.LB_REDIS_PREFIX, config })
        },
        async startWorkers() {
          const incidents = startIncidentWorker(deps, redis, env.LB_REDIS_PREFIX, config)
          const maintenance = await startMaintenance(deps, redis, env.LB_REDIS_PREFIX, config)
          return [incidents, maintenance]
        },
        // Ready when the schema has been migrated and both Postgres and Redis answer.
        async isReady() {
          await database.pool.query('SELECT 1 FROM incidents LIMIT 0')
          return (await redis.ping()) === 'PONG'
        },
        async close() {
          socket?.close()
          await scheduler.close()
          redis.disconnect()
          await database.close()
        },
      }
    },

    async migrate(env) {
      const database = openLb06Database(databaseUrl(env))
      try {
        return await migrateLb06(database)
      }
      finally {
        await database.close()
      }
    },

    // LB-06 has no rows to load: its data is the golden set's samples, which seeding reads strictly, so a deploy with a damaged file fails here and not at a visitor's first incident.
    async seed() {
      const catalogue = readSampleCatalogue()
      return `lb06: ${catalogue.samples.length} curated samples from the golden set, checked`
    },

    documentRoutes(scope) {
      const verify: VisitorVerifier = createVisitorVerifier('lb-06', undefined)
      registerLb06Routes(scope, { deps: untouchableDeps() }, verify)
    },
  }
}

/** LB-06 with production's settings. */
export const lb06Module: SystemModule = createLb06Module()

/** A feed that drops everything, for a process that has none. */
export { NO_FEED }
