// The four faults a visitor can inject, and what each does to the shop minute by minute: an
// intensity from 0 to 1 that the right remediation brings down, a wrong one leaves alone or makes
// worse, and a restart interrupts for a minute. Everything is a pure function of the scenario, the
// remediations applied so far and the minute, so the same inputs always give the same shop.
import { LB06_LIMITS } from '@lb/contracts'
import type { Lb06Action, Lb06Fault, Lb06Service } from '@lb/contracts'

import { BASELINES, RUNNING_VERSIONS } from './shop.ts'

/** A remediation the visitor approved, and the minute it was applied. */
export interface Remediation {
  minute: number
  action: Lb06Action
}

/** The scenario the faults read: the fault and the minute it strikes. */
export interface FaultScenario {
  fault: Lb06Fault
  faultMinute: number
}

/** What a fault does to one service in one minute, on top of its calm-day baseline. */
export interface Effect {
  // Added to the error rate (a fraction of requests).
  errorAdd: number
  // The latencies are multiplied by this.
  latencyMul: number
  // Added to the saturation.
  saturationAdd: number
  // The request rate is multiplied by this.
  rateMul: number
  // Added to the memory, in MB.
  memoryAddMb: number
  // The service is down this minute: every request fails.
  down: boolean
}

/** No effect at all. */
export const NO_EFFECT: Effect = { errorAdd: 0, latencyMul: 1, saturationAdd: 0, rateMul: 1, memoryAddMb: 0, down: false }

/** The service each fault strikes first. */
export const FAULT_SERVICE: Readonly<Record<Lb06Fault, Lb06Service>> = {
  bad_deploy: 'cart',
  slow_payment: 'payment',
  memory_leak: 'inventory',
  cache_stampede: 'cache',
}

/** The flag each fault is cured by flipping, where it is a flag, and the value that cures it. */
export const CURING_FLAG: Readonly<Partial<Record<Lb06Fault, { flag: string, value: boolean }>>> = {
  slow_payment: { flag: 'payment-provider-fallback', value: true },
  memory_leak: { flag: 'inventory-prefetch', value: false },
  cache_stampede: { flag: 'request-coalescing', value: true },
}

/** The version the bad deploy replaces, which a rollback must name. */
export const BAD_DEPLOY_PREVIOUS_VERSION = RUNNING_VERSIONS.cart
/** The version label the bad deploy carries when the visitor sets none. */
export const BAD_DEPLOY_DEFAULT_VERSION = '2.14.0'

/** How many minutes a cure takes to show in full: the first minute halves the fault, the second ends it. */
const CURE_MINUTES = 2
/** How much a leaking process fills of its memory headroom each minute: it is killed on the fifth. */
const LEAK_PER_MINUTE = 0.2

/** The minute the first remediation matching `isCure` was applied, or undefined. */
function cureMinute(remediations: readonly Remediation[], isCure: (action: Lb06Action) => boolean): number | undefined {
  const cures = remediations.filter(remediation => isCure(remediation.action)).map(remediation => remediation.minute)
  return cures.length === 0 ? undefined : Math.min(...cures)
}

/** Tells whether an action is the cure of a fault. */
export function isCureOf(fault: Lb06Fault, action: Lb06Action): boolean {
  if (fault === 'bad_deploy') return action.kind === 'rollback' && action.service === 'cart' && action.toVersion === BAD_DEPLOY_PREVIOUS_VERSION
  const flag = CURING_FLAG[fault]
  return flag !== undefined && action.kind === 'flip_flag' && action.flag === flag.flag && action.value === flag.value
}

/** How much of a fault is left at `minute` once its cure was applied at `cure`: 1 before, fading to 0 over the cure minutes. */
function remaining(minute: number, cure: number | undefined): number {
  if (cure === undefined || minute < cure) return 1
  return Math.max(0, 1 - (minute - cure + 1) / CURE_MINUTES)
}

/** The minutes at which a service was restarted by an approved action. */
function restartMinutes(remediations: readonly Remediation[], service: Lb06Service): number[] {
  return remediations.filter(remediation => remediation.action.kind === 'restart' && remediation.action.service === service).map(remediation => remediation.minute)
}

/** The replicas a service has at `minute`, after any scaling applied by then. */
export function replicasAt(remediations: readonly Remediation[], service: Lb06Service, minute: number): number {
  let replicas = BASELINES[service].replicas
  for (const remediation of remediations) {
    if (remediation.action.kind === 'scale' && remediation.action.service === service && remediation.minute <= minute) replicas = remediation.action.replicas
  }
  return replicas
}

