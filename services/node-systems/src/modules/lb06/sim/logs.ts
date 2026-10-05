// The shop's logs: for every minute and service, a count of lines by signature and one sample line.
// Signatures are stable ids (`cart.npe`), so "which signatures are new" is a comparison of ids, and
// the sample lines are rendered from templates with the minute's numbers. The visitor's version
// label appears in the bad deploy's lines, which is why a log line is data to the agents.
import type { Lb06Scenario, Lb06Service } from '@lb/contracts'

import type { Deploy, FlagState } from './deploys.ts'
import { BAD_DEPLOY_DEFAULT_VERSION } from './faults.ts'
import type { Effect, LeakState, Remediation } from './faults.ts'
import { gaussian } from './random.ts'
import { BASELINES } from './shop.ts'

/** The lines of one signature in one minute of one service. */
export interface LogRow {
  minute: number
  service: Lb06Service
  signature: string
  count: number
  sample: string
}

/** Rounds a count with a little seeded noise, never below zero. */
function noisyCount(seed: number, minute: number, key: string, expected: number): number {
  if (expected <= 0) return 0
  return Math.max(0, Math.round(expected * (1 + 0.1 * gaussian(seed, 'log', minute, key))))
}

/** Adds a row when its count is above zero. */
function row(rows: LogRow[], minute: number, service: Lb06Service, signature: string, count: number, sample: string): void {
  if (count > 0) rows.push({ minute, service, signature, count, sample })
}

/** The lines every service writes on any minute: completed and failed requests, from its rate and error rate. */
function baselineRows(rows: LogRow[], seed: number, minute: number, service: Lb06Service, requestRate: number, errorRate: number): void {
  const requests = requestRate * 60
  row(rows, minute, service, `${service}.ok`, noisyCount(seed, minute, `${service}.ok`, requests * (1 - errorRate)), `${service}: request completed`)
  row(rows, minute, service, `${service}.failed`, noisyCount(seed, minute, `${service}.failed`, requests * errorRate), `${service}: request failed`)
}

/** What the log builder needs of one minute: the effects on each service and the leak's state. */
export interface LogMinuteInput {
  minute: number
  effects: Record<Lb06Service, Effect>
  rates: Record<Lb06Service, number>
  errors: Record<Lb06Service, number>
  leak: LeakState
  faultIntensity: number
}

