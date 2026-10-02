// LB-04's operating settings: the numbers that decide how a review retries, how long it waits, how
// long a visitor's contract is kept, and what the extraction thread may use. They sit in one place so
// the tests can shorten the waits and the README can state what production does.
import { LB04_LIMITS } from '@lb/contracts'

import type { ExtractionLimits } from './pdf/extract.ts'

/** How the engine behaves. Production runs `DEFAULT_CONFIG`; tests shorten the waits. */
export interface Lb04Config {
  // Attempts a review gets before it is failed, the first try included.
  maxAttempts: number
  // The wait before the first retry. Each later retry waits twice as long as the one before, and never less than the gateway asked for.
  backoffMs: number
  // How long a contract, its file, its text, its report and its redlines are kept.
  keptMs: number
  // How long a contract may sit queued or in a step before the sweep looks at it again.
  staleAfterMs: number
  // How many reviews one worker process runs at once.
  workerConcurrency: number
  // How often the worker's sweep runs.
  sweepEveryMs: number
  // What the thread that opens a PDF may use.
  extraction: ExtractionLimits
}

/** The settings production runs with. */
export const DEFAULT_CONFIG: Lb04Config = {
  maxAttempts: 3,
  backoffMs: 2_000,
  keptMs: LB04_LIMITS.keptMinutes * 60_000,
  // A review waits for a model for up to the gateway's deadline for the long-document alias (180 s), and a worker that dies mid-review is found by this long without a sign of life.
  staleAfterMs: 300_000,
  workerConcurrency: 2,
  // Every minute, so a contract is deleted within a minute of its hour being up.
  sweepEveryMs: 60_000,
  extraction: { timeoutMs: 20_000, maxOldGenerationMb: 192, maxYoungGenerationMb: 32, stackMb: 4 },
}

/**
 * Returns how long the queue waits after a review's `attempt`-th try fails before the next one: the
 * base wait doubled for each try already made, or the time the gateway asked for (its Retry-After),
 * whichever is longer. BullMQ's custom backoff uses this, and a test checks the real timing.
 */
export function retryDelayMs(config: Lb04Config, attempt: number, retryAfterSeconds?: number): number {
  const exponential = config.backoffMs * 2 ** (attempt - 1)
  return Math.max(exponential, (retryAfterSeconds ?? 0) * 1_000)
}
