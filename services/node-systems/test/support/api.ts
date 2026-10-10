// LB-08's HTTP API under test: the real app with the real routes, behind a real visitor
// token check, on the engine harness (a database of its own, a hand-driven queue). Requests
// go in through Fastify's `inject`, so nothing here opens a port.
import { createVisitorVerifier } from '@lb/common'
import { makeSiteKeys, mintVisitorToken } from '@lb/common/testing'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'

import { buildApp } from '../../src/core/app.ts'
import type { RunningModule } from '../../src/core/module.ts'
import type { DescribeWorkflow } from '../../src/modules/lb08/generate/outcome.ts'
import { LB08_SCHEMA_NAMES, registerLb08Routes } from '../../src/modules/lb08/routes/index.ts'
import { loadSamples } from './data.ts'
import { createHarness } from './engine.ts'
import type { Harness } from './engine.ts'

/** The engine harness, plus an app serving LB-08's routes and a way to call them as a visitor. */
export interface ApiHarness {
  engine: Harness
  app: FastifyInstance
  // Calls a route as the visitor with this session hash (or with no token when `session` is undefined).
  call: (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, session: string | undefined, payload?: unknown) => Promise<LightMyRequestResponse>
  // Mints a token the way the site does, for tests of authentication.
  tokenFor: (session: string, audience?: string) => string
  close: () => Promise<void>
}

/** Builds the API on a database of its own. `describe` stands for the model-backed pipeline; without one the service has no gateway. */
export async function createApiHarness(serverUrl: string, describe?: DescribeWorkflow): Promise<ApiHarness> {
  const engine = await createHarness(serverUrl)
  const site = makeSiteKeys()
  const verifier = createVisitorVerifier('lb-08', site.encodedPublicKey)
  const services = { deps: engine.deps, describe, samples: loadSamples() }
  const module: RunningModule = {
    part: 'lb-08',
    apiPrefix: '/api/lb08',
    registerRoutes: scope => registerLb08Routes(scope, services, verifier),
    startWorkers: async () => [],
    isReady: async () => true,
    close: async () => {},
  }
  const app = await buildApp({ modules: [module], schemaNames: LB08_SCHEMA_NAMES })

  const tokenFor = (session: string, audience = 'lb-08'): string => {
    const issued = Math.floor(Date.now() / 1000)
    return mintVisitorToken(site.privateKey, { iss: 'lb-web', aud: audience, sub: session, iat: issued, exp: issued + 300 })
  }
  return {
    engine,
    app,
    tokenFor,
    call: (method, url, session, payload) => app.inject({
      method,
      url: `/api/lb08${url}`,
      headers: session === undefined ? {} : { authorization: `Bearer ${tokenFor(session)}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    }),
    close: async () => {
      await app.close()
      await engine.close()
    },
  }
}
