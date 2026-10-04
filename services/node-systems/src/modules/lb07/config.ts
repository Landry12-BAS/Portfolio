// LB-07's operating settings: how a run retries, how long it waits, how long a visitor's run is kept,
// and how the engine paces itself. They sit in one place so the tests can shorten the waits and the
// README can state what production does.
import { LB07_LIMITS } from '@lb/contracts'

/** How the engine behaves. Production runs `DEFAULT_CONFIG`; tests shorten the waits. */
export interface Lb07Config {
  // Attempts a run gets before it is failed, the first try included. A browser pass that was cut short is run again from its plan.
  maxAttempts: number
  // The wait before a retry, doubled each time, and never less than the gateway asked for.
  backoffMs: number
  // How long a run and everything that belongs to it is kept.
  keptMs: number
  // How long a run may sit in a state without a sign of life before the sweep queues it again.
  staleAfterMs: number
  // How often the sweep runs.
  sweepEveryMs: number
  // The wall clock of a whole run's browser time.
  runTimeMs: number
  // How many runs may be queued or running before a new one is told the system is busy.
  maxQueued: number
  // How long the worker waits for the browser when another run holds it, and how many times.
  busyWaitMs: number
  busyWaits: number
}

/** The settings production runs with. */
export const DEFAULT_CONFIG: Lb07Config = {
  maxAttempts: 2,
  backoffMs: 5_000,
  keptMs: LB07_LIMITS.keptMinutes * 60_000,
  // A run is three minutes of browser time at most, plus the model's waits: a run silent for this long has lost its worker.
  staleAfterMs: 420_000,
  sweepEveryMs: 60_000,
  runTimeMs: LB07_LIMITS.runTimeMs,
  maxQueued: LB07_LIMITS.maxQueued,
  busyWaitMs: 2_000,
  busyWaits: 90,
}

/** How long the queue waits after a run's `attempt`-th try fails before the next: the base wait doubled for each try made, or the gateway's Retry-After, whichever is longer. */
export function retryDelayMs(config: Lb07Config, attempt: number, retryAfterSeconds?: number): number {
  const exponential = config.backoffMs * 2 ** (attempt - 1)
  return Math.max(exponential, (retryAfterSeconds ?? 0) * 1_000)
}
