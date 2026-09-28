import type { Model, Routing, System } from '../routing/load.ts'
import { units } from '../routing/schema.ts'
import type { Unit } from '../routing/schema.ts'
import type { TokenEstimate } from './estimate.ts'

// A meter counts one unit (requests, tokens or Neurons) for one scope (a provider, a
// model, a system, a visitor session or a run) over one window.
//
// - minute: a sliding window. The previous minute counts in proportion to how much of
//   it still overlaps the last 60 seconds, so traffic can't double up across the
//   boundary the way it can with fixed windows.
// - day: a fixed UTC day, the way Workers AI and OpenRouter reset their free tiers.
// - run: one counter for the whole run, kept for a day.

export type Window = 'minute' | 'day' | 'run'

export interface Meter {
  scope: string
  window: Window
  unit: Unit
  // The most the window may hold, after the configured ceiling.
  limit: number
  // What this call reserves.
  amount: number
  key: string
  previousKey: string | undefined
  previousWeight: number
  ttlSeconds: number
  // When the meter next frees capacity, for Retry-After. Runs never free up.
  resetAtMs: number | undefined
}

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

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

export function neuronsFor(model: Model, tokens: TokenEstimate): number {
  if (!model.neurons) return 0
  return (tokens.input * model.neurons.input + tokens.output * model.neurons.output) / 1000
}

function amountFor(unit: Unit, model: Model, tokens: TokenEstimate): number {
  if (unit === 'requests') return 1
  if (unit === 'tokens') return tokens.input + tokens.output
  return neuronsFor(model, tokens)
}

export interface Ceilings {
  minuteCeiling: number
  dayCeiling: number
}

/**
 * Every provider and model meter a call to this model must fit under. Limits are cut
 * to the configured ceilings; the usage report passes ceilings of 1 to see the
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

/** The quotas a system's call is admitted under: the system's day, the visitor's day, and the run. */
export function quotaMeters(system: System, session: string | undefined, runId: string, prefix: string, nowMs: number): Meter[] {
  const meters = [
    createMeter(prefix, `system:${system.key}`, 'day', 'requests', system.dailyCalls, 1, nowMs),
    createMeter(prefix, `run:${system.key}:${runId}`, 'run', 'requests', system.maxCallsPerRun, 1, nowMs),
  ]
  if (session) meters.push(createMeter(prefix, `session:${system.key}:${session}`, 'day', 'requests', system.sessionDailyCalls, 1, nowMs))
  return meters
}

/**
 * Corrections once the provider has reported real usage: token and Neuron meters move
 * from the estimate to the actual count. Request meters are already exact.
 */
export function settlement(meters: readonly Meter[], model: Model, estimate: TokenEstimate, actual: TokenEstimate): { meter: Meter, delta: number }[] {
  const changes: { meter: Meter, delta: number }[] = []
  for (const meter of meters) {
    if (meter.unit === 'tokens') changes.push({ meter, delta: actual.input + actual.output - (estimate.input + estimate.output) })
    if (meter.unit === 'neurons') changes.push({ meter, delta: neuronsFor(model, actual) - neuronsFor(model, estimate) })
  }
  return changes.filter(change => change.delta !== 0)
}

/** Undoes a reservation's token and Neuron amounts; the request itself still counts. */
export function refund(meters: readonly Meter[]): { meter: Meter, delta: number }[] {
  return meters.filter(meter => meter.unit !== 'requests' && meter.amount !== 0).map(meter => ({ meter, delta: -meter.amount }))
}
