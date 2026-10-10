// The real gateway on fake providers, for the Python client's contract tests
// (python/lb-common/tests/integration/test_gateway_contract.py). Python signs tokens,
// labels calls and reads answers; this proves the gateway agrees, request by request.
//
//   LB_TEST_REDIS_URL=redis://127.0.0.1:6379 node test/support/contract-server.ts
//
// It prints one JSON line (the gateway's URL, the control URL, the private key file of
// the `django-systems` service and the Redis key prefix), then serves until its stdin
// closes or it gets SIGTERM. The control server listens on loopback only:
//
//   POST /script    {"provider": "alpha", "scripts": [...]}   queue answers (fake-provider.ts)
//   POST /reset                                               forget every script and request
//   GET  /requests?provider=alpha                             what that provider received
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Redis } from 'ioredis'
import { exportJWK, generateKeyPair } from 'jose'

import { buildGateway } from '../../src/app.ts'
import { importServiceKeys } from '../../src/auth/service-token.ts'
import { loadRouting } from '../../src/routing/load.ts'
import { answer, FakeProvider } from './fake-provider.ts'
import type { Script } from './fake-provider.ts'

const redisUrl = process.env.LB_TEST_REDIS_URL
if (!redisUrl) {
  console.error('Set LB_TEST_REDIS_URL to a running Redis.')
  process.exit(1)
}

// 1. Four fake providers, as in the gateway's own integration tests.
const providers: Record<string, FakeProvider> = {
  alpha: await FakeProvider.start(answer('alpha answer')),
  beta: await FakeProvider.start(answer('beta answer')),
  gamma: await FakeProvider.start(answer('gamma answer')),
  delta: await FakeProvider.start(answer('delta answer')),
}

// 2. A fresh key for django-systems. The private half goes to a file only this user can
//    read, as `just gateway-token keygen` writes it; the gateway gets the public half.
const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true })
const keyDir = mkdtempSync(join(tmpdir(), 'lb-contract-'))
const keyFile = join(keyDir, 'django-systems.jwk.json')
writeFileSync(keyFile, JSON.stringify({ ...(await exportJWK(privateKey)), kid: 'django-systems' }), { mode: 0o600 })

// 3. The real gateway, on the test routing table and a key prefix of its own.
const env = {
  ALPHA_URL: providers.alpha?.url, ALPHA_KEY: 'alpha-key',
  BETA_URL: providers.beta?.url, BETA_RUN_URL: providers.beta?.url.replace(/\/v1$/, '/ai/run'), BETA_KEY: 'beta-key',
  GAMMA_URL: providers.gamma?.url, GAMMA_KEY: 'gamma-key',
  DELTA_URL: providers.delta?.url, DELTA_KEY: 'delta-key',
}
const prefix = `lbtest-${randomBytes(6).toString('hex')}:`
const redis = new Redis(redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 1, lazyConnect: true })
await redis.connect()
const app = await buildGateway({
  routing: loadRouting(readFileSync(new URL('../fixtures/routing.test.yaml', import.meta.url), 'utf8'), env),
  profile: 'production',
  serviceKeys: await importServiceKeys({ 'django-systems': (await exportJWK(publicKey)).x ?? '' }),
  redis,
  prefix,
})
await app.listen({ host: '127.0.0.1', port: 0 })

/** Sends a JSON answer from the control server. */
function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

/** Reads a control request's body as JSON, or undefined when it isn't JSON. */
async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  }
  catch {
    return undefined
  }
}

/** Answers one control request: script a provider, reset them all, or list what one received. */
async function control(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://control')
  if (request.method === 'POST' && url.pathname === '/script') {
    const body = await readJson(request) as { provider?: string, scripts?: Script[] } | undefined
    const provider = providers[body?.provider ?? '']
    if (!provider || !Array.isArray(body?.scripts)) return send(response, 400, { error: 'Name a provider and give a list of scripts.' })
    provider.enqueue(...body.scripts)
    return send(response, 200, { queued: body.scripts.length })
  }
  if (request.method === 'POST' && url.pathname === '/reset') {
    for (const provider of Object.values(providers)) provider.reset()
    return send(response, 200, { reset: true })
  }
  if (request.method === 'GET' && url.pathname === '/requests') {
    const provider = providers[url.searchParams.get('provider') ?? '']
    if (!provider) return send(response, 400, { error: 'Name a provider.' })
    return send(response, 200, provider.requests.map(({ path, headers, body, form }) => ({ path, authorization: headers.authorization, body, form })))
  }
  return send(response, 404, { error: 'Unknown control request.' })
}

// 4. The control server, on loopback only.
const controlServer = createServer((request, response) => {
  void control(request, response)
})
await new Promise<void>(resolve => controlServer.listen(0, '127.0.0.1', resolve))

// 5. Tell the test where everything is.
const gatewayPort = (app.server.address() as AddressInfo).port
const controlPort = (controlServer.address() as AddressInfo).port
console.log(JSON.stringify({ url: `http://127.0.0.1:${gatewayPort}`, control: `http://127.0.0.1:${controlPort}`, keyFile, prefix }))

/** Stops everything, removes the test's Redis keys and deletes the key file, then exits. */
async function shutDown(): Promise<void> {
  const closing = app.close()
  app.server.closeAllConnections()
  await closing
  controlServer.closeAllConnections()
  controlServer.close()
  await Promise.all(Object.values(providers).map(provider => provider.close()))
  const keys = await redis.keys(`${prefix}*`)
  if (keys.length > 0) await redis.del(...keys)
  redis.disconnect()
  rmSync(keyDir, { recursive: true, force: true })
  process.exit(0)
}

// The test process holds stdin open while it needs the gateway; when it closes, stop.
process.stdin.on('end', () => void shutDown())
process.stdin.resume()
process.once('SIGTERM', () => void shutDown())
