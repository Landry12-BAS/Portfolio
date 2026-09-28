import { randomUUID } from 'node:crypto'

import Fastify from 'fastify'
import type { FastifyError, FastifyInstance, FastifyServerOptions } from 'fastify'
import type { Redis } from 'ioredis'

import { verifyServiceToken } from './auth/service-token.ts'
import type { ServiceKeys } from './auth/service-token.ts'
import { CircuitBreaker } from './breaker.ts'
import type { BreakerOptions } from './breaker.ts'
import { MeterStore } from './budget/store.ts'
import { ClientGoneError } from './call.ts'
import type { GatewayContext } from './call.ts'
import { errorBody, GatewayError } from './errors.ts'
import type { Routing } from './routing/load.ts'
import type { Profile } from './routing/plan.ts'
import { registerChat } from './routes/chat.ts'
import { registerEmbeddings } from './routes/embeddings.ts'
import { registerHealth, registerInfo } from './routes/info.ts'
import { RedisSpanSink } from './spans.ts'

declare module 'fastify' {
  interface FastifyRequest {
    // The service whose token signed this request.
    service: string
  }
}

export interface GatewayOptions {
  routing: Routing
  profile: Profile
  serviceKeys: ServiceKeys
  redis: Redis
  prefix: string
  now?: () => number
  logger?: FastifyServerOptions['logger']
  breaker?: BreakerOptions
}

export async function buildGateway(options: GatewayOptions): Promise<FastifyInstance> {
  const now = options.now ?? Date.now
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 1_048_576,
    genReqId: () => randomUUID(),
    // Only services on the internal network call the gateway, with no proxy between.
    trustProxy: false,
    return503OnClosing: true,
  })

  const ctx: GatewayContext = {
    routing: options.routing,
    profile: options.profile,
    prefix: options.prefix,
    now,
    meters: new MeterStore(options.redis),
    breaker: new CircuitBreaker(now, options.breaker),
    spans: new RedisSpanSink(options.redis, options.prefix, app.log),
    log: app.log,
  }

  app.decorateRequest('service', '')

  app.addHook('onSend', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    reply.header('x-content-type-options', 'nosniff')
    reply.header('x-request-id', request.id)
  })

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ClientGoneError) {
      request.log.info('client closed the connection')
      return reply.code(499).send()
    }
    if (error instanceof GatewayError) {
      if (error.retryAfterMs !== undefined) reply.header('retry-after', String(Math.ceil(error.retryAfterMs / 1000)))
      return reply.code(error.status).send(error.toBody())
    }
    // Fastify's own client errors: malformed JSON, a body over the limit, a wrong type.
    if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send(errorBody(error.statusCode, 'invalid_request', error.message))
    }
    request.log.error({ err: error }, 'unhandled error')
    return reply.code(500).send(errorBody(500, 'internal_error', 'The gateway hit an internal error.'))
  })

  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send(errorBody(404, 'not_found', `There is no ${request.method} ${request.url.split('?')[0]}.`))
  })

  registerHealth(app, ctx, () => options.redis.ping())

  await app.register(async (v1) => {
    v1.addHook('onRequest', async (request) => {
      request.service = await verifyServiceToken(request.headers.authorization, options.serviceKeys, new Date(now()))
    })
    registerChat(v1, ctx)
    registerEmbeddings(v1, ctx)
    registerInfo(v1, ctx)
  }, { prefix: '/v1' })

  return app
}
