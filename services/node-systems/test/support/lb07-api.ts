// LB-07's HTTP API under test: the real app with the real routes, behind a real visitor token check, on
// the engine harness. Requests go in through Fastify's `inject`, so nothing here opens a port.
import { createVisitorVerifier } from '@lb/common'
import { makeSiteKeys, mintVisitorToken } from '@lb/common/testing'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'

import { buildApp } from '../../src/core/app.ts'
import type { RunningModule } from '../../src/core/module.ts'
import { LB07_SCHEMA_NAMES, registerLb07Routes } from '../../src/modules/lb07/routes/index.ts'
import { createLb07Harness } from './lb07-engine.ts'
import type { HarnessOptions, Lb07Harness } from './lb07-engine.ts'

/** The engine harness, plus an app serving LB-07's routes and a way to call them as a visitor. */
export interface Lb07ApiHarness {
  engine: Lb07Harness
  app: FastifyInstance
  call: (method: 'GET' | 'POST' | 'DELETE', url: string, session: string | undefined, payload?: unknown) => Promise<LightMyRequestResponse>
  tokenFor: (session: string, audience?: string, lifetimeSeconds?: number) => string
  close: () => Promise<void>
}

/** Builds the API on a database of its own. */
export async function createLb07ApiHarness(serverUrl: string, options: HarnessOptions = {}): Promise<Lb07ApiHarness> {
  const engine = await createLb07Harness(serverUrl, options)
  const site = makeSiteKeys()
  const verifier = createVisitorVerifier('lb-07', site.encodedPublicKey)
  const module: RunningModule = {
    part: 'lb-07',
    apiPrefix: '/api/lb07',
    registerRoutes: scope => registerLb07Routes(scope, { deps: engine.deps }, verifier),
    startWorkers: async () => [],
    isReady: async () => true,
    close: async () => {},
  }
  const app = await buildApp({ modules: [module], schemaNames: LB07_SCHEMA_NAMES })
  const tokenFor = (session: string, audience = 'lb-07', lifetimeSeconds = 300): string => {
    const issued = Math.floor(Date.now() / 1000)
    return mintVisitorToken(site.privateKey, { iss: 'lb-web', aud: audience, sub: session, iat: issued, exp: issued + lifetimeSeconds })
  }
  return {
    engine,
    app,
    tokenFor,
    call: (method, url, session, payload) => app.inject({
      method,
      url: `/api/lb07${url}`,
      headers: session === undefined ? {} : { authorization: `Bearer ${tokenFor(session)}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    }),
    close: async () => {
      await app.close()
      await engine.close()
    },
  }
}
