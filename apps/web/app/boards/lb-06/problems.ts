// Which of LB-06's own notices a failed call gets. The kit sorts a failure into a coarse kind by its
// status alone, and has a notice for each kind; this board has failures that mean more than their
// status says (every 503 is "unavailable" to the kit, but "the demo is running as many incidents as
// it can" and "the models are out of reach" are different news), so it looks at the failure's code
// first. The words themselves are in the locale files.
import type { ApiProblem } from '~/board-kit/problem'

/** The board's own notices: the demo is full, the agents' models are out of reach, the incident could not be queued, it has ended already, or the proposal was answered already. */
export type OwnNotice = 'busy' | 'agents' | 'queue' | 'ended' | 'settled'

/** Picks the board's own notice for a failure, or nothing when the kit's notice for the failure's kind says it right. The code decides, never the status alone. */
export function ownNoticeOf(problem: ApiProblem): OwnNotice | undefined {
  switch (problem.code) {
    case 'too_many_incidents': return 'busy'
    case 'agents_unavailable': return 'agents'
    case 'queue_unavailable': return 'queue'
    case 'incident_ended':
    case 'log_full':
      return 'ended'
    case 'proposal_settled': return 'settled'
    default: return undefined
  }
}
