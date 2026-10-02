// The real processes, as an operator starts them: `migrate` and `seed` as commands, then
// the API and the worker as two long-running processes, with the real gateway (on a fake
// provider) behind the API. Everything the other tests assemble in memory is assembled here
// by the entry points themselves, from environment variables alone, so a mistake in their
// wiring (a missing setting, a connection that never closes, a signal that is ignored) is
// found here and nowhere else.
import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'

import { makeSiteKeys, mintVisitorToken } from '@lb/common/testing'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { startContractGateway } from '../../../../packages/common/test/support/contract-gateway.ts'
import type { ContractGateway } from '../../../../packages/common/test/support/contract-gateway.ts'
import { completion } from '../../../../packages/common/test/support/fake-provider.ts'
import { createTestDatabase } from '../support/database.ts'
import type { TestDatabase } from '../support/database.ts'
import { loadSamples } from '../support/data.ts'
import { waitFor } from '../support/wait.ts'

/** Returns the path of a file under the service's src folder. */
function source(name: string): string {
  return fileURLToPath(new URL(`../../src/${name}`, import.meta.url))
}
const site = makeSiteKeys()

let gw: ContractGateway
let database: TestDatabase
let port: number
let environment: Record<string, string>
const running: ChildProcess[] = []

/** Finds a port nothing is listening on, above the ports other engineers' services use. */
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
  gw = await startContractGateway(inject('redisUrl'), new URL('../support/routing.lb08.yaml', import.meta.url))
  database = await createTestDatabase(inject('databaseUrl'))
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

/** Runs one of the service's commands to the end. */
function command(name: string, overrides: Record<string, string> = {}, drop: string[] = []): Promise<Finished> {
  const env = Object.fromEntries(Object.entries({ ...environment, ...overrides }).filter(([key]) => !drop.includes(key)))
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
  // These tests read the API's JSON field by field, as the site would; its shapes are checked by api.test.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: { [field: string]: any }
}

/** Calls the API process over HTTP as a visitor. */
async function call(method: string, path: string, session: string, body?: unknown): Promise<Answer> {
  const issued = Math.floor(Date.now() / 1000)
  const token = mintVisitorToken(site.privateKey, { iss: 'lb-web', aud: 'lb-08', sub: session, iat: issued, exp: issued + 300 })
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, json: await response.json() as Answer['json'] }
}

describe('the commands', () => {
  it('migrate creates the schema once and has nothing to do the second time', async () => {
    const first = await command('cli/migrate.ts')
    const second = await command('cli/migrate.ts')

    expect(first).toMatchObject({ code: 0, stdout: 'lb08: 1 migration applied\n' })
    expect(second).toMatchObject({ code: 0, stdout: 'lb08: 0 migrations applied\n' })
  })

  it('seed loads the stock list, and loads the same list again', async () => {
    const first = await command('cli/seed.ts')
    const second = await command('cli/seed.ts')

    expect(first).toMatchObject({ code: 0, stdout: 'lb08: 6 products in the stock list\n' })
    expect(second.stdout).toBe(first.stdout)
  })

  it('refuse to start without a database, naming the variable and not echoing any value', async () => {
    const finished = await command('cli/migrate.ts', {}, ['LB_DATABASE_URL'])

    expect(finished.code).not.toBe(0)
    expect(finished.stderr).toContain('LB_DATABASE_URL')
    expect(finished.stderr).not.toContain(environment.LB_REDIS_URL)
  })

  it('check agrees with the committed OpenAPI document and the committed migrations', async () => {
    const finished = await command('cli/check.ts')

    expect(finished.code).toBe(0)
    expect(finished.stdout).toContain('openapi.json is up to date')
  })
})

describe('the API and the worker, as two processes', () => {
  let api: Started
  let worker: Started
  const session = `session-${randomBytes(8).toString('hex')}`

  it('refuses to start the API without the gateway, which it needs to describe workflows', async () => {
    const { LB_GATEWAY_URL: _url, LB_SERVICE_KEY_FILE: _key, ...withoutGateway } = environment
    const finished = await new Promise<Finished>((resolve) => {
      execFile(process.execPath, [source('main.ts')], { env: withoutGateway, timeout: 30_000 }, (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr })
      })
    })

    expect(finished.code).not.toBe(0)
    expect(finished.stderr).toContain('LB_GATEWAY_URL: required to start the API')
  })

  it('starts the API, which says it is alive and ready once the schema exists', async () => {
    api = start('main.ts')

    const ready = await waitFor('the API to be ready', async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/readyz`).catch(() => undefined)
      return response?.status === 200 ? await response.json() : undefined
    })

    expect(ready).toEqual({ lb08: true })
    expect((await fetch(`http://127.0.0.1:${port}/api/healthz`)).status).toBe(200)
    expect((await fetch(`http://127.0.0.1:${port}/api/lb08/limits`)).status).toBe(401)
  })

  it('queues a run the API accepts, and leaves it queued while no worker runs', async () => {
    const made = await call('POST', '/api/lb08/workflows', session, { from: 'sample', sampleId: 'low-stock-reorder' })
    const sample = loadSamples().find(candidate => candidate.id === 'low-stock-reorder')
    const started = await call('POST', `/api/lb08/workflows/${made.json.id}/runs`, session, { input: sample?.input })

    expect(made.status).toBe(201)
    expect(started.status).toBe(202)
    await new Promise(resolve => setTimeout(resolve, 800))
    expect((await call('GET', `/api/lb08/runs/${started.json.id}`, session)).json.status).toBe('queued')
  })

  it('starts the worker, which picks up the queued run and finishes it', async () => {
    worker = start('worker.ts')

    const runs = await call('GET', '/api/lb08/runs', session)
    const run = await waitFor('the worker to finish the run', async () => {
      const found = await call('GET', `/api/lb08/runs/${runs.json[0].id}`, session)
      return found.json.status === 'succeeded' ? found.json : undefined
    })

    expect(run.steps.map((step: { status: string }) => step.status)).toEqual(['succeeded', 'succeeded', 'succeeded'])
    expect((await call('GET', '/api/lb08/sent', session)).json).toHaveLength(2)

    // The worker wrote the run's trace to the gateway's streams, root last, and the site's server can read it as finished.
    const trace = await waitFor('the worker to write the run\'s root span', async () => {
      const page = await (await gw.readTrace(run.id)).json() as { finished?: boolean, spans: { kind: string, name: string, spanId: string, parentId?: string }[] }
      return page.finished ? page : undefined
    })
    const root = trace.spans.at(-1)
    expect(root).toMatchObject({ kind: 'system.run', name: 'workflow run' })
    expect(trace.spans.filter(span => span.kind === 'system.step').map(span => span.parentId)).toEqual([root?.spanId, root?.spanId])
  })

  it('describes a workflow through the real gateway, from an HTTP request to the fake provider and back', async () => {
    const sample = loadSamples().find(candidate => candidate.id === 'wholesale-order')
    gw.provider.enqueue({ body: completion(JSON.stringify(sample?.graph)) })

    const response = await call('POST', '/api/lb08/workflows', session, { from: 'description', description: sample?.description })

    expect(response.status).toBe(201)
    expect(response.json.versions[0]).toMatchObject({ origin: 'generated', modelCalls: 1 })
    expect(response.json.graph.name).toBe('Wholesale order over €500')
    const sent = gw.provider.requests.at(-1)?.body as { messages: { role: string }[] }
    expect(sent.messages.map(message => message.role)).toEqual(['system', 'user'])
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
