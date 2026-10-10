// The Redis connection the Node systems use for their queues and their run spans.
import { Redis } from 'ioredis'
import type { Logger } from 'pino'

/**
 * Opens a connection to Redis from a redis:// URL. BullMQ needs `maxRetriesPerRequest: null`
 * so a worker's blocking commands wait for a Redis that is restarting instead of failing.
 * Connection errors are logged by type only, never with the URL, which holds the password.
 */
export function openRedis(url: string, log: Logger): Redis {
  const redis = new Redis(url, { maxRetriesPerRequest: null })
  redis.on('error', (error: Error) => {
    log.warn({ err: error }, 'redis connection error')
  })
  return redis
}