/** The rows of one minute: the baseline lines, then the fault's own signatures in proportion to its intensity. */
export function logRowsOfMinute(scenario: Lb06Scenario, input: LogMinuteInput, remediations: readonly Remediation[], deploys: readonly Deploy[], flags: readonly FlagState[]): LogRow[] {
  const rows: LogRow[] = []
  const { minute, effects, rates, errors, leak } = input
  const seed = scenario.seed
  for (const service of Object.keys(effects) as Lb06Service[]) baselineRows(rows, seed, minute, service, rates[service], errors[service])

  const i = input.faultIntensity
  if (scenario.fault === 'bad_deploy' && i > 0) {
    const version = scenario.params.version ?? BAD_DEPLOY_DEFAULT_VERSION
    row(rows, minute, 'cart', 'cart.npe', noisyCount(seed, minute, 'cart.npe', rates.cart * 60 * 0.25 * i), `cart: NullPointerException in PriceCalculator.apply (build ${version})`)
    row(rows, minute, 'web', 'web.upstream_502', noisyCount(seed, minute, 'web.upstream_502', rates.web * 60 * 0.2 * i), 'web: upstream 502 from cart on POST /cart/items')
  }
  if (scenario.fault === 'slow_payment' && i > 0) {
    row(rows, minute, 'payment', 'payment.provider_timeout', noisyCount(seed, minute, 'payment.provider_timeout', rates.payment * 60 * 0.12 * i), `payment: provider acme-pay timed out after ${Math.round(3000 * i)} ms`)
    row(rows, minute, 'cart', 'cart.payment_deadline', noisyCount(seed, minute, 'cart.payment_deadline', rates.cart * 60 * 0.08 * i), 'cart: payment call exceeded its deadline')
    row(rows, minute, 'cart', 'cart.pool_exhausted', noisyCount(seed, minute, 'cart.pool_exhausted', 6 * i), 'cart: worker pool exhausted, queueing requests')
  }
  if (scenario.fault === 'memory_leak') {
    const fill = leak.fill[minute] ?? 0
    const dead = leak.killed[minute] ?? false
    if (dead) row(rows, minute, 'inventory', 'inventory.oom', 1, 'inventory: OOMKilled, process restarted')
    else if (fill > 0.5) row(rows, minute, 'inventory', 'inventory.gc_pressure', noisyCount(seed, minute, 'inventory.gc_pressure', 12 * fill), `inventory: heap at ${Math.round(40 + fill * 58)}% of limit, GC pause ${Math.round(80 + fill * 900)} ms`)
    if (dead) row(rows, minute, 'cart', 'cart.inventory_refused', noisyCount(seed, minute, 'cart.inventory_refused', rates.cart * 60 * 0.5), 'cart: inventory unavailable: connection refused')
  }
  if (scenario.fault === 'cache_stampede' && i > 0) {
    if (minute === scenario.baselineMinutes) row(rows, minute, 'cache', 'cache.cold_start', 1, 'cache: cold start, 0 keys loaded')
    row(rows, minute, 'database', 'database.pool_exhausted', noisyCount(seed, minute, 'database.pool_exhausted', 40 * i), 'database: connection pool exhausted (max 100)')
    row(rows, minute, 'database', 'database.slow_query', noisyCount(seed, minute, 'database.slow_query', rates.database * 60 * 0.3 * i), 'database: slow query, SELECT stock FROM inventory_levels took more than 500 ms')
    row(rows, minute, 'inventory', 'inventory.db_timeout', noisyCount(seed, minute, 'inventory.db_timeout', rates.inventory * 60 * 0.15 * i), 'inventory: database timeout')
  }

  // What the operators did, written where it happened.
  for (const remediation of remediations) {
    if (remediation.minute !== minute) continue
    const action = remediation.action
    if (action.kind === 'restart') row(rows, minute, action.service, `${action.service}.restarted`, 1, `${action.service}: process restarted by operator`)
    if (action.kind === 'scale') row(rows, minute, action.service, `${action.service}.scaled`, 1, `${action.service}: scaled to ${action.replicas} replicas by operator`)
    if (action.kind === 'flush_cache') row(rows, minute, 'cache', 'cache.flushed', 1, 'cache: flushed by operator, 0 keys loaded')
  }
  for (const deploy of deploys) {
    if (deploy.minute === minute) row(rows, minute, deploy.service, `${deploy.service}.deployed`, 1, `${deploy.service}: deployed ${deploy.version} (${deploy.by})`)
  }
  for (const flag of flags) {
    if (flag.changedAt === minute) row(rows, minute, flagOwnerOf(flag.name), 'config.flag_changed', 1, `config: flag ${flag.name} set to ${flag.value ? 'on' : 'off'} by ${flag.by}`)
  }
  // The database's ordinary slow queries, a few a minute even on a calm day, so the signature is not new.
  row(rows, minute, 'database', 'database.slow_query', noisyCount(seed, minute, 'database.slow_query.calm', 2), 'database: slow query, SELECT * FROM orders WHERE customer_id = ? took more than 500 ms')
  return mergeRows(rows)
}

/** Adds the rows of one signature in one minute together, keeping the first sample. */
function mergeRows(rows: readonly LogRow[]): LogRow[] {
  const merged = new Map<string, LogRow>()
  for (const entry of rows) {
    const key = `${entry.service}|${entry.signature}`
    const existing = merged.get(key)
    if (existing) existing.count += entry.count
    else merged.set(key, { ...entry })
  }
  return [...merged.values()]
}

/** The service whose logs a flag change is written to. Here and not in deploys.ts, to keep the import one way. */
function flagOwnerOf(flag: string): Lb06Service {
  const owners: Record<string, Lb06Service> = { 'payment-provider-fallback': 'payment', 'inventory-prefetch': 'inventory', 'request-coalescing': 'cache', 'checkout-v2': 'web' }
  return Object.hasOwn(owners, flag) ? (owners[flag] as Lb06Service) : 'web'
}

/** The request rate of a service on a calm minute, for the tools' baselines. */
export function calmRate(service: Lb06Service): number {
  return BASELINES[service].requestRate
}
