// Tests that LB-04's module assembles: opened the way the API and the worker open it, from the settings
// the environment gives, with its migrate and seed commands, its readiness check, its routes behind the
// real token check, and its workers reviewing a contract that came in over HTTP through the real
// gateway on a fake provider. Everything is real here (Postgres, Redis, BullMQ, the gateway, the PDF
// extraction) except the provider's answers, which the test scripts.
import { randomBytes } from 'node:crypto'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createVisitorVerifier, RedisSpanWriter, Tracer } from '@lb/common'
import { makeSiteKeys, mintVisitorToken } from '@lb/common/testing'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import type { ContractGateway } from '../../../../packages/common/test/support/contract-gateway.ts'
import { seedDirectory } from '../../src/core/data-files.ts'
import { buildApp } from '../../src/core/app.ts'
import { loadEnv } from '../../src/core/env.ts'
import type { Env } from '../../src/core/env.ts'
import type { RunningModule, WorkerHandle } from '../../src/core/module.ts'
import { createLb04Module } from '../../src/modules/lb04/index.ts'
import { LB04_SCHEMA_NAMES } from '../../src/modules/lb04/routes/index.ts'
import { LB04_TEST_CONFIG } from '../support/lb04-engine.ts'
import { createLb04TestDatabase } from '../support/lb04-database.ts'
import type { Lb04TestDatabase } from '../support/lb04-database.ts'
import { scriptReview, startLb04Gateway } from '../support/lb04-gateway.ts'
import { waitFor } from '../support/wait.ts'

const module = createLb04Module(LB04_TEST_CONFIG)
const site = makeSiteKeys()

let gw: ContractGateway
let testDatabase: Lb04TestDatabase
let env: Env
let running: RunningModule
let workers: readonly WorkerHandle[]

beforeAll(async () => {
  gw = await startLb04Gateway(inject('redisUrl'))
  testDatabase = await createLb04TestDatabase(inject('databaseUrl'))
  // The settings, as the process environment would give them: validated by the same schema the real entry points use.
  env = loadEnv({
    LB_DATABASE_URL: testDatabase.url,
    LB_REDIS_URL: inject('redisUrl'),
    LB_REDIS_PREFIX: gw.prefix,
    LB_WEB_TOKEN_KEY: site.encodedPublicKey,
    LB_GATEWAY_URL: gw.url,
    LB_SERVICE_KEY_FILE: gw.keyFile,
  }, 'worker')
})

afterAll(async () => {
  await Promise.all(workers?.map(worker => worker.close()) ?? [])
  await running?.close()
  await gw.close()
  await testDatabase.drop()
})

/** Opens the module the way the entry points do, with or without the gateway. */
function open(withGateway = true): Promise<RunningModule> {
  return module.open({
    env,
    log: pino({ level: 'silent' }),
    tracer: new Tracer(new RedisSpanWriter(gw.redis, gw.prefix)),
    gateway: withGateway ? gw.client : undefined,
    visitorVerifier: createVisitorVerifier('lb-04', env.LB_WEB_TOKEN_KEY),
    now: () => new Date(),
  })
}

/** The headers of a request from a visitor with this session. */
function asVisitor(session: string): { authorization: string } {
  const issued = Math.floor(Date.now() / 1000)
  return { authorization: `Bearer ${mintVisitorToken(site.privateKey, { iss: 'lb-web', aud: 'lb-04', sub: session, iat: issued, exp: issued + 300 })}` }
}

