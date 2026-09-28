// Meters: the counters behind every budget and quota. A meter counts one unit
// (requests, tokens or Neurons) for one scope (a provider, a model, a system, a visitor
// session or a run) over one window:
//
// - minute: a sliding window. The previous minute counts in proportion to how much of
//   it still overlaps the last 60 seconds, so traffic can't double up across the
//   boundary the way it can with fixed windows.
// - day: a fixed UTC day, the way Workers AI and OpenRouter reset their free tiers.
// - run: one counter for the whole run, kept for a day.
//
// This file only builds meters and works out amounts; the Redis store counts them.
import type { Model, Routing, System } from '../routing/load.ts'
import { units } from '../routing/schema.ts'
import type { Unit } from '../routing/schema.ts'
import type { TokenEstimate } from './estimate.ts'

/** The time window a meter counts over. */
export type Window = 'minute' | 'day' | 'run'

/** One counter a call must fit under, and what the call would add to it. */
export interface Meter {
  // What is being counted, such as `model:groq/gpt-oss-120b` or `session:lb-01:<id>`.
  scope: string
  window: Window
  unit: Unit
  // The most the window may hold, after the configured ceiling.
  limit: number
  // What this call reserves.
  amount: number
  // The Redis key of the current bucket, and of the previous one for sliding windows.
  key: string
  previousKey: string | undefined
  // How much of the previous minute still counts (0 for fixed windows).
  previousWeight: number
  ttlSeconds: number
  // When the meter next frees capacity, for Retry-After. Runs never free up.
  resetAtMs: number | undefined
}

/** A signed change to one meter: a settlement correction or a refund. */
export interface MeterChange {
  meter: Meter
  delta: number
}

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

/**
 * Builds a meter for the bucket that contains `nowMs`: its Redis keys, how long they
 * live, how much of the previous minute still counts, and when it next frees up.
 */
export function createMeter(prefix: string, scope: string, window: Window, unit: Unit, limit: number, amount: number, nowMs: number): Meter {
  const base = `${prefix}gw:meter:${scope}:${unit}`
  if (window === 'minute') {
    const bucket = Math.floor(nowMs / MINUTE_MS)
    const elapsed = nowMs - bucket * MINUTE_MS
    return {
      scope, window, unit, limit, amount,
      key: `${base}:m:${bucket}`,
      previousKey: `${base}:m:${bucket - 1}`,
      previousWeight: 1 - elapsed / MINUTE_MS,
      // Long enough to still read this bucket as "the previous minute".
      ttlSeconds: 150,
      resetAtMs: (bucket + 1) * MINUTE_MS,
    }
  }
  if (window === 'day') {
    const bucket = Math.floor(nowMs / DAY_MS)
    return {
      scope, window, unit, limit, amount,
      key: `${base}:d:${bucket}`,
      previousKey: undefined,
      previousWeight: 0,
      // A day plus a margin, so a late settlement still finds its bucket.
      ttlSeconds: 90_000,
      resetAtMs: (bucket + 1) * DAY_MS,
    }
  }
  return {
    scope, window, unit, limit, amount,
    key: `${base}:run`,
    previousKey: undefined,
    previousWeight: 0,
    ttlSeconds: 86_400,
    resetAtMs: undefined,
  }
}

/** Converts tokens to Workers AI Neurons at the model's published rates (per 1,000 tokens). */
export function neuronsFor(model: Model, tokens: TokenEstimate): number {
  if (!model.neurons) return 0
  return (tokens.input * model.neurons.input + tokens.output * model.neurons.output) / 1000
}

/** What one call adds to a meter of this unit: its requests, its tokens, or its Neurons. */
function amountFor(unit: Unit, model: Model, tokens: TokenEstimate): number {
  if (unit === 'requests') return tokens.requests ?? 1
  if (unit === 'tokens') return tokens.input + tokens.output
  return neuronsFor(model, tokens)
}

/** The share of each provider limit the gateway lets traffic use, per window. */
export interface Ceilings {
  minuteCeiling: number
  dayCeiling: number
}

/**
 * Lists every provider and model meter a call to this model must fit under. Limits are
 * cut to the configured ceilings; the usage report passes ceilings of 1 to see the
 * providers' own limits.
 */
export function modelMeters(routing: Routing, model: Model, estimate: TokenEstimate, prefix: string, nowMs: number, ceilings: Ceilings = routing.budgets): Meter[] {
  const meters: Meter[] = []
  const scopes = [
    { scope: `model:${model.ref}`, limits: model.limits },
    { scope: `provider:${model.provider.key}`, limits: model.provider.limits },
  ]
  for (const { scope, limits } of scopes) {
    for (const window of ['minute', 'day'] as const) {
      const windowLimits = limits?.[window]
      if (!windowLimits) continue
      const ceiling = window === 'minute' ? ceilings.minuteCeiling : ceilings.dayCeiling
      for (const unit of units) {
        const limit = windowLimits[unit]
        if (limit !== undefined) meters.push(createMeter(prefix, scope, window, unit, limit * ceiling, amountFor(unit, model, estimate), nowMs))
      }
    }
  }
  return meters
}

/**
 * Lists the quotas a system's call is admitted under: the system's calls today, the
 * run's calls, and, for visitor calls, the visitor's calls today.
 */
export function quotaMeters(system: System, session: string | undefined, runId: string, prefix: string, nowMs: number): Meter[] {
  const meters = [
    createMeter(prefix, `system:${system.key}`, 'day', 'requests', system.dailyCalls, 1, nowMs),
    createMeter(prefix, `run:${system.key}:${runId}`, 'run', 'requests', system.maxCallsPerRun, 1, nowMs),
  ]
  if (session) meters.push(createMeter(prefix, `session:${system.key}:${session}`, 'day', 'requests', system.sessionDailyCalls, 1, nowMs))
  return meters
}

/**
 * Works out the corrections once the provider has reported real usage: token and Neuron
 * meters move from the estimate to the actual count. Request meters are already exact.
 */
export function settlement(meters: readonly Meter[], model: Model, estimate: TokenEstimate, actual: TokenEstimate): MeterChange[] {
  const changes: MeterChange[] = []
  for (const meter of meters) {
    if (meter.unit === 'tokens') changes.push({ meter, delta: actual.input + actual.output - (estimate.input + estimate.output) })
    if (meter.unit === 'neurons') changes.push({ meter, delta: neuronsFor(model, actual) - neuronsFor(model, estimate) })
  }
  return changes.filter(change => change.delta !== 0)
}

/** Undoes a reservation's token and Neuron amounts; the request itself still counts. */
export function refund(meters: readonly Meter[]): MeterChange[] {
  return meters.filter(meter => meter.unit !== 'requests' && meter.amount !== 0).map(meter => ({ meter, delta: -meter.amount }))
}
