// Which of LB-08's own notices a failed call gets. The kit sorts a failure into a coarse kind by its
// status alone, and has a notice for each kind; this board has four failures that mean more than their
// status says, so it looks at the failure's code first. The words themselves are in the locale files.
import type { ApiProblem } from '~/board-kit/problem'

/**
 * The board's own notices: a described process the checks refused, the model being out of reach
 * for a description, the visitor already keeping as many workflows as are allowed, and a request
 * that no longer fits the state of a run.
 */
export type OwnNotice = 'refused' | 'generation' | 'tooMany' | 'conflict'

/**
 * Picks the board's own notice for a failure, or nothing when the kit's notice for the failure's kind
 * says it right. The code decides, never the status alone. The kit calls every 503 "unavailable": this
 * deployment has no back end, or it is down, and recorded samples are all there is. But the service's
 * 503 with the code `generation_unavailable` means that the model is out of reach (its free quota is
 * spent, or a provider is down) while the samples and the runs keep working, and that needs its own
 * words, which say so. The service answers 503 for it because that is the one "try later" status the
 * site's server passes on with its body: a 502 or 504 would lose the code on the way.
 */
export function ownNoticeOf(problem: ApiProblem): OwnNotice | undefined {
  if (problem.code === 'workflow_rejected' && problem.problems.length > 0) return 'refused'
  if (problem.code === 'generation_unavailable') return 'generation'
  if (problem.code === 'workflow_limit') return 'tooMany'
  if (problem.kind === 'conflict') return 'conflict'
  return undefined
}
