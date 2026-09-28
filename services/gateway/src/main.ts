import { readFileSync } from 'node:fs'

import { Redis } from 'ioredis'

import { buildGateway } from './app.ts'
import { importServiceKeys } from './auth/service-token.ts'
import { loadEnv } from './env.ts'
import { loadRouting } from './routing/load.ts'

const env = loadEnv(process.env)
const routing = loadRouting(readFileSync(env.LB_ROUTING_FILE ?? new URL('../routing.yaml', import.meta.url), 'utf8'), process.env)

const usable = [...routing.providers.values()]
  .filter(provider => provider.configured && (env.LB_GATEWAY_PROFILE === 'dev' || provider.terms === 'production'))
if (usable.length === 0) {
  throw new Error('No provider is configured. Set at least one provider\'s API key (the keyEnv names in routing.yaml).')
}

const redis = new Redis(env.LB_REDIS_URL, {
  // Fail fast instead of queueing: a call must never wait on, or skip, its budget check.
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  lazyConnect: true,
})
await redis.connect()

const app = await buildGateway({
  routing,
  profile: env.LB_GATEWAY_PROFILE,
  serviceKeys: await importServiceKeys(env.LB_SERVICE_KEYS),
  redis,
  prefix: env.LB_REDIS_PREFIX,
  logger: {
    level: env.LB_GATEWAY_LOG_LEVEL,
    // Request logs carry no headers or bodies; this is a second line of defence.
    redact: { paths: ['req.headers.authorization', 'req.headers["x-lb-session"]'], censor: '[redacted]' },
  },
})

await app.listen({ host: env.LB_GATEWAY_HOST, port: env.LB_GATEWAY_PORT })
app.log.info({ profile: env.LB_GATEWAY_PROFILE, providers: usable.map(provider => provider.key) }, 'gateway ready')

// On shutdown, calls in flight get a few seconds to finish; then the remaining
// connections are closed, so a client's idle keep-alive socket can't hold the process
// past the container's stop timeout.
const SHUTDOWN_GRACE_MS = 8_000

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down')
    const closing = app.close()
    setTimeout(() => app.server.closeAllConnections(), SHUTDOWN_GRACE_MS).unref()
    closing
      .then(() => redis.quit())
      .then(() => process.exit(0), (error: unknown) => {
        app.log.error({ err: error }, 'shutdown failed')
        process.exit(1)
      })
  })
}
