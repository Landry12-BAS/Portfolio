// LB-04's HTTP API under test: the real app with the real routes, behind a real visitor token check, on
// the engine harness (a database of its own, a hand-driven queue, scripted models). Requests go in
// through Fastify's `inject`, so nothing here opens a port.
import { createVisitorVerifier } from '@lb/common'
import { makeSiteKeys, mintVisitorToken } from '@lb/common/testing'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'

import { buildApp } from '../../src/core/app.ts'
import type { RunningModule } from '../../src/core/module.ts'
import { LB04_SCHEMA_NAMES, registerLb04Routes } from '../../src/modules/lb04/routes/index.ts'
import { createLb04Harness } from './lb04-engine.ts'
import type { HarnessOptions, Lb04Harness } from './lb04-engine.ts'

/** The engine harness, plus an app serving LB-04's routes and a way to call them as a visitor. */
export interface Lb04ApiHarness {
  engine: Lb04Harness
  app: FastifyInstance
  // Calls a route as the visitor with this session hash (or with no token when `session` is undefined).
  call: (method: 'GET' | 'POST' | 'DELETE', url: string, session: string | undefined, payload?: unknown) => Promise<LightMyRequestResponse>
  // Mints a token the way the site does, for tests of authentication.
  tokenFor: (session: string, audience?: string, lifetimeSeconds?: number) => string
  close: () => Promise<void>
}

/** Builds the API on a database of its own. */
export async function createLb04ApiHarness(serverUrl: string, options: HarnessOptions = {}): Promise<Lb04ApiHarness> {
  const engine = await createLb04Harness(serverUrl, options)
  const site = makeSiteKeys()
  const verifier = createVisitorVerifier('lb-04', site.encodedPublicKey)
  const module: RunningModule = {
    part: 'lb-04',
    apiPrefix: '/api/lb04',
    registerRoutes: scope => registerLb04Routes(scope, { deps: engine.deps }, verifier),
    startWorkers: async () => [],
    isReady: async () => true,
    close: async () => {},
  }
  const app = await buildApp({ modules: [module], schemaNames: LB04_SCHEMA_NAMES })

  const tokenFor = (session: string, audience = 'lb-04', lifetimeSeconds = 300): string => {
    const issued = Math.floor(Date.now() / 1000)
    return mintVisitorToken(site.privateKey, { iss: 'lb-web', aud: audience, sub: session, iat: issued, exp: issued + lifetimeSeconds })
  }
  return {
    engine,
    app,
    tokenFor,
    call: (method, url, session, payload) => app.inject({
      method,
      url: `/api/lb04${url}`,
      headers: session === undefined ? {} : { authorization: `Bearer ${tokenFor(session)}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    }),
    close: async () => {
      await app.close()
      await engine.close()
    },
  }
}
