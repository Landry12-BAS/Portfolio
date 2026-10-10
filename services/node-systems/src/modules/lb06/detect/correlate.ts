// Correlation, as code: which service's series left its baseline first, which deploy or flag change
// came just before, and which log signatures are new since the incident began. The agents read the
// result as a summary (summary.ts) and cite its items by id; nothing here asks a model anything.
import { LB06_METRICS, LB06_SERVICES } from '@lb/contracts'
import type { Lb06Metric, Lb06Service } from '@lb/contracts'

import type { Deploy, FlagState } from '../sim/deploys.ts'
import type { LogRow } from '../sim/logs.ts'
import { depthOf } from '../sim/shop.ts'
import type { World } from '../sim/world.ts'

/** The first minute a service's metric left its baseline, and by how much. */
export interface Divergence {
  service: Lb06Service
  metric: Lb06Metric
  minute: number
  baselineMean: number
  value: number
  // The evidence id the agents cite for it.
  id: string
}

/** A log signature seen since the incident began and never during the baseline. */
export interface NewSignature {
  id: string
  signature: string
  service: Lb06Service
  firstSeen: number
  count: number
  sample: string
}

/** What correlation found. */
export interface Correlation {
  // Each service that diverged, earliest first; ties go to the deeper service.
  divergences: Divergence[]
  firstDiverged: Divergence | undefined
  // The deploys in the half hour before the first divergence, latest first.
  precedingDeploys: Deploy[]
  // The flags changed in the half hour before the first divergence.
  precedingFlagChanges: FlagState[]
  newSignatures: NewSignature[]
}

// How far back a deploy or a flag change may be to count as preceding the divergence.
const PRECEDING_MINUTES = 30
// A metric diverges when it leaves its baseline by this many deviations, and by this share of its mean, for two minutes running.
const DEVIATIONS = 4
const RELATIVE = 0.15
const RUN_LENGTH = 2

/** The mean and standard deviation of the baseline minutes of a series. */
function baselineOf(values: readonly number[], baselineMinutes: number): { mean: number, deviation: number } {
  const sample = values.slice(0, baselineMinutes)
  const mean = sample.reduce((sum, value) => sum + value, 0) / Math.max(1, sample.length)
  const variance = sample.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, sample.length)
  return { mean, deviation: Math.sqrt(variance) }
}

/** Whether a value is far enough from the baseline to count, in either direction. */
function isFar(value: number, mean: number, deviation: number): boolean {
  const distance = Math.abs(value - mean)
  return distance > Math.max(DEVIATIONS * deviation, RELATIVE * Math.abs(mean), 1e-6)
}

/** The evidence id of a divergence. */
export function divergenceId(service: Lb06Service, metric: Lb06Metric, minute: number): string {
  return `metric:${service}:${metric}:${minute}`
}

/** Finds the first minute at or after the baseline at which any metric of the service leaves its baseline for two minutes running. */
function divergenceOf(world: World, service: Lb06Service): Divergence | undefined {
  const baselineMinutes = world.scenario.baselineMinutes
  let best: Divergence | undefined
  for (const metric of LB06_METRICS) {
    const values = world.series[service][metric]
    const { mean, deviation } = baselineOf(values, baselineMinutes)
    for (let minute = baselineMinutes; minute + RUN_LENGTH <= values.length; minute += 1) {
      const run = values.slice(minute, minute + RUN_LENGTH)
      if (!run.every(value => isFar(value, mean, deviation))) continue
      if (best === undefined || minute < best.minute) best = { service, metric, minute, baselineMean: mean, value: values[minute] ?? 0, id: divergenceId(service, metric, minute) }
      break
    }
  }
  return best
}

/** Correlates the world: the divergences, what preceded the first, and the new signatures. */
export function correlate(world: World): Correlation {
  const divergences = LB06_SERVICES.map(service => divergenceOf(world, service)).filter((found): found is Divergence => found !== undefined)
  divergences.sort((a, b) => a.minute - b.minute || depthOf(b.service) - depthOf(a.service))
  const first = divergences[0]
  const since = first?.minute ?? world.scenario.baselineMinutes
  const precedingDeploys = world.deploys.filter(deploy => deploy.minute <= since && deploy.minute >= since - PRECEDING_MINUTES).sort((a, b) => b.minute - a.minute)
  const precedingFlagChanges = world.flags.filter(flag => flag.changedAt !== null && flag.changedAt <= since && flag.changedAt >= since - PRECEDING_MINUTES)
  return { divergences, firstDiverged: first, precedingDeploys, precedingFlagChanges, newSignatures: newSignatures(world.logs, world.scenario.baselineMinutes) }
}

/** The evidence id of a log signature. */
export function signatureId(signature: string): string {
  return `log:${signature}`
}

/** The signatures seen from the fault minute on that the baseline never showed, with their first minute, count and a sample line. */
export function newSignatures(logs: readonly LogRow[], baselineMinutes: number): NewSignature[] {
  const seenInBaseline = new Set(logs.filter(row => row.minute < baselineMinutes).map(row => row.signature))
  const found = new Map<string, NewSignature>()
  for (const row of logs) {
    if (row.minute < baselineMinutes || seenInBaseline.has(row.signature)) continue
    const existing = found.get(row.signature)
    if (existing) existing.count += row.count
    else found.set(row.signature, { id: signatureId(row.signature), signature: row.signature, service: row.service, firstSeen: row.minute, count: row.count, sample: row.sample })
  }
  return [...found.values()].sort((a, b) => a.firstSeen - b.firstSeen || b.count - a.count)
}
