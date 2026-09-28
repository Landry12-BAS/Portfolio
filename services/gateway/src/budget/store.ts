// The Redis store behind every budget and quota. Budgets live in Redis so they survive
// restarts: a daily budget that reset on every deploy would let the gateway overspend a
// provider's free tier.
import type { Redis, Result } from 'ioredis'

import { GatewayError } from '../errors.ts'
import type { Meter, MeterChange } from './meters.ts'

// Checks every meter first and increments only if all of them have room, so a call
// never holds part of a reservation. Returns 0 on success, or the 1-based index of
// the first meter that is full. Redis runs a script atomically, so two calls can't
// both take the last unit of a budget.
//   KEYS: two per meter, its current bucket then its previous bucket (or the current
//         one again, with weight 0, when the window doesn't slide)
//   ARGV: per meter, limit, amount, previous-bucket weight and TTL in seconds
const RESERVE = `
local count = #KEYS / 2
-- Pass 1: refuse the whole reservation if any meter would go over its limit.
for i = 1, count do
  local limit = tonumber(ARGV[i * 4 - 3])
  local amount = tonumber(ARGV[i * 4 - 2])
  local weight = tonumber(ARGV[i * 4 - 1])
  local used = tonumber(redis.call('GET', KEYS[i * 2 - 1]) or '0')
  if weight > 0 then
    used = used + weight * tonumber(redis.call('GET', KEYS[i * 2]) or '0')
  end
  if used + amount > limit then
    return i
  end
end
-- Pass 2: every meter has room, so count the call on all of them.
for i = 1, count do
  redis.call('INCRBYFLOAT', KEYS[i * 2 - 1], ARGV[i * 4 - 2])
  redis.call('EXPIRE', KEYS[i * 2 - 1], ARGV[i * 4])
end
return 0
`

declare module 'ioredis' {
  /** ioredis's commands, plus the reservation script registered in the MeterStore constructor. */
  interface RedisCommander<Context> {
    lbReserve(numberOfKeys: number, ...keysAndArgs: (string | number)[]): Result<number, Context>
  }
}

/**
 * Wraps a Redis failure as a 503. A Redis outage must not turn into unmetered spending,
 * so the gateway fails closed.
 */
function unavailable(error: unknown): GatewayError {
  const detail = error instanceof Error ? error.message : String(error)
  return new GatewayError(503, 'gateway_unavailable', `The budget store is unavailable (${detail}).`, 5_000)
}

/** Reserves, corrects and reads meters in Redis. */
export class MeterStore {
  readonly #redis: Redis

  constructor(redis: Redis) {
    this.#redis = redis
    redis.defineCommand('lbReserve', { lua: RESERVE })
  }

  /** Reserves every meter's amount, or none. Returns the first meter without room. */
  async reserve(meters: readonly Meter[]): Promise<Meter | undefined> {
    if (meters.length === 0) return undefined
    const keys = meters.flatMap(meter => [meter.key, meter.previousKey ?? meter.key])
    const args = meters.flatMap(meter => [meter.limit, meter.amount, meter.previousWeight, meter.ttlSeconds])
    let full: number
    try {
      full = await this.#redis.lbReserve(keys.length, ...keys, ...args)
    }
    catch (error) {
      throw unavailable(error)
    }
    return full === 0 ? undefined : meters[full - 1]
  }

  /** Moves meters by signed amounts: a settlement after a call, or a refund. */
  async adjust(changes: readonly MeterChange[]): Promise<void> {
    if (changes.length === 0) return
    const pipeline = this.#redis.pipeline()
    for (const { meter, delta } of changes) {
      pipeline.incrbyfloat(meter.key, delta)
      pipeline.expire(meter.key, meter.ttlSeconds)
    }
    let results: [Error | null, unknown][] | null
    try {
      results = await pipeline.exec()
    }
    catch (error) {
      throw unavailable(error)
    }
    const failed = results?.find(([error]) => error)
    if (failed?.[0]) throw unavailable(failed[0])
  }

  /** Reads the current usage of each meter, weighting a sliding window's previous minute. */
  async read(meters: readonly Meter[]): Promise<number[]> {
    if (meters.length === 0) return []
    const keys = meters.flatMap(meter => [meter.key, meter.previousKey ?? meter.key])
    let values: (string | null)[]
    try {
      values = await this.#redis.mget(keys)
    }
    catch (error) {
      throw unavailable(error)
    }
    return meters.map((meter, i) => Number(values[i * 2] ?? 0) + meter.previousWeight * Number(values[i * 2 + 1] ?? 0))
  }
}
