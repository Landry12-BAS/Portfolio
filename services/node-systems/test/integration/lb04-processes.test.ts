// LB-04 in the real processes, as an operator starts them: the API and the worker as two long-running
// processes started from their entry points and environment variables alone, with the real gateway
// (on a fake provider) behind both. A contract that comes in over HTTP is left queued while no worker
// runs, picked up by the worker, opened in its thread, reviewed through the gateway, and ended; and
// both processes stop cleanly on SIGTERM. A mistake in the entry points' wiring (a missing setting, a
// connection that never closes, a signal that is ignored) is found here and nowhere else.
import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'

import { makeSiteKeys, mintVisitorToken } from '@lb/common/testing'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import type { ContractGateway } from '../../../../packages/common/test/support/contract-gateway.ts'
import { createLb04TestDatabase } from '../support/lb04-database.ts'
import type { Lb04TestDatabase } from '../support/lb04-database.ts'
import { scriptReview, startLb04Gateway } from '../support/lb04-gateway.ts'
import { waitFor } from '../support/wait.ts'

/** Returns the path of a file under the service's src folder. */
function source(name: string): string {
  return fileURLToPath(new URL(`../../src/${name}`, import.meta.url))
}
const site = makeSiteKeys()

let gw: ContractGateway
let database: Lb04TestDatabase
let port: number
let environment: Record<string, string>
const running: ChildProcess[] = []

/** Finds a port nothing is listening on. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

beforeAll(async () => {
  gw = await startLb04Gateway(inject('redisUrl'))
  database = await createLb04TestDatabase(inject('databaseUrl'))
  port = await freePort()
  environment = {
    PATH: process.env.PATH ?? '',
    NODE_NO_WARNINGS: '1',
    LB_DATABASE_URL: database.url,
    LB_REDIS_URL: inject('redisUrl'),
    // The gateway's own prefix, as in production, where the gateway and the services share one: the service writes the spans the gateway reads.
    LB_REDIS_PREFIX: gw.prefix,
    LB_WEB_TOKEN_KEY: site.encodedPublicKey,
    LB_GATEWAY_URL: gw.url,
    LB_SERVICE_NAME: 'node-systems',
    LB_SERVICE_KEY_FILE: gw.keyFile,
    LB_NODE_HOST: '127.0.0.1',
    LB_NODE_PORT: String(port),
    LB_NODE_LOG_LEVEL: 'warn',
  }
})

afterAll(async () => {
  for (const child of running) child.kill('SIGKILL')
  await gw.close()
  await database.drop()
})

/** What a finished command left behind. */
interface Finished {
  code: number
  stdout: string
  stderr: string
}

/** Runs one of the service's entry points to the end, with the environment given. */
function command(name: string, env: Record<string, string>): Promise<Finished> {
  return new Promise((resolve) => {
    execFile(process.execPath, [source(name)], { env, timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr })
    })
  })
}

/** A long-running process, with what it has printed so far and a way to see how it ended. */
interface Started {
  child: ChildProcess
  output: () => string
  exited: Promise<{ code: number | null, signal: NodeJS.Signals | null }>
}

/** Starts one of the service's processes. */
function start(name: string): Started {
  const child = spawn(process.execPath, [source(name)], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
  running.push(child)
  let printed = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    printed += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    printed += chunk.toString('utf8')
  })
  const exited = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  return { child, output: () => printed, exited }
}

/** What an API answer holds: its status, and its JSON body, which these tests read field by field. */
interface Answer {
  status: number
  // These tests read the API's JSON field by field, as the site would; its shapes are checked by lb04-api.test.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: { [field: string]: any }
}

/** Calls the API process over HTTP as a visitor. */
async function call(method: string, path: string, session: string, body?: unknown): Promise<Answer> {
  const issued = Math.floor(Date.now() / 1000)
  const token = mintVisitorToken(site.privateKey, { iss: 'lb-web', aud: 'lb-04', sub: session, iat: issued, exp: issued + 300 })
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, json: await response.json() as Answer['json'] }
}

describe('starting', () => {
  it('migrates and seeds as commands, and the migration is applied once', async () => {
    const migrated = await command('cli/migrate.ts', environment)
    const again = await command('cli/migrate.ts', environment)
    const seeded = await command('cli/seed.ts', environment)

    expect(migrated).toMatchObject({ code: 0, stdout: 'lb08: 1 migration applied\nlb04: 1 migration applied\n' })
    expect(again.stdout).toBe('lb08: 0 migrations applied\nlb04: 0 migrations applied\n')
    expect(seeded.code).toBe(0)
    expect(seeded.stdout).toContain('lb04: the playbook')
  })

  it('refuses to start the worker without the gateway, which it needs to review contracts, naming the variable and not echoing any value', async () => {
    const { LB_GATEWAY_URL: _url, LB_SERVICE_KEY_FILE: _key, ...withoutGateway } = environment

    const finished = await command('worker.ts', withoutGateway)

    expect(finished.code).not.toBe(0)
    expect(finished.stderr).toContain('LB_GATEWAY_URL: required to start the worker')
    expect(finished.stderr).toContain('LB_SERVICE_KEY_FILE: required to start the worker')
    expect(finished.stderr).not.toContain(environment.LB_REDIS_URL)
  })
})

