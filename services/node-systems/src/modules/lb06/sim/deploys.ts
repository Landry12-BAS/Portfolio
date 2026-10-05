// The shop's deploy history and feature flags, as the agents and the board see them: a calm history
// drawn from the seed, the fault's own deploy or flag change, and the changes the approved
// remediations made. The visitor's two strings (a deploy's version label, a flag's name) land here,
// which is why everything built from this list is data to the agents and never an instruction.
import { LB06_FLAGS, LB06_SERVICES } from '@lb/contracts'
import type { Lb06Flag, Lb06Scenario, Lb06Service } from '@lb/contracts'

import { BAD_DEPLOY_DEFAULT_VERSION, CURING_FLAG, FAULT_SERVICE } from './faults.ts'
import type { Remediation } from './faults.ts'
import { pick, unit } from './random.ts'
import { RUNNING_VERSIONS } from './shop.ts'

/** One deploy: which service went to which version, when, by whom, and the one-line note the deployer wrote. */
export interface Deploy {
  id: string
  service: Lb06Service
  version: string
  previousVersion: string
  minute: number
  by: 'ci' | 'operator'
  note: string
}

/** One feature flag and its state: the value, when it last changed (null for never since the history began) and who changed it. */
export interface FlagState {
  name: string
  value: boolean
  changedAt: number | null
  by: 'ops' | 'operator' | 'default'
}

// The notes the calm history's deploys carry, picked by the seed.
const CALM_NOTES = ['dependency bumps', 'copy changes on the product page', 'logging tidy-up', 'metrics labels renamed', 'retry budget tuned', 'image build base updated']

/** Versions the calm history steps through: the running version is the last one. */
function earlierVersion(version: string, stepsBack: number): string {
  const parts = version.split('.').map(Number)
  const patch = Math.max(0, (parts[2] ?? 0) - stepsBack)
  return `${parts[0] ?? 0}.${parts[1] ?? 0}.${patch}`
}

/** The service each fault's decoy deploy lands on, and how long before the fault: a deploy that tempts a rollback the fault does not need. */
const DECOY: Readonly<Record<Lb06Scenario['fault'], { service: Lb06Service, minutesBefore: number, note: string }>> = {
  bad_deploy: { service: 'web', minutesBefore: 22, note: 'header layout tweak' },
  slow_payment: { service: 'payment', minutesBefore: 35, note: 'provider client upgraded' },
  memory_leak: { service: 'cart', minutesBefore: 14, note: 'cart badge counter' },
  cache_stampede: { service: 'database', minutesBefore: 18, note: 'connection pool size bumped' },
}

/**
 * The deploy history up to `minutes` minutes: four calm deploys well before the fault, the decoy
 * deploy that precedes the fault by a little, the bad deploy itself when the fault is one, and every
 * rollback the visitor approved.
 */
export function deployHistory(scenario: Lb06Scenario, remediations: readonly Remediation[], minutes: number): Deploy[] {
  const faultMinute = scenario.baselineMinutes
  const deploys: Deploy[] = []
  // The calm history: between 170 and 50 minutes before the fault, a service each, picked by the seed.
  for (let index = 0; index < 4; index += 1) {
    const service = pick(LB06_SERVICES, scenario.seed, 'calm-deploy-service', index)
    const minute = faultMinute - 170 + Math.floor(unit(scenario.seed, 'calm-deploy-minute', index) * 120)
    deploys.push({ id: `d${index + 1}`, service, version: earlierVersion(RUNNING_VERSIONS[service], 1), previousVersion: earlierVersion(RUNNING_VERSIONS[service], 2), minute, by: 'ci', note: pick(CALM_NOTES, scenario.seed, 'calm-deploy-note', index) })
  }
  const decoy = DECOY[scenario.fault]
  deploys.push({ id: 'd5', service: decoy.service, version: RUNNING_VERSIONS[decoy.service], previousVersion: earlierVersion(RUNNING_VERSIONS[decoy.service], 1), minute: faultMinute - decoy.minutesBefore, by: 'ci', note: decoy.note })
  if (scenario.fault === 'bad_deploy') {
    deploys.push({ id: 'd6', service: 'cart', version: scenario.params.version ?? BAD_DEPLOY_DEFAULT_VERSION, previousVersion: RUNNING_VERSIONS.cart, minute: faultMinute, by: 'ci', note: 'price calculator refactor' })
  }
  let next = deploys.length + 1
  for (const remediation of remediations) {
    if (remediation.action.kind !== 'rollback' || remediation.minute >= minutes) continue
    const service = remediation.action.service
    const running = [...deploys].filter(deploy => deploy.service === service && deploy.minute <= remediation.minute).at(-1)?.version ?? RUNNING_VERSIONS[service]
    deploys.push({ id: `d${next}`, service, version: remediation.action.toVersion, previousVersion: running, minute: remediation.minute, by: 'operator', note: 'rollback approved by the incident commander' })
    next += 1
  }
  return deploys.filter(deploy => deploy.minute < minutes).sort((a, b) => a.minute - b.minute || a.id.localeCompare(b.id))
}

/** The service a flag belongs to: whose logs its changes are written to. */
export function flagOwner(flag: string): Lb06Service {
  const owners: Record<Lb06Flag, Lb06Service> = { 'payment-provider-fallback': 'payment', 'inventory-prefetch': 'inventory', 'request-coalescing': 'cache', 'checkout-v2': 'web' }
  return Object.hasOwn(owners, flag) ? owners[flag as Lb06Flag] : 'web'
}

/** The default value of each of the shop's flags. */
const DEFAULT_FLAGS: Readonly<Record<Lb06Flag, boolean>> = {
  'payment-provider-fallback': false,
  'inventory-prefetch': false,
  'request-coalescing': false,
  'checkout-v2': true,
}

/**
 * The flags as they stand at `minutes` minutes: the shop's four, the one the visitor named (off,
 * never changed), the fault's own change (the leak begins when ops turn prefetching on) and every
 * flip the visitor approved.
 */
export function flagStates(scenario: Lb06Scenario, remediations: readonly Remediation[], minutes: number): FlagState[] {
  const flags = new Map<string, FlagState>()
  for (const name of LB06_FLAGS) flags.set(name, { name, value: DEFAULT_FLAGS[name], changedAt: null, by: 'default' })
  const custom = scenario.params.flag
  if (custom !== undefined && !flags.has(custom)) flags.set(custom, { name: custom, value: false, changedAt: null, by: 'default' })
  if (scenario.fault === 'memory_leak' && scenario.baselineMinutes < minutes) {
    const cure = CURING_FLAG.memory_leak
    if (cure) flags.set(cure.flag, { name: cure.flag, value: !cure.value, changedAt: scenario.baselineMinutes, by: 'ops' })
  }
  for (const remediation of remediations) {
    if (remediation.action.kind !== 'flip_flag' || remediation.minute >= minutes) continue
    flags.set(remediation.action.flag, { name: remediation.action.flag, value: remediation.action.value, changedAt: remediation.minute, by: 'operator' })
  }
  return [...flags.values()]
}

/** The service the fault strikes first, for the fault event. */
export function faultService(fault: Lb06Scenario['fault']): Lb06Service {
  return FAULT_SERVICE[fault]
}
