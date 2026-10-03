// LB-06's operating settings: how fast the simulated clock runs, how long an incident may live,
// how the worker paces and recovers its jobs, and how long an incident is kept. They sit in one
// place so the tests can shorten the waits and the README can state what production does.
import { LB06_LIMITS } from '@lb/contracts'

/** How the engine behaves. Production runs `DEFAULT_CONFIG`; tests shorten the waits. */
export interface Lb06Config {
  // Wall-clock milliseconds between two simulated minutes.
  tickMs: number
  // The most wall-clock milliseconds an incident may live before it is ended as timed out.
  maxWallMs: number
  // Simulated minutes the shop ticks after the alert before the agents look at it, so the summary shows the shape of the fault.
  investigationDelayMinutes: number
  // Simulated minutes a remediation is given to bring the SLO back before the agents propose again.
  verifyMinutes: number
  // How long an incident, its log and its postmortem are kept.
  keptMs: number
  // How long a running incident may go without a tick before the sweep queues it again.
  staleAfterMs: number
  // How many incidents one worker process runs at once: the global cap, which a running simulation's CPU bounds.
  workerConcurrency: number
  // How often the worker's sweep runs.
  sweepEveryMs: number
  // How often a WebSocket is pinged, and how long one may stay silent, in milliseconds.
  socketPingMs: number
  socketIdleMs: number
  // How long a new connection has to say hello.
  socketHelloMs: number
}

/** The settings production runs with. */
export const DEFAULT_CONFIG: Lb06Config = {
  tickMs: LB06_LIMITS.tickMs,
  maxWallMs: LB06_LIMITS.maxWallMs,
  investigationDelayMinutes: 2,
  verifyMinutes: 12,
  keptMs: LB06_LIMITS.keptHours * 3_600_000,
  // A tick comes every two seconds; a minute without one means the worker is gone.
  staleAfterMs: 60_000,
  workerConcurrency: LB06_LIMITS.maxConcurrentIncidents,
  sweepEveryMs: 60_000,
  socketPingMs: 30_000,
  socketIdleMs: 15 * 60_000,
  socketHelloMs: 10_000,
}

/** The version of the prompts, part of the cache key: a prompt change makes every cached investigation stale. */
export const PROMPT_VERSION = 1
