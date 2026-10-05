// Which of LB-07's own notices a failed call gets. The kit sorts a failure into a coarse kind by its
// status alone, and has a notice for each kind; this board has failures that mean more than their status
// says (every 503 is "unavailable" to the kit, but "the browser is busy with other visitors' runs" and "the
// model is out of reach" are different news, and a 404 for a run is a run that is gone, not a page that
// was never there), so it looks at the failure's code first. The words themselves are in the locale files.
import type { ApiProblem } from '~/board-kit/problem'

/** The board's own notices: the browser is busy, the run could not be queued, the model is out of reach, the run is gone. */
export type OwnNotice = 'busy' | 'queue' | 'model' | 'gone'

/** Picks the board's own notice for a failure, or nothing when the kit's notice for the failure's kind says it right. The code decides, never the status alone. */
export function ownNoticeOf(problem: ApiProblem): OwnNotice | undefined {
  switch (problem.code) {
    case 'busy': return 'busy'
    case 'queue_unavailable': return 'queue'
    case 'planning_unavailable': return 'model'
    case 'run_not_found': return 'gone'
    default: return undefined
  }
}