/** The intensity of the bad deploy at a minute: full from the deploy until the rollback of cart to the previous version, which takes two minutes. */
function badDeployIntensity(scenario: FaultScenario, remediations: readonly Remediation[], minute: number): number {
  if (minute < scenario.faultMinute) return 0
  return remaining(minute, cureMinute(remediations, action => isCureOf('bad_deploy', action)))
}

/** The intensity of the slow provider: full until the fallback provider's flag is flipped on. */
function slowPaymentIntensity(scenario: FaultScenario, remediations: readonly Remediation[], minute: number): number {
  if (minute < scenario.faultMinute) return 0
  return remaining(minute, cureMinute(remediations, action => isCureOf('slow_payment', action)))
}

/**
 * The stampede: the cache starts cold at the fault minute (and again after any flush), the database
 * takes every miss, and the cache can only warm slowly while the database is overloaded. Scaling the
 * database relieves it in part; the coalescing flag ends it.
 */
function stampedeIntensity(scenario: FaultScenario, remediations: readonly Remediation[], minute: number): number {
  if (minute < scenario.faultMinute) return 0
  const colds = [scenario.faultMinute, ...remediations.filter(remediation => remediation.action.kind === 'flush_cache' && remediation.minute <= minute).map(remediation => remediation.minute)]
  const lastCold = Math.max(...colds)
  const warming = Math.max(0.4, 1 - (minute - lastCold) / 40)
  const scaled = replicasAt(remediations, 'database', minute) > BASELINES.database.replicas ? 0.6 : 1
  return warming * scaled * remaining(minute, cureMinute(remediations, action => isCureOf('cache_stampede', action)))
}

/** How full the leaking inventory process is of its headroom in each minute, and the minutes it is killed, over `minutes` minutes. */
export function leakTimeline(scenario: FaultScenario, remediations: readonly Remediation[], minutes: number): { fill: number[], killed: boolean[] } {
  const fill: number[] = []
  const killed: boolean[] = []
  const cure = cureMinute(remediations, action => isCureOf('memory_leak', action))
  const restarts = new Set(restartMinutes(remediations, 'inventory'))
  let level = 0
  for (let minute = 0; minute < minutes; minute += 1) {
    let dead = false
    if (minute < scenario.faultMinute) {
      level = 0
    }
    else if (restarts.has(minute)) {
      level = 0
      dead = true
    }
    else if (cure !== undefined && minute >= cure) {
      level = Math.max(0, level - 0.34)
    }
    else {
      level = Math.min(1, level + LEAK_PER_MINUTE)
      if (level >= 1) {
        dead = true
        level = 0
      }
    }
    fill.push(dead ? 1 : level)
    killed.push(dead)
  }
  return { fill, killed }
}

/** Adds one effect on top of another: errors and saturation add, latency multiplies, a down service stays down. */
function combine(base: Effect, extra: Partial<Effect>): Effect {
  return {
    errorAdd: base.errorAdd + (extra.errorAdd ?? 0),
    latencyMul: base.latencyMul * (extra.latencyMul ?? 1),
    saturationAdd: base.saturationAdd + (extra.saturationAdd ?? 0),
    rateMul: base.rateMul * (extra.rateMul ?? 1),
    memoryAddMb: base.memoryAddMb + (extra.memoryAddMb ?? 0),
    down: base.down || (extra.down ?? false),
  }
}

/** The effects of every service for one minute: an empty table to add to. */
type Effects = Record<Lb06Service, Effect>

/** Every service with no effect. */
function calm(): Effects {
  return { web: NO_EFFECT, cart: NO_EFFECT, payment: NO_EFFECT, inventory: NO_EFFECT, database: NO_EFFECT, cache: NO_EFFECT }
}

/** Adds an effect to one service in the table. */
function add(effects: Effects, service: Lb06Service, extra: Partial<Effect>): void {
  effects[service] = combine(effects[service], extra)
}

/** The leak's fills and kills, computed once for a whole run so the per-minute function stays pure in its inputs. */
export interface LeakState {
  fill: number[]
  killed: boolean[]
}

/**
 * What every service feels at `minute`, given the scenario and the remediations applied by then. The
 * leak's state is passed in (leakTimeline), since it depends on the minutes before.
 */