describe('the API and the worker, as two processes', () => {
  let api: Started
  let worker: Started
  const session = `session-${randomBytes(8).toString('hex')}`
  let contractId = ''

  it('starts the API, which says it is alive and ready once the schema exists, and serves what needs no model', async () => {
    api = start('main.ts')

    const ready = await waitFor('the API to be ready', async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/readyz`).catch(() => undefined)
      return response?.status === 200 ? await response.json() : undefined
    })

    expect(ready).toEqual({ lb08: true, lb04: true })
    expect((await fetch(`http://127.0.0.1:${port}/api/lb04/limits`)).status).toBe(401)
    expect((await call('GET', '/api/lb04/samples', session)).json).toHaveLength(6)
  })

  it('queues a contract the API accepts, and leaves it queued while no worker runs', async () => {
    const made = await call('POST', '/api/lb04/contracts', session, { from: 'sample', sampleId: 'wholesale-supply' })

    expect(made.status).toBe(201)
    contractId = made.json.id as string
    await new Promise(resolve => setTimeout(resolve, 800))
    expect((await call('GET', `/api/lb04/contracts/${contractId}`, session)).json.state).toBe('queued')
    expect((await call('GET', `/api/lb04/contracts/${contractId}/report`, session)).status).toBe(409)
  })

  it('starts the worker, which picks up the queued contract, opens it in its thread, reviews it through the gateway and ends it', async () => {
    await scriptReview(gw, 'wholesale-supply')
    worker = start('worker.ts')

    const view = await waitFor('the worker to finish the review', async () => {
      const found = await call('GET', `/api/lb04/contracts/${contractId}`, session)
      return found.json.state === 'done' || found.json.state === 'failed' ? found.json : undefined
    })

    expect(view).toMatchObject({ state: 'done', pages: 11 })
    const report = await call('GET', `/api/lb04/contracts/${contractId}/report`, session)
    expect(report.status).toBe(200)
    expect(report.json.calls).toBe(3)
    expect(report.json.findings.length).toBeGreaterThan(3)
    expect((await call('GET', '/api/lb04/limits', session)).json.contracts).toEqual({ limit: 3, used: 1, remaining: 2 })
  })

  it('wrote the review\'s trace to the gateway\'s streams, root last, and the site\'s server can read it as finished', async () => {
    const trace = await waitFor('the worker to write the review\'s root span', async () => {
      const page = await (await gw.readTrace(contractId)).json() as { finished?: boolean, spans: { kind: string, name: string, spanId: string, parentId?: string }[] }
      return page.finished ? page : undefined
    })

    const root = trace.spans.at(-1)
    expect(root).toMatchObject({ kind: 'system.run', name: 'contract review' })
    expect(trace.spans.filter(span => span.kind === 'system.step').every(span => span.parentId === root?.spanId)).toBe(true)
    expect(trace.spans.filter(span => span.kind === 'gateway.call').map(span => span.name)).toEqual(['lb-guard', 'lb-long', 'lb-reason'])
  })

  it('makes a redline through the API process and the real gateway: one call, shown in the report', async () => {
    const report = await call('GET', `/api/lb04/contracts/${contractId}/report`, session)
    const finding = report.json.findings[0]
    gw.provider.answerNext(JSON.stringify({ replacement: 'The parties agree wording that meets the playbook.' }))

    const redline = await call('POST', `/api/lb04/contracts/${contractId}/findings/${finding.id}/redline`, session)

    expect(redline.status).toBe(201)
    expect(redline.json).toMatchObject({ findingId: finding.id, source: 'model', notLegalAdvice: 'Not legal advice' })
    expect((await call('GET', `/api/lb04/contracts/${contractId}/report`, session)).json.redlines).toHaveLength(1)
  })

  it('stops both processes cleanly on SIGTERM', async () => {
    api.child.kill('SIGTERM')
    worker.child.kill('SIGTERM')

    const [apiEnd, workerEnd] = await Promise.all([api.exited, worker.exited])

    expect(apiEnd).toEqual({ code: 0, signal: null })
    expect(workerEnd).toEqual({ code: 0, signal: null })
    expect(api.output()).not.toMatch(/error/i)
    expect(worker.output()).not.toMatch(/error/i)
  })
})
