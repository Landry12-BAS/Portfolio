// How the board paces its questions about a run, so following one is never a storm of requests: one
// question at a time, the next only after the answer to the last; quickly while the run moves, slowly
// while it waits in the queue for other visitors' runs (which can take minutes) and once it has gone on for
// a while; and none at all once the run has ended or the visitor has left. The numbers the service enforces
// (the run's time, the queue) are the contracts package's, so the board states no limit the service does not.
import { LB07_LIMITS } from '@lb/contracts'
import type { Lb07State } from '@lb/contracts'

/** How long the board waits before it first asks where a run stands: it has only just been queued. */
export const FIRST_POLL_MS = 400
/** How often it asks while the run moves: a step takes about a second in the browser. */
export const POLL_MS = 900
/** How often it asks while the run waits for the browser, which other visitors' runs hold for up to three minutes each. */
export const QUEUED_POLL_MS = 2_500
/** How often it asks once the run has gone on for a while, so a slow one costs the site little. */
export const SLOW_POLL_MS = 3_000
/** How many questions are asked at the quick pace before the slow one. */
export const QUICK_POLLS = 120
/**
 * How long the board follows a run before it stops waiting and says so: a full queue of runs ahead, each
 * with its three minutes of browser time and its model calls, and the run itself. The service ends every
 * run on its own; the board only stops asking.
 */
export const RUN_PATIENCE_MS = (LB07_LIMITS.maxQueued + 1) * (LB07_LIMITS.runTimeMs + 60_000)
/** When the board says a run is slower than usual: after the browser time of one run and a little. */
export const SLOW_AFTER_MS = LB07_LIMITS.runTimeMs + 60_000
/** A run's trace appears a moment after it starts, so "no trace yet" is not an error for this long. */
export const SCOPE_GRACE_MS = 8_000
/** How long a Scope that had stopped looking for the trace looks again after the run ends: the root span is written as it ends. */
export const SCOPE_END_GRACE_MS = 6_000
/** Reads of a run that fail for another reason are tried again this many times in a row before the board gives up. */
export const READ_FAILURES_ALLOWED = 3

/** Waits for the next question about a run: quick at first, slow while other runs are ahead of it in the queue or once it has run for a while. */
export function pollDelay(run: { state: Lb07State, queuePosition: number | null }, polls: number): number {
  if (polls === 0) return FIRST_POLL_MS
  if (run.state === 'queued' && (run.queuePosition ?? 0) > 0) return QUEUED_POLL_MS
  return polls < QUICK_POLLS ? POLL_MS : SLOW_POLL_MS
}
