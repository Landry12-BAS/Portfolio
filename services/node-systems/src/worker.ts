// The Node systems' worker process: runs every system's queue workers and its repeating
// sweeps. It serves no HTTP. LB-08's workers are the engine's own code and the sandboxed
// connectors' tables, with no model call; LB-04's worker reviews contracts, which asks the
// models, so the worker needs the gateway as the API does.
//
//   just node-worker       (development, with reload)
//   node src/worker.ts     (production)
//
// Stop it with SIGTERM: workers finish the step they are on, then exit.
import { createVisitorVerifier, Gateway, RedisSpanWriter, Tracer } from '@lb/common'

import { loadEnv } from './core/env.ts'
import { createLogger } from './core/logging.ts'
import { openRedis } from './core/redis.ts'
import { MODULES } from './modules/registry.ts'

const env = loadEnv(process.env, 'worker')
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
  visitorVerifier: createVisitorVerifier(module.part, undefined),
  now: () => new Date(),
})))
const workers = (await Promise.all(running.map(module => module.startWorkers()))).flat()
log.info({ workers: workers.length }, 'workers started')

/** Lets the workers finish the steps they are on, then closes every connection. */
async function shutDown(signal: string): Promise<void> {
  log.info({ signal }, 'shutting down')
  await Promise.all(workers.map(worker => worker.close()))
  await Promise.all(running.map(module => module.close()))
  redis.disconnect()
  process.exit(0)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void shutDown(signal))
