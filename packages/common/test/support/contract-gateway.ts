// The real gateway, in this process, on a fake provider: what the contract tests call.
//
// It builds services/gateway's own app (`buildGateway`) with a small routing table, a real
// Redis under a key prefix of its own, and a fresh Ed25519 key for `node-systems`, written
// to a private key file the way `just gateway-token keygen` writes it. So what @lb/common
// signs, sends and reads is checked against the gateway's real checks, not a copy of them.
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Redis } from 'ioredis'

import { buildGateway } from '../../../../services/gateway/src/app.ts'
import { importServiceKeys } from '../../../../services/gateway/src/auth/service-token.ts'
import { loadRouting } from '../../../../services/gateway/src/routing/load.ts'
import { Gateway } from '../../src/gateway.ts'
import { loadServiceKey, ServiceTokens } from '../../src/tokens.ts'
import { FakeProvider } from './fake-provider.ts'

/** A running gateway and everything a test needs to call it and look inside. */
export interface ContractGateway {
  app: Awaited<ReturnType<typeof buildGateway>>
  // The gateway's base URL, such as http://127.0.0.1:43210.
  url: string
  redis: Redis
  // The Redis key prefix the gateway and the tracers under test share.
  prefix: string
  provider: FakeProvider
  // The private key file of the `node-systems` service.
  keyFile: string
  // A client signing as node-systems with that key.
  client: Gateway
  // The spans recorded for a run, oldest first.
  runSpans: (runId: string) => Promise<Record<string, unknown>[]>
  // Reads a run's trace from the gateway's Scope route as `web`, the site's server, would.
  // `query` is the text after the `?`.
  readTrace: (runId: string, query?: string) => Promise<Response>
  close: () => Promise<void>
}

/**
 * Starts the gateway on a fake provider, against the Redis at `redisUrl`. `routingFile` is
 * the routing table to load: this package's own small one by default, or another system's
 * (services/node-systems tests load one with the real alias limits of `lb-tools`).
 */
export async function startContractGateway(redisUrl: string, routingFile: URL = new URL('routing.contract.yaml', import.meta.url)): Promise<ContractGateway> {
  const provider = await FakeProvider.start('alpha answer')

  // The service's key pair. The private half goes to a file only this user can read.
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const keyDirectory = mkdtempSync(join(tmpdir(), 'lb-common-contract-'))
  const keyFile = join(keyDirectory, 'node-systems.jwk.json')
  writeFileSync(keyFile, JSON.stringify({ ...privateKey.export({ format: 'jwk' }), kid: 'node-systems' }), { mode: 0o600 })
  // A second pair for `web`, the site's server: it reads traces and calls no model.
  const web = generateKeyPairSync('ed25519')
  const webTokens = new ServiceTokens('web', web.privateKey)

  const prefix = `lbtest-${randomBytes(6).toString('hex')}:`
  const redis = new Redis(redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 1, lazyConnect: true })
  await redis.connect()
  const routing = loadRouting(readFileSync(routingFile, 'utf8'), { ALPHA_URL: provider.url, ALPHA_KEY: 'alpha-key' })
  const app = await buildGateway({
    routing,
    profile: 'production',
    serviceKeys: await importServiceKeys({ 'node-systems': publicKey.export({ format: 'jwk' }).x ?? '', 'web': web.publicKey.export({ format: 'jwk' }).x ?? '' }),
    redis,
    prefix,
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

  return {
    app,
    url,
    redis,
    prefix,
    provider,
    keyFile,
    client: new Gateway({ url }, new ServiceTokens('node-systems', loadServiceKey(keyFile))),
    runSpans: async (runId) => {
      const entries = await redis.xrange(`${prefix}run:${runId}:spans`, '-', '+')
      return entries.map(([, fields]) => JSON.parse(fields[1] ?? '{}') as Record<string, unknown>)
    },
    readTrace: (runId, query = '') => fetch(`${url}/v1/runs/${runId}/spans${query === '' ? '' : `?${query}`}`, { headers: { authorization: `Bearer ${webTokens.current()}` } }),
    close: async () => {
      const closing = app.close()
      // A client may leave an idle keep-alive socket open; don't wait out its timeout.
      app.server.closeAllConnections()
      await closing
      const keys = await redis.keys(`${prefix}*`)
      if (keys.length > 0) await redis.del(...keys)
      redis.disconnect()
      await provider.close()
      rmSync(keyDirectory, { recursive: true, force: true })
    },
  }
}
