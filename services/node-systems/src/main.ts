// The Node systems' API process: opens every system, builds the HTTP server and listens.
//
//   just node-api          (development, with reload)
//   node src/main.ts       (production)
//
// The API never runs the queue's workers, which are their own process (src/worker.ts), and
// never creates or changes a schema (`just node-migrate`). It needs the AI gateway to describe
// workflows, so it refuses to start without one. The server opens no inbound port to the
// internet: Cloudflare's tunnel reaches it from inside (docs/SECURITY.md).
import { createVisitorVerifier, Gateway, RedisSpanWriter, Tracer } from '@lb/common'

import { buildApp } from './core/app.ts'
import { loadEnv } from './core/env.ts'
import { createLogger, loggerOptions } from './core/logging.ts'
import { openRedis } from './core/redis.ts'
import { schemaNamesOf } from './documentation.ts'
import { MODULES } from './modules/registry.ts'

const env = loadEnv(process.env, 'api')
const log = createLogger(env.LB_NODE_LOG_LEVEL)
const redis = openRedis(env.LB_REDIS_URL, log)
const tracer = new Tracer(new RedisSpanWriter(redis, env.LB_REDIS_PREFIX, log))
// The service's own name, from the settings (which default it), not only from the process environment.
const gateway = Gateway.fromEnv({ ...process.env, LB_SERVICE_NAME: env.LB_SERVICE_NAME })

const running = await Promise.all(MODULES.map(module => module.open({
  env,
  log,
  tracer,
  gateway,
  visitorVerifier: createVisitorVerifier(module.part, env.LB_WEB_TOKEN_KEY),
  now: () => new Date(),
})))
const app = await buildApp({ modules: running, schemaNames: schemaNamesOf(MODULES), logger: loggerOptions(env.LB_NODE_LOG_LEVEL) })

/** Stops taking requests, lets the ones in flight finish, and closes every connection. */
async function shutDown(signal: string): Promise<void> {
  log.info({ signal }, 'shutting down')
  await app.close()
  await Promise.all(running.map(module => module.close()))
  redis.disconnect()
  process.exit(0)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void shutDown(signal))

await app.listen({ host: env.LB_NODE_HOST, port: env.LB_NODE_PORT })
