// Builds the Node systems' HTTP server: the security headers, the JSON error handling, the
// check on request text, the OpenAPI document, the health checks and every system's
// routes. `main.ts` starts it for real; the tests build it with fakes around it.
import { randomUUID } from 'node:crypto'

import Fastify from 'fastify'
import type { FastifyInstance, FastifyServerOptions } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'

import { registerErrorHandling } from './error-handler.ts'
import { registerHealth } from './health.ts'
import type { RunningModule } from './module.ts'
import { registerOpenApi } from './openapi.ts'
import type { SchemaNames } from './openapi.ts'
import { registerSecurityHeaders } from './security-headers.ts'
import { registerTextGuard } from './text-guard.ts'

// The largest request body any route accepts. A workflow graph is a few kilobytes.
const BODY_LIMIT_BYTES = 262_144

/** What the server is built from: the systems it hosts, and how it logs. */
export interface AppOptions {
  modules: readonly RunningModule[]
  // The names the OpenAPI document gives the schemas the systems share.
  schemaNames?: SchemaNames
  logger?: FastifyServerOptions['logger']
}

/**
 * Builds the app, ready to listen. Each system's routes are mounted under its own API
 * prefix in an encapsulated scope, so a system's hooks and decorators never reach another's.
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: BODY_LIMIT_BYTES,
    genReqId: () => randomUUID(),
    // Cloudflare's tunnel and Caddy sit in front, and nothing here depends on the caller's address.
    trustProxy: false,
    return503OnClosing: true,
  })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  registerSecurityHeaders(app)
  registerErrorHandling(app)
  registerTextGuard(app)
  await registerOpenApi(app, options.schemaNames ?? {})
  registerHealth(app, options.modules)

  for (const module of options.modules) {
    await app.register(async (scope) => {
      await module.registerRoutes(scope)
    }, { prefix: module.apiPrefix })
  }
  return app
}
