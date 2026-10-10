// What one tick of the clock carries to the log and the feed: the minute's metrics of every service
// and the SLO as code measured it. Derived from the world, so a reader draws the shop from the
// events alone and never needs a second read of the series.
import { LB06_METRICS, LB06_SERVICES } from '@lb/contracts'
import type { Lb06EventOf, Lb06Metric, Lb06MinuteMetrics, Lb06Service, Lb06Slo } from '@lb/contracts'

import type { World } from '../sim/world.ts'
import { sloAt } from './slo.ts'

/** The metrics of every service at one minute of the world. */
export function metricsAt(world: World, minute: number): Lb06MinuteMetrics {
  const metrics = {} as Record<Lb06Service, Record<Lb06Metric, number>>
  for (const service of LB06_SERVICES) {
    const entry = {} as Record<Lb06Metric, number>
    for (const metric of LB06_METRICS) entry[metric] = world.series[service][metric][minute] ?? 0
    metrics[service] = entry
  }
  return metrics
}

/** The SLO at one minute, as the tick carries it. */
export function sloViewAt(world: World, minute: number): Lb06Slo {
  const state = sloAt(world, minute)
  return { badFraction: Math.round(state.badFraction * 10_000) / 10_000, burns: state.burns, healthy: state.healthy, alerting: state.alerting }
}

/** The data of a tick event at one minute. */
export function tickData(world: World, minute: number): Lb06EventOf<'tick'>['data'] {
  return { metrics: metricsAt(world, minute), slo: sloViewAt(world, minute) }
}
