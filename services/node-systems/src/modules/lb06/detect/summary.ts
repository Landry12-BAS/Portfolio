// The compact summary the agents reason over, built by code from the world and the correlation:
// the alert, the services in the order they diverged, with how far each metric moved, the deploys
// and flag changes that preceded the first divergence, the new log signatures, and the outages.
// Every item carries an evidence id, and the evidence index says which ids exist, so a hypothesis
// that cites what the server does not hold is dropped. The agents never see raw series or raw logs.
import { LB06_METRICS, LB06_SERVICES } from '@lb/contracts'
import type { Lb06Metric, Lb06Service } from '@lb/contracts'

import type { World } from '../sim/world.ts'
import { correlate, divergenceId, signatureId } from './correlate.ts'
import type { Correlation } from './correlate.ts'
import { sloAt } from './slo.ts'
import type { Burn } from './slo.ts'

/** How one metric of a service moved from its baseline to the last minutes. */
export interface MetricChange {
  metric: Lb06Metric
  baseline: number
  now: number
  // The ratio now / baseline, or null when the baseline is zero.
  ratio: number | null
}

/** One service in the summary. */
export interface ServiceSummary {
  service: Lb06Service
  divergedAt: number | null
  firstMetric: Lb06Metric | null
  evidence: string | null
  changes: MetricChange[]
  downMinutes: number[]
}

/** A deploy as the summary shows it. */
export interface DeploySummary {
  id: string
  evidence: string
  service: Lb06Service
  version: string
  previousVersion: string
  minute: number
  minutesBeforeDivergence: number | null
  by: string
  note: string
}

/** A flag change as the summary shows it. */
export interface FlagSummary {
  evidence: string
  name: string
  value: boolean
  changedAt: number | null
  by: string
}

/** A new signature as the summary shows it. */
export interface SignatureSummary {
  evidence: string
  signature: string
  service: Lb06Service
  firstSeen: number
  count: number
  sample: string
}

/** The summary the agents read. */
export interface IncidentSummary {
  minute: number
  faultMinute: number
  alert: { burns: Burn[], badFraction: number }
  services: ServiceSummary[]
  firstDiverged: Lb06Service | null
  deploys: DeploySummary[]
  flags: FlagSummary[]
  newSignatures: SignatureSummary[]
}

/** The mean of the last `length` values of a series, or of what there is. */
function recentMean(values: readonly number[], length: number): number {
  const sample = values.slice(Math.max(0, values.length - length))
  return sample.reduce((sum, value) => sum + value, 0) / Math.max(1, sample.length)
}

/** The mean of the first `length` values of a series. */
function baselineMean(values: readonly number[], length: number): number {
  const sample = values.slice(0, length)
  return sample.reduce((sum, value) => sum + value, 0) / Math.max(1, sample.length)
}

/** Rounds to three significant decimals, enough for a summary. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** Builds one service's part of the summary. */
function summariseService(world: World, correlation: Correlation, service: Lb06Service): ServiceSummary {
  const divergence = correlation.divergences.find(found => found.service === service)
  const changes = LB06_METRICS.map((metric) => {
    const values = world.series[service][metric]
    const baseline = round(baselineMean(values, world.scenario.baselineMinutes))
    const now = round(recentMean(values, 3))
    return { metric, baseline, now, ratio: baseline === 0 ? null : round(now / baseline) }
  })
  return {
    service,
    divergedAt: divergence?.minute ?? null,
    firstMetric: divergence?.metric ?? null,
    evidence: divergence?.id ?? null,
    changes,
    downMinutes: world.outages.filter(outage => outage.service === service).map(outage => outage.minute),
  }
}

/** Builds the summary of the world as it stands at its last minute. */
export function summarise(world: World): IncidentSummary {
  const correlation = correlate(world)
  const minute = world.minutes - 1
  const slo = sloAt(world, minute)
  const divergenceMinute = correlation.firstDiverged?.minute
  const horizon = Math.max(0, minute - 60)
  return {
    minute,
    faultMinute: world.scenario.baselineMinutes,
    alert: { burns: slo.burns, badFraction: round(slo.badFraction) },
    services: LB06_SERVICES.map(service => summariseService(world, correlation, service)),
    firstDiverged: correlation.firstDiverged?.service ?? null,
    deploys: world.deploys.filter(deploy => deploy.minute >= horizon).sort((a, b) => b.minute - a.minute).map(deploy => ({
      id: deploy.id,
      evidence: `deploy:${deploy.id}`,
      service: deploy.service,
      version: deploy.version,
      previousVersion: deploy.previousVersion,
      minute: deploy.minute,
      minutesBeforeDivergence: divergenceMinute === undefined ? null : divergenceMinute - deploy.minute,
      by: deploy.by,
      note: deploy.note,
    })),
    flags: world.flags.map(flag => ({ evidence: `flag:${flag.name}`, name: flag.name, value: flag.value, changedAt: flag.changedAt, by: flag.by })),
    newSignatures: correlation.newSignatures.slice(0, 8).map(signature => ({
      evidence: signature.id,
      signature: signature.signature,
      service: signature.service,
      firstSeen: signature.firstSeen,
      count: signature.count,
      sample: signature.sample,
    })),
  }
}

/** Every evidence id the world holds: the divergences, every deploy, every flag, every signature ever logged, and the events by kind. */
export function evidenceIndex(world: World, eventKinds: readonly string[] = []): Set<string> {
  const ids = new Set<string>()
  const correlation = correlate(world)
  for (const divergence of correlation.divergences) ids.add(divergence.id)
  for (const service of LB06_SERVICES) {
    for (const metric of LB06_METRICS) {
      // A metric may be cited at any minute of the series the agents could have queried.
      for (let minute = 0; minute < world.minutes; minute += 1) ids.add(divergenceId(service, metric, minute))
    }
  }
  for (const deploy of world.deploys) ids.add(`deploy:${deploy.id}`)
  for (const flag of world.flags) ids.add(`flag:${flag.name}`)
  for (const row of world.logs) ids.add(signatureId(row.signature))
  for (const kind of eventKinds) ids.add(`event:${kind}`)
  return ids
}
