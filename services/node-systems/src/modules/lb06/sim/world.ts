// The world builder: from a scenario, the remediations applied so far and a number of minutes, the
// whole shop as it was each minute: every service's series, its logs, its deploys, its flags and
// its restarts. It is a pure function. Replaying an incident is calling it with the minutes and
// the remediations its event log holds, and a live run is calling it with one minute more each tick.
import { LB06_METRICS, LB06_SERVICES } from '@lb/contracts'
import type { Lb06Metric, Lb06Scenario, Lb06Service } from '@lb/contracts'

import { deployHistory, flagStates } from './deploys.ts'
import type { Deploy, FlagState } from './deploys.ts'
import { effectsAt, leakTimeline } from './faults.ts'
import type { Effect, Remediation } from './faults.ts'
import { logRowsOfMinute } from './logs.ts'
import type { LogRow } from './logs.ts'
import { gaussian } from './random.ts'
import { BASELINES } from './shop.ts'

/** The series of one service: one number for each minute, by metric. */
export type Series = Record<Lb06Metric, number[]>

/** The shop over `minutes` minutes. */
export interface World {
  scenario: Lb06Scenario
  minutes: number
  series: Record<Lb06Service, Series>
  logs: LogRow[]
  deploys: Deploy[]
  flags: FlagState[]
  // The minutes a service was down (killed or restarted).
  outages: { service: Lb06Service, minute: number }[]
}

/** An empty series. */
function emptySeries(): Series {
  return { request_rate: [], error_rate: [], latency_p50: [], latency_p95: [], latency_p99: [], saturation: [], memory_mb: [] }
}

/** Rounds to a number of decimals, so the series are plain numbers that compare and serialise the same everywhere. */
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/** One service's metrics for one minute, from its baseline, the effect on it and a little seeded noise. */
function metricsOfMinute(seed: number, minute: number, service: Lb06Service, effect: Effect): Record<Lb06Metric, number> {
  const base = BASELINES[service]
  const noise = (key: string) => gaussian(seed, service, minute, key)
  const daily = 1 + 0.05 * Math.sin((2 * Math.PI * minute) / 60)
  const rate = base.requestRate * daily * effect.rateMul * (1 + 0.03 * noise('rate'))
  const error = effect.down ? 1 : Math.min(1, (base.errorRate + effect.errorAdd) * (1 + 0.15 * noise('error')))
  const p50 = base.latencyP50 * effect.latencyMul * (1 + 0.05 * noise('p50'))
  const p95 = Math.max(p50, base.latencyP95 * effect.latencyMul * (1 + 0.06 * noise('p95')))
  const p99 = Math.max(p95, base.latencyP99 * effect.latencyMul * (1 + 0.08 * noise('p99')))
  const saturation = Math.min(1, Math.max(0, base.saturation + effect.saturationAdd + 0.03 * noise('saturation')))
  const memory = Math.max(0, base.memoryMb + effect.memoryAddMb + 8 * noise('memory'))
  return {
    request_rate: round(Math.max(0, rate), 1),
    error_rate: round(Math.max(0, error), 4),
    latency_p50: round(p50, 0),
    latency_p95: round(p95, 0),
    latency_p99: round(p99, 0),
    saturation: round(saturation, 3),
    memory_mb: round(memory, 0),
  }
}

/** The fault's intensity in a minute, read back from the effect on the service it strikes, for the logs' proportions. */
function intensityOf(scenario: Lb06Scenario, effects: Record<Lb06Service, Effect>): number {
  switch (scenario.fault) {
    case 'bad_deploy': return Math.min(1, effects.cart.errorAdd / 0.25)
    case 'slow_payment': return Math.min(1, (effects.payment.latencyMul - 1) / 9)
    case 'memory_leak': return 0
    case 'cache_stampede': return Math.min(1, effects.database.saturationAdd / 0.6)
  }
}

/** Builds the world over `minutes` minutes (minute 0 to minutes - 1). */
export function buildWorld(scenario: Lb06Scenario, remediations: readonly Remediation[], minutes: number): World {
  const faultScenario = { fault: scenario.fault, faultMinute: scenario.baselineMinutes }
  const leak = leakTimeline(faultScenario, remediations, minutes)
  const deploys = deployHistory(scenario, remediations, minutes)
  const flags = flagStates(scenario, remediations, minutes)
  const series = Object.fromEntries(LB06_SERVICES.map(service => [service, emptySeries()])) as Record<Lb06Service, Series>
  const logs: LogRow[] = []
  const outages: World['outages'] = []

  for (let minute = 0; minute < minutes; minute += 1) {
    const effects = effectsAt(faultScenario, remediations, minute, leak)
    const rates = {} as Record<Lb06Service, number>
    const errors = {} as Record<Lb06Service, number>
    for (const service of LB06_SERVICES) {
      const metrics = metricsOfMinute(scenario.seed, minute, service, effects[service])
      for (const metric of LB06_METRICS) series[service][metric].push(metrics[metric])
      rates[service] = metrics.request_rate
      errors[service] = metrics.error_rate
      if (effects[service].down) outages.push({ service, minute })
    }
    logs.push(...logRowsOfMinute(scenario, { minute, effects, rates, errors, leak, faultIntensity: intensityOf(scenario, effects) }, remediations, deploys, flags))
  }
  return { scenario, minutes, series, logs, deploys, flags, outages }
}
