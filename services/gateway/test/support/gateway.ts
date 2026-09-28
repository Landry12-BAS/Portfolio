import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

import type { FastifyInstance } from 'fastify'
import { Redis } from 'ioredis'
import { exportJWK, generateKeyPair } from 'jose'
import type { CryptoKey } from 'jose'
import { inject } from 'vitest'

import { buildGateway } from '../../src/app.ts'
import { importServiceKeys, signServiceToken } from '../../src/auth/service-token.ts'
import type { Span } from '../../src/spans.ts'
import { loadRouting } from '../../src/routing/load.ts'
import type { Profile } from '../../src/routing/plan.ts'
import { answer, FakeProvider } from './fake-provider.ts'

const fixture = readFileSync(new URL('../fixtures/routing.test.yaml', import.meta.url), 'utf8')

export interface TestGateway {
  app: FastifyInstance
  redis: Redis
  prefix: string
  providers: Record<'alpha' | 'beta' | 'gamma' | 'delta', FakeProvider>
  // Moves the gateway's clock; timers still run in real time.
  advance: (ms: number) => void
  now: () => number
  token: (service?: string) => Promise<string>
  headers: (overrides?: Record<string, string | undefined>) => Promise<Record<string, string>>
  runSpans: (runId: string) => Promise<Span[]>
  close: () => Promise<void>
}

export async function startGateway(options: { profile?: Profile, redisUrl?: string } = {}): Promise<TestGateway> {
  const providers = {
    alpha: await FakeProvider.start(answer('alpha answer')),
    beta: await FakeProvider.start(answer('beta answer')),
    gamma: await FakeProvider.start(answer('gamma answer')),
    delta: await FakeProvider.start(answer('delta answer')),
  }
  const env = {
    ALPHA_URL: providers.alpha.url, ALPHA_KEY: 'alpha-key',
    BETA_URL: providers.beta.url, BETA_KEY: 'beta-key',
    GAMMA_URL: providers.gamma.url, GAMMA_KEY: 'gamma-key',
    DELTA_URL: providers.delta.url, DELTA_KEY: 'delta-key',
  }

  const services = ['django-systems', 'flask-systems']
  const privateKeys = new Map<string, CryptoKey>()
  const publicKeys: Record<string, string> = {}
  for (const service of services) {
    const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519' })
    privateKeys.set(service, pair.privateKey)
    publicKeys[service] = (await exportJWK(pair.publicKey)).x ?? ''
  }

  let offset = 0
  const now = () => Date.now() + offset
  const prefix = `lbtest-${randomBytes(6).toString('hex')}:`
  const redis = new Redis(options.redisUrl ?? inject('redisUrl'), { enableOfflineQueue: false, maxRetriesPerRequest: 1, lazyConnect: true })
  await redis.connect().catch(() => undefined)

  const app = await buildGateway({
    routing: loadRouting(fixture, env),
    profile: options.profile ?? 'production',
    serviceKeys: await importServiceKeys(publicKeys),
    redis,
    prefix,
    now,
  })

  const token = async (service = 'django-systems') => {
    const key = privateKeys.get(service)
    if (!key) throw new Error(`no key for ${service}`)
    return signServiceToken(service, key, new Date(now()))
  }

  return {
    app,
    redis,
    prefix,
    providers,
    now,
    advance: (ms) => {
      offset += ms
    },
    token,
    headers: async (overrides = {}) => {
      const headers: Record<string, string | undefined> = {
        'authorization': `Bearer ${await token()}`,
        'x-lb-system': 'lb-01',
        'x-lb-run-id': `run-${randomBytes(6).toString('hex')}`,
        'x-lb-session': 'session-0123456789abcdef',
        ...overrides,
      }
      return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== undefined))
    },
    runSpans: async (runId) => {
      const entries = await redis.xrange(`${prefix}run:${runId}:spans`, '-', '+')
      return entries.map(([, fields]) => JSON.parse(fields[1] ?? '{}') as Span)
    },
    close: async () => {
      const closing = app.close()
      // A client may leave an idle keep-alive socket open; don't wait out its timeout.
      app.server.closeAllConnections()
      await closing
      if (redis.status === 'ready') {
        const keys = await redis.keys(`${prefix}*`)
        if (keys.length > 0) await redis.del(...keys)
      }
      redis.disconnect()
      await Promise.all(Object.values(providers).map(provider => provider.close()))
    },
  }
}

export function chatBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'lb-fast',
    messages: [
      { role: 'system', content: 'Classify the ticket.' },
      { role: 'user', content: 'My bag of Basalt Blend arrived torn.' },
    ],
    ...overrides,
  }
}

/** The data payloads of an SSE response body. */
export function sseEvents(body: string): string[] {
  return body.split('\n\n').filter(Boolean).map(block => block.replace(/^data: /, ''))
}
