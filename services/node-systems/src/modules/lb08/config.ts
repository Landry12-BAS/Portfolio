// LB-08's operating settings: the numbers that decide how the engine retries, how long it
// waits and how long it keeps what a visitor made. They sit in one place so the tests can
// shorten the waits and the README can state what production does.
import { RUN_LIMITS } from '@lb/contracts'

/** How the engine behaves. Production runs `DEFAULT_CONFIG`; tests shorten the waits. */
export interface Lb08Config {
  // Attempts a step gets before it is dead-lettered, the first try included.
  maxAttempts: number
  // The wait before the first retry. Each later retry waits twice as long as the one before.
  backoffMs: number
  // How long a visitor's workflows, runs and deliveries are kept.
  retentionMs: number
  // How long a step may sit ready, queued or running before the sweep looks at it again.
  staleAfterMs: number
  // How many step jobs one worker process runs at once.
  workerConcurrency: number
  // How often the worker's sweep runs.
  sweepEveryMs: number
}

/** The settings production runs with. */
export const DEFAULT_CONFIG: Lb08Config = {
  maxAttempts: RUN_LIMITS.maxAttempts,
  backoffMs: 1_000,
  retentionMs: RUN_LIMITS.retentionHours * 3_600_000,
  staleAfterMs: 120_000,
  workerConcurrency: 5,
  sweepEveryMs: 300_000,
}

/**
 * Returns how long the queue waits after a step's `attempt`-th try fails before the next
 * one: the base wait, doubled for each try already made. BullMQ's exponential backoff uses
 * the same formula, and the run log quotes this number, so the two must agree (a
 * test checks the real timing).
 */
export function retryDelayMs(config: Lb08Config, attempt: number): number {
  return config.backoffMs * 2 ** (attempt - 1)
}
