// Which view of a run the board takes, written as a plain function so the rule can be tested alone. The board reads a
// run one question at a time, but answers can still come late: a read held up by a slow network, a run opened again
// while an older read of it was out. So every read is numbered, and the board takes a view only when it is of the run
// on the board, is not older than the newest view it has taken, and does not turn a run that has ended back into one
// that is still going (the service never does that, so such a view can only be a stale one).
import type { Lb10Run } from './schemas'

/** Tells whether a run has ended. */
export function isOver(state: Lb10Run['state']): boolean {
  return state === 'done' || state === 'failed'
}

/**
 * Tells whether the board takes a view of the run: `read` is the number of the read that brought it (none for an
 * answer that is not a read, such as the run being started), and `newestShown` the number of the newest read taken.
 */
export function takesView(current: Lb10Run | undefined, view: Lb10Run, read: number | undefined, newestShown: number): boolean {
  if (current !== undefined && current.run_id !== view.run_id) return false
  if (read !== undefined && read < newestShown) return false
  return !(current !== undefined && isOver(current.state) && !isOver(view.state))
}