export function effectsAt(scenario: FaultScenario, remediations: readonly Remediation[], minute: number, leak: LeakState): Effects {
  const effects = calm()
  const applied = remediations.filter(remediation => remediation.minute <= minute)

  if (scenario.fault === 'bad_deploy') {
    const i = badDeployIntensity(scenario, applied, minute)
    add(effects, 'cart', { errorAdd: 0.25 * i, latencyMul: 1 + 0.6 * i })
    add(effects, 'web', { errorAdd: 0.2 * i, latencyMul: 1 + 0.4 * i })
  }

  if (scenario.fault === 'slow_payment') {
    const i = slowPaymentIntensity(scenario, applied, minute)
    const cartReplicas = replicasAt(applied, 'cart', minute) / BASELINES.cart.replicas
    add(effects, 'payment', { latencyMul: 1 + 9 * i, errorAdd: 0.12 * i, saturationAdd: 0.3 * i })
    add(effects, 'cart', { latencyMul: 1 + 2.5 * i, saturationAdd: (0.45 * i) / cartReplicas, errorAdd: 0.08 * i })
    add(effects, 'web', { latencyMul: 1 + 1.6 * i, errorAdd: 0.06 * i })
  }

  if (scenario.fault === 'memory_leak') {
    const fill = leak.fill[minute] ?? 0
    const dead = leak.killed[minute] ?? false
    const headroom = BASELINES.inventory.memoryLimitMb - BASELINES.inventory.memoryMb
    const inventoryError = dead ? 1 : 0.06 * fill ** 3
    const inventoryLatency = 1 + 2 * fill ** 2
    add(effects, 'inventory', { memoryAddMb: dead ? 0 : fill * headroom, latencyMul: inventoryLatency, errorAdd: dead ? 0 : inventoryError, down: dead })
    add(effects, 'cart', { errorAdd: 0.5 * inventoryError, latencyMul: 1 + 0.5 * (inventoryLatency - 1) })
    add(effects, 'web', { errorAdd: 0.4 * inventoryError, latencyMul: 1 + 0.25 * (inventoryLatency - 1) })
  }

  if (scenario.fault === 'cache_stampede') {
    const i = stampedeIntensity(scenario, applied, minute)
    add(effects, 'cache', { rateMul: 1 - 0.7 * i, memoryAddMb: -600 * i })
    add(effects, 'database', { rateMul: 1 + 1.8 * i, saturationAdd: 0.6 * i, latencyMul: 1 + 6 * i, errorAdd: 0.2 * i })
    add(effects, 'inventory', { latencyMul: 1 + 2 * i, errorAdd: 0.15 * i })
    add(effects, 'cart', { latencyMul: 1 + 1.8 * i, errorAdd: 0.12 * i })
    add(effects, 'web', { latencyMul: 1 + 1.4 * i, errorAdd: 0.1 * i })
  }

  // A restart takes a service down for its minute, and its callers feel it.
  for (const remediation of applied) {
    if (remediation.action.kind !== 'restart' || remediation.minute !== minute) continue
    const service = remediation.action.service
    add(effects, service, { down: true, memoryAddMb: -BASELINES[service].memoryMb * 0.3 })
    for (const caller of callersOf(service)) add(effects, caller, { errorAdd: 0.6 })
  }

  // A rollback redeploys the service: a minute of raised errors on one replica's worth of requests.
  for (const remediation of applied) {
    if (remediation.action.kind !== 'rollback' || remediation.minute !== minute) continue
    add(effects, remediation.action.service, { errorAdd: 0.02, latencyMul: 1.1 })
  }

  // A cache flush empties the cache: the database takes every request for a few minutes, whatever the fault.
  for (const remediation of applied) {
    if (remediation.action.kind !== 'flush_cache') continue
    const since = minute - remediation.minute
    if (since < 0 || since >= 4) continue
    const cold = 1 - since / 4
    add(effects, 'cache', { rateMul: 1 - 0.6 * cold, memoryAddMb: -500 * cold })
    add(effects, 'database', { rateMul: 1 + 1.2 * cold, saturationAdd: 0.4 * cold, latencyMul: 1 + 3 * cold, errorAdd: 0.08 * cold })
    add(effects, 'web', { latencyMul: 1 + 0.6 * cold, errorAdd: 0.04 * cold })
  }

  // The leak's safety belt: whatever else happens, the inventory's memory stays under its limit.
  effects.inventory = { ...effects.inventory, memoryAddMb: Math.min(effects.inventory.memoryAddMb, BASELINES.inventory.memoryLimitMb - BASELINES.inventory.memoryMb) }
  return effects
}

/** The services that call `service`. */
export function callersOf(service: Lb06Service): Lb06Service[] {
  const callers: Record<Lb06Service, Lb06Service[]> = {
    web: [],
    cart: ['web'],
    payment: ['cart'],
    inventory: ['cart'],
    database: ['inventory', 'cache'],
    cache: ['cart'],
  }
  return callers[service]
}

/** The scenario's fault minute: the end of the calm baseline. */
export function faultMinuteOf(baselineMinutes: number): number {
  return Math.min(baselineMinutes, LB06_LIMITS.maxSeriesMinutes)
}
