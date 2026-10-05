// How the board paces its questions about a run, so following one is never a storm of requests: one question at
// a time, the next only after the answer to the last; quickly while the run moves (a run is ten to forty model
// calls, four at a time, so most end within half a minute), slowly once it has gone on for a while; and none at
// all once the run has ended or the visitor has left. The service ends every run on its own: one past its
// deadline is ended as `time_limit`, and one whose worker died is ended as `interrupted` by the first read a
// minute past the deadline, so the board's patience is that and a little more.

/** How long the board waits before it first asks where a run stands: it has only just been handed to the runner. */
export const FIRST_POLL_MS = 500
/** How often it asks while the run moves. */
export const POLL_MS = 1_000
/** How often it asks once the run has gone on for a while, so a slow one costs the site little. */
export const SLOW_POLL_MS = 3_000
/** How many questions are asked at the quick pace before the slow one: about a minute. */
export const QUICK_POLLS = 60
/** The service's deadline for a run, and the minute after it at which a read ends a run a dead worker left. */
export const RUN_DEADLINE_MS = 300_000
export const STALE_AFTER_MS = RUN_DEADLINE_MS + 60_000
/** How long the board follows a run before it stops asking and says so: past the moment the service ends any run. */
export const RUN_PATIENCE_MS = STALE_AFTER_MS + 60_000
/** When the board says a run is slower than usual. */
export const SLOW_AFTER_MS = 60_000
/** A run's trace appears a moment after it starts, so "no trace yet" is not an error for this long. */
export const SCOPE_GRACE_MS = 8_000
/** How long a Scope that had stopped looking for the trace looks again after the run ends: the root span is written as it ends. */
export const SCOPE_END_GRACE_MS = 6_000
/** Reads of a run that fail for a passing reason are tried again this many times in a row before the board gives up. */
export const READ_FAILURES_ALLOWED = 3

/** Waits for the next question about a run: quick at first, slow once it has gone on for a while. */
export function pollDelay(polls: number): number {
  if (polls === 0) return FIRST_POLL_MS
  return polls < QUICK_POLLS ? POLL_MS : SLOW_POLL_MS
}
