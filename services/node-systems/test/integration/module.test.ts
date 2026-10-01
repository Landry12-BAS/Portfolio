// Tests that LB-08's module assembles: opened the way the API and the worker open it, from the
// settings the environment gives, with its migrate and seed commands, its readiness check, its
// routes behind the real token check, and its worker running a workflow that came in over
// HTTP. Everything is real here (Postgres, Redis, BullMQ) except the model, which the API in
// this test doesn't have: samples are what it can build.
import { randomBytes } from 'node:crypto'

import { createVisitorVerifier, RedisSpanWriter, Tracer } from '@lb/common'
import { makeSiteKeys, mintVisitorToken } from '@lb/common/testing'
import { Redis } from 'ioredis'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { buildApp } from '../../src/core/app.ts'
import { loadEnv } from '../../src/core/env.ts'
import type { Env } from '../../src/core/env.ts'
import type { RunningModule, WorkerHandle } from '../../src/core/module.ts'
import { createLb08Module } from '../../src/modules/lb08/index.ts'
import { LB08_SCHEMA_NAMES } from '../../src/modules/lb08/routes/index.ts'
import { createTestDatabase } from '../support/database.ts'
import type { TestDatabase } from '../support/database.ts'
import { loadSamples } from '../support/data.ts'
import { TEST_CONFIG } from '../support/engine.ts'
import { waitFor } from '../support/wait.ts'

const module = createLb08Module(TEST_CONFIG)
const prefix = `lbtest-${randomBytes(4).toString('hex')}:`
const site = makeSiteKeys()

let testDatabase: TestDatabase
let env: Env
let redis: Redis
let running: RunningModule
let workers: readonly WorkerHandle[]

beforeAll(async () => {
  testDatabase = await createTestDatabase(inject('databaseUrl'))
  // The settings, as the process environment would give them: validated by the same schema the real entry points use.
  env = loadEnv({ LB_DATABASE_URL: testDatabase.url, LB_REDIS_URL: inject('redisUrl'), LB_REDIS_PREFIX: prefix, LB_WEB_TOKEN_KEY: site.encodedPublicKey }, 'worker')
  redis = new Redis(inject('redisUrl'), { maxRetriesPerRequest: null })
})

afterAll(async () => {
  await Promise.all(workers?.map(worker => worker.close()) ?? [])
  await running?.close()
  const keys = await redis.keys(`${prefix}*`)
  if (keys.length > 0) await redis.del(...keys)
  redis.disconnect()
  await testDatabase.drop()
})

/** Opens the module the way the entry points do. */
function open(): Promise<RunningModule> {
  return module.open({
    env,
    log: pino({ level: 'silent' }),
    tracer: new Tracer(new RedisSpanWriter(redis, prefix)),
    gateway: undefined,
    visitorVerifier: createVisitorVerifier('lb-08', env.LB_WEB_TOKEN_KEY),
    now: () => new Date(),
  })
}

describe('the module, as the API and the worker open it', () => {
  it('is not ready before its schema exists, and says so on /api/readyz', async () => {
    running = await open()
    const app = await buildApp({ modules: [running], schemaNames: LB08_SCHEMA_NAMES })

    const response = await app.inject({ url: '/api/readyz' })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ lb08: false })
    await app.close()
  })

  it('migrates its own schema once, and again with nothing to do', async () => {
    expect(await module.migrate(env)).toBe(1)
    expect(await module.migrate(env)).toBe(0)
  })

  it('seeds the synthetic stock list, and puts the shelves back as they were when seeded again', async () => {
    expect(await module.seed(env)).toBe('lb08: 6 products in the stock list')
    expect(await module.seed(env)).toBe('lb08: 6 products in the stock list')
  })

  it('is ready once migrated, with Postgres and Redis answering', async () => {
    const app = await buildApp({ modules: [running], schemaNames: LB08_SCHEMA_NAMES })

    const response = await app.inject({ url: '/api/readyz' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ lb08: true })
    await app.close()
  })

  it('runs a workflow that came in over HTTP on its own workers, from a sample to a finished run', async () => {
    workers = await running.startWorkers()
    expect(workers).toHaveLength(2)
    const app = await buildApp({ modules: [running], schemaNames: LB08_SCHEMA_NAMES })
    const session = `session-${randomBytes(8).toString('hex')}`
    const issued = Math.floor(Date.now() / 1000)
    const headers = { authorization: `Bearer ${mintVisitorToken(site.privateKey, { iss: 'lb-web', aud: 'lb-08', sub: session, iat: issued, exp: issued + 300 })}` }
    const sample = loadSamples().find(candidate => candidate.id === 'wholesale-order')

    const made = await app.inject({ method: 'POST', url: '/api/lb08/workflows', headers, payload: { from: 'sample', sampleId: 'wholesale-order' } })
    const started = await app.inject({ method: 'POST', url: `/api/lb08/workflows/${made.json().id}/runs`, headers, payload: { input: sample?.input } })
    const run = await waitFor('the run to finish', async () => {
      const found = (await app.inject({ url: `/api/lb08/runs/${started.json().id}`, headers })).json()
      return found.status === 'succeeded' || found.status === 'failed' ? found : undefined
    })

    expect(made.statusCode).toBe(201)
    expect(started.statusCode).toBe(202)
    expect(run.status).toBe('succeeded')
    const sent = (await app.inject({ url: '/api/lb08/sent', headers })).json()
    expect(sent.map((delivery: { connector: string }) => delivery.connector).sort()).toEqual(['email', 'slack_alert'])
    // What the stock check read is the stock list this module seeded.
    expect(run.steps.find((step: { nodeId: string }) => step.nodeId === 'check_stock').output).toMatchObject({ availableKg: 180 })
    await app.close()
  })

  it('has no way to describe a workflow without a gateway, and says so instead of failing oddly', async () => {
    const app = await buildApp({ modules: [running], schemaNames: LB08_SCHEMA_NAMES })
    const issued = Math.floor(Date.now() / 1000)
    const headers = { authorization: `Bearer ${mintVisitorToken(site.privateKey, { iss: 'lb-web', aud: 'lb-08', sub: `session-${randomBytes(8).toString('hex')}`, iat: issued, exp: issued + 300 })}` }

    const response = await app.inject({ method: 'POST', url: '/api/lb08/workflows', headers, payload: { from: 'description', description: 'When a wholesale order arrives, alert the roastery.' } })

    expect(response.statusCode).toBe(503)
    expect(response.json().error.code).toBe('generation_unavailable')
    await app.close()
  })
})