describe('the module, as the API and the worker open it', () => {
  it('is not ready before its schema exists, and says so on /api/readyz', async () => {
    running = await open()
    const app = await buildApp({ modules: [running], schemaNames: LB04_SCHEMA_NAMES })

    const response = await app.inject({ url: '/api/readyz' })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ lb04: false })
    await app.close()
  })

  it('migrates its own schema once, and again with nothing to do', async () => {
    expect(await module.migrate(env)).toBe(1)
    expect(await module.migrate(env)).toBe(0)
  })

  it('checks its playbook and its sample contracts when seeded, and says what it found', async () => {
    const first = await module.seed(env)

    expect(first).toMatch(/^lb04: the playbook \(version \d+, 21 rules\) and 6 sample contracts, checked$/)
    expect(await module.seed(env)).toBe(first)
  })

  it('refuses to seed from a folder whose sample contract is not the file its list describes, so a damaged deploy fails there and not at a visitor\'s first review', async () => {
    const copy = mkdtempSync(join(tmpdir(), 'lb04-seed-'))
    try {
      cpSync(`${seedDirectory()}/lb04`, `${copy}/lb04`, { recursive: true })
      writeFileSync(`${copy}/lb04/contracts/wholesale-supply.pdf`, Buffer.from('%PDF-1.7 swapped for something else'))
      const damaged = loadEnv({ ...process.env, LB_DATABASE_URL: testDatabase.url, LB_REDIS_URL: inject('redisUrl'), LB_WEB_TOKEN_KEY: site.encodedPublicKey, LB_GATEWAY_URL: gw.url, LB_SERVICE_KEY_FILE: gw.keyFile, LB_SEED_DIR: copy }, 'worker')

      await expect(module.seed(damaged)).rejects.toThrow('The sample contract wholesale-supply is not the file the list describes.')
    }
    finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })

  it('is ready once migrated, with Postgres and Redis answering', async () => {
    const app = await buildApp({ modules: [running], schemaNames: LB04_SCHEMA_NAMES })

    const response = await app.inject({ url: '/api/readyz' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ lb04: true })
    await app.close()
  })

  it('reviews a contract that came in over HTTP on its own workers, through the real gateway, from a sample to a finished report', async () => {
    workers = await running.startWorkers()
    expect(workers).toHaveLength(2)
    await scriptReview(gw, 'wholesale-supply')
    const app = await buildApp({ modules: [running], schemaNames: LB04_SCHEMA_NAMES })
    const headers = asVisitor(`session-${randomBytes(8).toString('hex')}`)

    const made = await app.inject({ method: 'POST', url: '/api/lb04/contracts', headers, payload: { from: 'sample', sampleId: 'wholesale-supply' } })
    const view = await waitFor('the review to finish', async () => {
      const found = (await app.inject({ url: `/api/lb04/contracts/${made.json().id}`, headers })).json()
      return found.state === 'done' || found.state === 'failed' ? found : undefined
    })

    expect(made.statusCode).toBe(201)
    expect(view).toMatchObject({ state: 'done', pages: 11 })
    const report = (await app.inject({ url: `/api/lb04/contracts/${made.json().id}/report`, headers })).json()
    expect(report.calls).toBe(3)
    expect(report.findings.length).toBeGreaterThan(3)
    expect(report.findings.every((finding: { kind: string, quote?: string }) => finding.kind === 'absent' || (finding.quote ?? '').length > 0)).toBe(true)
    await app.close()
  })

  it('writes the review\'s trace to the gateway\'s streams, root last, which the site\'s server reads as finished', async () => {
    const app = await buildApp({ modules: [running], schemaNames: LB04_SCHEMA_NAMES })
    const headers = asVisitor(`session-${randomBytes(8).toString('hex')}`)
    const listed = (await app.inject({ url: '/api/lb04/contracts', headers })).json()
    expect(listed).toEqual([])
    await app.close()
    const keys = await gw.redis.keys(`${gw.prefix}run:*:spans`)

    expect(keys.length).toBeGreaterThan(0)
    const runId = keys[0]?.slice(`${gw.prefix}run:`.length, -':spans'.length) ?? ''
    const trace = (await (await gw.readTrace(runId)).json()) as { finished: boolean, spans: { name: string }[] }
    expect(trace.finished).toBe(true)
    expect(trace.spans.at(-1)?.name).toBe('contract review')
  })
})

describe('a module opened with no gateway', () => {
  it('serves what needs no model (the limits, the samples, the playbook) and refuses to review, saying why instead of failing oddly', async () => {
    const quiet = await open(false)
    const app = await buildApp({ modules: [quiet], schemaNames: LB04_SCHEMA_NAMES })
    const headers = asVisitor(`session-${randomBytes(8).toString('hex')}`)

    expect((await app.inject({ url: '/api/lb04/limits', headers })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/lb04/samples', headers })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/lb04/playbook', headers })).statusCode).toBe(200)
    const refused = await app.inject({ method: 'POST', url: '/api/lb04/contracts', headers, payload: { from: 'sample', sampleId: 'wholesale-supply' } })
    expect(refused.statusCode).toBe(503)
    expect(refused.json().error.code).toBe('analysis_unavailable')
    await app.close()
    await quiet.close()
  })
})
