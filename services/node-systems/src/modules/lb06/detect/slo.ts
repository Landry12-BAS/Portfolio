// The SLO and its burn-rate alerts, as code: the share of bad requests at the edge (errors, and
// requests slower than the latency bound), the burn rate against the error budget, and the
// multi-window rule that fires an alert when both a short and a long window burn fast. The same
// code says when the SLO has recovered, which is the only thing that closes an incident.
import type { Lb06Service } from '@lb/contracts'

import { SLO_LATENCY_MS, SLO_TARGET } from '../sim/shop.ts'
import type { World } from '../sim/world.ts'

/** The service whose requests the SLO counts: the edge. */
export const SLO_SERVICE: Lb06Service = 'web'

/** One multi-window rule: both windows must burn at `threshold` times the budget for the alert to fire. */
export interface BurnRule {
  shortMinutes: number
  longMinutes: number
  threshold: number
}

/** The two rules, a fast burn and a slow one, in compressed windows that suit a simulated hour. */
export const BURN_RULES: readonly BurnRule[] = [
  { shortMinutes: 2, longMinutes: 6, threshold: 10 },
  { shortMinutes: 5, longMinutes: 15, threshold: 5 },
]

/** The burn rate under which a minute counts as healthy, over the short window. */
export const HEALTHY_BURN = 1
/** The window the recovery check reads. */
export const RECOVERY_WINDOW_MINUTES = 2

/** The burn rates of one rule at one minute. */
export interface Burn {
  shortMinutes: number
  longMinutes: number
  shortBurn: number
  longBurn: number
}

/** What the SLO says at one minute. */
export interface SloState {
  minute: number
  // The share of bad requests this minute.
  badFraction: number
  burns: Burn[]
  // Whether a rule fires.
  alerting: boolean
  // Whether the short window burns under the healthy mark.
  healthy: boolean
}

/** The share of requests slower than the bound, estimated from the percentiles the service reports. */
export function slowFraction(p95: number, p99: number): number {
  if (p95 > SLO_LATENCY_MS) return 0.05 + 0.2 * Math.min(1, (p95 - SLO_LATENCY_MS) / SLO_LATENCY_MS)
  if (p99 > SLO_LATENCY_MS) return 0.01 * Math.min(1, (p99 - SLO_LATENCY_MS) / SLO_LATENCY_MS)
  return 0
}

/** The share of bad requests at the edge in one minute: failed ones and slow ones. */
export function badFractionAt(world: World, minute: number): number {
  const edge = world.series[SLO_SERVICE]
  const error = edge.error_rate[minute] ?? 0
  const p95 = edge.latency_p95[minute] ?? 0
  const p99 = edge.latency_p99[minute] ?? 0
  return Math.min(1, error + (1 - error) * slowFraction(p95, p99))
}

/** The burn rate of a bad fraction: how many times faster than the budget allows. */
export function burnOf(badFraction: number): number {
  return badFraction / (1 - SLO_TARGET)
}

/** The mean burn rate over the `length` minutes ending at `end` (inclusive). Minutes before 0 count as calm. */
export function windowBurn(world: World, end: number, length: number): number {
  let total = 0
  for (let minute = end - length + 1; minute <= end; minute += 1) {
    total += minute < 0 ? burnOf(0) : burnOf(badFractionAt(world, minute))
  }
  return total / length
}

/** Rounds a burn rate to two decimals for the events and the board. */
function tidy(value: number): number {
  return Math.round(value * 100) / 100
}

/** The SLO's state at one minute. */
export function sloAt(world: World, minute: number): SloState {
  const burns = BURN_RULES.map(rule => ({
    shortMinutes: rule.shortMinutes,
    longMinutes: rule.longMinutes,
    shortBurn: tidy(windowBurn(world, minute, rule.shortMinutes)),
    longBurn: tidy(windowBurn(world, minute, rule.longMinutes)),
  }))
  const alerting = BURN_RULES.some((rule, index) => {
    const burn = burns[index]
    return burn !== undefined && burn.shortBurn >= rule.threshold && burn.longBurn >= rule.threshold
  })
  return {
    minute,
    badFraction: badFractionAt(world, minute),
    burns,
    alerting,
    healthy: windowBurn(world, minute, RECOVERY_WINDOW_MINUTES) < HEALTHY_BURN,
  }
}

/** The first minute at or after `from` at which a burn rule fires, or undefined. */
export function firstAlertMinute(world: World, from = 0): number | undefined {
  for (let minute = from; minute < world.minutes; minute += 1) {
    if (sloAt(world, minute).alerting) return minute
  }
  return undefined
}

/** How many minutes up to and including `minute` have been healthy in a row. */
export function healthyStreak(world: World, minute: number): number {
  let streak = 0
  for (let current = minute; current >= 0; current -= 1) {
    if (!sloAt(world, current).healthy) break
    streak += 1
  }
  return streak
}

/** The first minute at or after `from` that ends `needed` healthy minutes in a row, or undefined. */
export function recoveryMinute(world: World, from: number, needed: number): number | undefined {
  for (let minute = from; minute < world.minutes; minute += 1) {
    if (healthyStreak(world, minute) >= needed) return minute
  }
  return undefined
}
