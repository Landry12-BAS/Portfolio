// LB-06's HTTP API under test: the real app with the real routes and the real socket route, behind a
// real visitor token check, on the engine harness. HTTP requests go in through Fastify's `inject`;
// the socket tests listen on a port.
import { createVisitorVerifier } from '@lb/common'
import { makeSiteKeys, mintVisitorToken } from '@lb/common/testing'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { Redis } from 'ioredis'

import { buildApp } from '../../src/core/app.ts'
import type { RunningModule } from '../../src/core/module.ts'
import { registerSocket } from '../../src/modules/lb06/engine/socket.ts'
import { LB06_SCHEMA_NAMES, registerLb06Routes } from '../../src/modules/lb06/routes/index.ts'
import { createLb06Harness } from './lb06-engine.ts'
import type { HarnessOptions, Lb06Harness } from './lb06-engine.ts'

/** The engine harness, plus an app serving LB-06's routes and a way to call them as a visitor. */
export interface Lb06ApiHarness {
  engine: Lb06Harness
  app: FastifyInstance
  call: (method: 'GET' | 'POST', url: string, session: string | undefined, payload?: unknown) => Promise<LightMyRequestResponse>
  tokenFor: (session: string, audience?: string, lifetimeSeconds?: number) => string
  close: () => Promise<void>
}

/** Builds the API on a database of its own. With `redis`, the socket route is registered over the real feed under the given prefix. */
export async function createLb06ApiHarness(serverUrl: string, options: HarnessOptions & { redisUrl?: string, redisPrefix?: string } = {}): Promise<Lb06ApiHarness> {
  const engine = await createLb06Harness(serverUrl, options)
  const site = makeSiteKeys()
  const verifier = createVisitorVerifier('lb-06', site.encodedPublicKey)
  let socket: ReturnType<typeof registerSocket> | undefined
  const module: RunningModule = {
    part: 'lb-06',
    apiPrefix: '/api/lb06',
    registerRoutes: scope => registerLb06Routes(scope, { deps: engine.deps }, verifier),
    registerRootRoutes: (app) => {
      if (options.redisUrl === undefined) return
      socket = registerSocket(app, { deps: engine.deps, verify: verifier, openRedis: () => new Redis(options.redisUrl as string, { maxRetriesPerRequest: null }), redisPrefix: options.redisPrefix ?? 'lbtest:', config: engine.deps.config })
    },
    startWorkers: async () => [],
    isReady: async () => true,
    close: async () => {},
  }
  const app = await buildApp({ modules: [module], schemaNames: LB06_SCHEMA_NAMES })
  const tokenFor = (session: string, audience = 'lb-06', lifetimeSeconds = 300): string => {
    const issued = Math.floor(Date.now() / 1000)
    return mintVisitorToken(site.privateKey, { iss: 'lb-web', aud: audience, sub: session, iat: issued, exp: issued + lifetimeSeconds })
  }
  return {
    engine,
    app,
    tokenFor,
    call: (method, url, session, payload) => app.inject({
      method,
      url: `/api/lb06${url}`,
      headers: session === undefined ? {} : { authorization: `Bearer ${tokenFor(session)}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    }),
    close: async () => {
      socket?.close()
      await app.close()
      await engine.close()
    },
  }
}
