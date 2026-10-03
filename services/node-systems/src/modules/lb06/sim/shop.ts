// The simulated shop: six services, what each depends on, how each behaves on a calm day, and the
// limits the faults push them against. Everything here is a constant; the faults (faults.ts) and the
// world builder (world.ts) read it and never change it.
import { LB06_SERVICES } from '@lb/contracts'
import type { Lb06Service } from '@lb/contracts'

/** What a service looks like on a calm minute. Rates are per second, latencies in milliseconds, saturation from 0 to 1, memory in MB. */
export interface Baseline {
  requestRate: number
  errorRate: number
  latencyP50: number
  latencyP95: number
  latencyP99: number
  saturation: number
  memoryMb: number
  // Where the service's memory limit lies: past it the process is killed and restarted.
  memoryLimitMb: number
  // How many replicas serve it.
  replicas: number
}

/** The calm-day behaviour of each service. */
export const BASELINES: Readonly<Record<Lb06Service, Baseline>> = {
  web: { requestRate: 120, errorRate: 0.002, latencyP50: 90, latencyP95: 260, latencyP99: 520, saturation: 0.35, memoryMb: 512, memoryLimitMb: 1_024, replicas: 3 },
  cart: { requestRate: 80, errorRate: 0.003, latencyP50: 60, latencyP95: 180, latencyP99: 350, saturation: 0.4, memoryMb: 640, memoryLimitMb: 1_024, replicas: 3 },
  payment: { requestRate: 25, errorRate: 0.004, latencyP50: 240, latencyP95: 480, latencyP99: 900, saturation: 0.25, memoryMb: 380, memoryLimitMb: 768, replicas: 2 },
  inventory: { requestRate: 70, errorRate: 0.002, latencyP50: 40, latencyP95: 120, latencyP99: 220, saturation: 0.3, memoryMb: 400, memoryLimitMb: 1_024, replicas: 2 },
  database: { requestRate: 300, errorRate: 0.001, latencyP50: 4, latencyP95: 18, latencyP99: 45, saturation: 0.35, memoryMb: 2_048, memoryLimitMb: 4_096, replicas: 1 },
  cache: { requestRate: 500, errorRate: 0.0005, latencyP50: 1, latencyP95: 3, latencyP99: 6, saturation: 0.2, memoryMb: 1_024, memoryLimitMb: 2_048, replicas: 1 },
}

/** Which services each one calls. The edge is `web`; the data is `database` and `cache`. */
export const DEPENDENCIES: Readonly<Record<Lb06Service, readonly Lb06Service[]>> = {
  web: ['cart'],
  cart: ['payment', 'inventory', 'cache'],
  payment: [],
  inventory: ['database'],
  database: [],
  cache: ['database'],
}

/** How deep a service sits behind the edge: 0 for web, more for the services it calls. Used to say which service is nearest the cause. */
export function depthOf(service: Lb06Service): number {
  const depths: Record<Lb06Service, number> = { web: 0, cart: 1, payment: 2, inventory: 2, cache: 2, database: 3 }
  return depths[service]
}

/** The versions each service runs at the start of an incident. */
export const RUNNING_VERSIONS: Readonly<Record<Lb06Service, string>> = {
  web: '5.3.1',
  cart: '2.13.4',
  payment: '3.0.2',
  inventory: '1.9.0',
  database: '16.2',
  cache: '7.2',
}

/** The share of good requests the shop promises its users over a month: the SLO the alerts burn against. */
export const SLO_TARGET = 0.995
/** Requests slower than this count as bad for the SLO, in milliseconds. */
export const SLO_LATENCY_MS = 600

/** The services in dependency order. */
export const SERVICES = LB06_SERVICES
